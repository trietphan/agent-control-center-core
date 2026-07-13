import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rm,
} from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import { join, resolve } from "node:path";

export const DAEMON_LEASE_FILENAME = "daemon.lock";
export const DAEMON_BEARER_TOKEN_FILENAME = "daemon.token";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const TOKEN_BYTES = 32;
const MAX_ACQUIRE_ATTEMPTS = 16;

export interface DaemonLeaseRecord {
  version: 1;
  pid: number;
  instanceToken: string;
  acquiredAt: string;
}

export interface DaemonLease {
  readonly path: string;
  readonly record: DaemonLeaseRecord;
  /** Stale daemon record removed while acquiring this lease, if any. */
  readonly reclaimed: DaemonLeaseRecord | null;
  release(): Promise<void>;
}

export interface AcquireDaemonLeaseOptions {
  home: string;
  pid?: number;
  instanceToken?: string;
  now?: () => Date;
}

export interface DaemonBearerToken {
  path: string;
  token: string;
}

export class DaemonLeaseHeldError extends Error {
  readonly record: DaemonLeaseRecord;

  constructor(record: DaemonLeaseRecord) {
    super(`Agent Control Center daemon is already running as PID ${record.pid}`);
    this.name = "DaemonLeaseHeldError";
    this.record = record;
  }
}

export class DaemonLeaseOwnershipError extends Error {
  constructor(path: string) {
    super(`Daemon lease ownership changed before release: ${path}`);
    this.name = "DaemonLeaseOwnershipError";
  }
}

function secureRandomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

async function ensurePrivateHome(home: string): Promise<string> {
  const absolute = resolve(home);
  await mkdir(absolute, { recursive: true, mode: DIRECTORY_MODE });
  if (process.platform !== "win32") await chmod(absolute, DIRECTORY_MODE);
  return absolute;
}

function assertPrivateRegularFile(
  path: string,
  info: Stats,
): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Secure daemon file must be a regular file: ${path}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o777) !== FILE_MODE) {
    throw new Error(`Secure daemon file must have mode 0600: ${path}`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    info.uid !== process.getuid()
  ) {
    throw new Error(`Secure daemon file is not owned by the current user: ${path}`);
  }
}

async function readSecureText(path: string): Promise<string> {
  // O_NOFOLLOW prevents swapping an existing token/lease for a symlink before
  // it is opened. It is zero on platforms that do not expose this flag.
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    assertPrivateRegularFile(path, info);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseLeaseRecord(path: string, text: string): DaemonLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Daemon lease is not valid JSON: ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Daemon lease has an invalid record: ${path}`);
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 1 ||
    typeof value.instanceToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.instanceToken) ||
    typeof value.acquiredAt !== "string" ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    throw new Error(`Daemon lease has an invalid record: ${path}`);
  }
  return {
    version: 1,
    pid: value.pid as number,
    instanceToken: value.instanceToken,
    acquiredAt: value.acquiredAt,
  };
}

async function readLeaseRecord(path: string): Promise<DaemonLeaseRecord> {
  return parseLeaseRecord(path, await readSecureText(path));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    FILE_MODE,
  );
  let completed = false;
  try {
    if (process.platform !== "win32") await handle.chmod(FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await rm(path, { force: true }).catch(() => undefined);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/** Acquire the single-daemon lease for an ACC_HOME directory. */
export async function acquireDaemonLease(
  input: string | AcquireDaemonLeaseOptions,
): Promise<DaemonLease> {
  const options = typeof input === "string" ? { home: input } : input;
  const home = await ensurePrivateHome(options.home);
  const path = join(home, DAEMON_LEASE_FILENAME);
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Daemon lease PID must be a safe integer greater than 1");
  }
  const instanceToken = options.instanceToken ?? secureRandomToken();
  if (!/^[A-Za-z0-9_-]{43}$/.test(instanceToken)) {
    throw new Error("Daemon lease instance token must contain 256 bits of base64url data");
  }
  const record: DaemonLeaseRecord = {
    version: 1,
    pid,
    instanceToken,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  let reclaimed: DaemonLeaseRecord | null = null;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await writeExclusive(path, `${JSON.stringify(record)}\n`);
      let released = false;
      return {
        path,
        record,
        reclaimed,
        async release(): Promise<void> {
          if (released) return;
          let current: DaemonLeaseRecord;
          try {
            current = await readLeaseRecord(path);
          } catch (error) {
            if (isErrno(error, "ENOENT")) {
              released = true;
              return;
            }
            throw error;
          }
          if (
            current.pid !== record.pid ||
            !secureTokenEquals(record.instanceToken, current.instanceToken)
          ) {
            throw new DaemonLeaseOwnershipError(path);
          }
          await rm(path);
          released = true;
        },
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    const observed = await readLeaseRecord(path);
    if (processIsAlive(observed.pid)) throw new DaemonLeaseHeldError(observed);

    // Re-read immediately before unlinking. This prevents concurrent stale
    // reclaimers from deleting a newly acquired lease in normal scheduling.
    const current = await readLeaseRecord(path);
    if (
      current.pid !== observed.pid ||
      !secureTokenEquals(current.instanceToken, observed.instanceToken)
    ) {
      continue;
    }
    await rm(path).catch((error) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
    reclaimed = observed;
  }

  throw new Error("Could not acquire daemon lease after concurrent stale reclamation");
}

function parseBearerToken(path: string, text: string): string {
  const token = text.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error(`Daemon bearer token is not 256-bit base64url data: ${path}`);
  }
  const decoded = Buffer.from(token, "base64url");
  if (decoded.byteLength !== TOKEN_BYTES) {
    throw new Error(`Daemon bearer token is not 256-bit base64url data: ${path}`);
  }
  return token;
}

/** Atomically create or securely read the persistent local daemon bearer token. */
export async function loadOrCreateBearerToken(homeInput: string): Promise<DaemonBearerToken> {
  const home = await ensurePrivateHome(homeInput);
  const path = join(home, DAEMON_BEARER_TOKEN_FILENAME);
  const generated = secureRandomToken();
  try {
    await writeExclusive(path, `${generated}\n`);
    return { path, token: generated };
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  return { path, token: parseBearerToken(path, await readSecureText(path)) };
}

/** Securely read an existing daemon token without creating or replacing it. */
export async function loadBearerTokenFile(pathInput: string): Promise<DaemonBearerToken> {
  const path = resolve(pathInput);
  return { path, token: parseBearerToken(path, await readSecureText(path)) };
}

/** Constant-time comparison for arbitrary token strings. */
export function secureTokenEquals(expected: string, candidate: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

/** Validate an HTTP Authorization header without leaking token comparison timing. */
export function bearerTokenMatches(
  expectedToken: string,
  authorization: string | null | undefined,
): boolean {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/i);
  const candidate = match?.[1] ?? "";
  const equal = secureTokenEquals(expectedToken, candidate);
  return Boolean(match) && equal;
}
