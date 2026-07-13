import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { ArtifactKindSchema, type ArtifactKind } from "./protocol.js";

export type ArtifactData = string | Uint8Array;

export interface ArtifactWriteInput {
  taskId: string;
  runId: string;
  kind: ArtifactKind;
  name: string;
  data: ArtifactData;
}

export interface ArtifactMetadata {
  taskId: string;
  runId: string;
  kind: ArtifactKind;
  name: string;
  path: string;
  relativePath: string;
  metadataPath: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ArtifactStoreOptions {
  home?: string;
}

export interface ArtifactIntegrityInput {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ArtifactIntegrityResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMMUTABLE_FILE_MODE = 0o400;

export class ArtifactConflictError extends Error {
  readonly path: string;

  constructor(pathInput: string, message: string) {
    super(message);
    this.name = "ArtifactConflictError";
    this.path = pathInput;
  }
}

/** Resolve ACC_HOME once so all persisted paths are absolute and unambiguous. */
export function resolveAccHome(home = process.env.ACC_HOME ?? ".acc"): string {
  return path.resolve(home);
}

/**
 * IDs and filenames become path components. Rejecting rather than sanitizing
 * avoids both traversal and two distinct IDs silently mapping to one directory.
 */
export function assertSafePathSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(
      `${label} must contain only letters, numbers, dot, underscore, or dash`,
    );
  }
  return value;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Artifact path escapes its storage root: ${candidate}`);
  }
}

function asBuffer(data: ArtifactData): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function readRegularFile(filePath: string): Promise<Buffer> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ArtifactConflictError(
      filePath,
      `Artifact evidence must be a regular file: ${filePath}`,
    );
  }
  return await readFile(filePath);
}

/**
 * Install a fully-written same-directory temporary file without replacing an
 * existing destination. Hard-link creation is atomic and fails with EEXIST,
 * unlike rename(), which replaces evidence on POSIX.
 */
async function installExclusiveFile(
  destination: string,
  data: ArtifactData,
): Promise<"created" | "exists"> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      if (process.platform !== "win32") {
        await chmod(destination, IMMUTABLE_FILE_MODE);
      }
      return "created";
    } catch (error) {
      if (isErrno(error, "EEXIST")) return "exists";
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Atomically create immutable evidence. An identical retry is safe; a retry
 * with different bytes fails without changing the original file.
 */
export async function atomicWriteFile(
  destination: string,
  data: ArtifactData,
): Promise<void> {
  const expected = asBuffer(data);
  const installed = await installExclusiveFile(destination, expected);
  if (installed === "created") return;

  const existing = await readRegularFile(destination);
  if (!existing.equals(expected)) {
    throw new ArtifactConflictError(
      destination,
      `Artifact bytes must be identical for immutable path: ${destination}`,
    );
  }
  if (process.platform !== "win32") {
    await chmod(destination, IMMUTABLE_FILE_MODE);
  }
}

function parseMetadata(metadataPath: string, text: string): ArtifactMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ArtifactConflictError(
      metadataPath,
      `Artifact metadata must be valid JSON: ${metadataPath}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArtifactConflictError(
      metadataPath,
      `Artifact metadata must be an object: ${metadataPath}`,
    );
  }
  const value = parsed as Record<string, unknown>;
  const kind = ArtifactKindSchema.safeParse(value.kind);
  if (
    typeof value.taskId !== "string" ||
    typeof value.runId !== "string" ||
    !kind.success ||
    typeof value.name !== "string" ||
    typeof value.path !== "string" ||
    typeof value.relativePath !== "string" ||
    typeof value.metadataPath !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new ArtifactConflictError(
      metadataPath,
      `Artifact metadata must contain a valid immutable evidence record: ${metadataPath}`,
    );
  }
  return {
    taskId: value.taskId,
    runId: value.runId,
    kind: kind.data,
    name: value.name,
    path: value.path,
    relativePath: value.relativePath,
    metadataPath: value.metadataPath,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes as number,
    createdAt: value.createdAt,
  };
}

function assertMetadataMatches(
  actual: ArtifactMetadata,
  expected: Omit<ArtifactMetadata, "createdAt">,
): void {
  for (const key of [
    "taskId",
    "runId",
    "kind",
    "name",
    "path",
    "relativePath",
    "metadataPath",
    "sha256",
    "sizeBytes",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new ArtifactConflictError(
        expected.metadataPath,
        `Artifact metadata must be identical for immutable path: ${expected.path}`,
      );
    }
  }
}

async function readStoredMetadata(
  metadataPath: string,
): Promise<ArtifactMetadata> {
  return parseMetadata(
    metadataPath,
    (await readRegularFile(metadataPath)).toString("utf8"),
  );
}

export class ArtifactStore {
  readonly home: string;
  readonly root: string;

  constructor(options: ArtifactStoreOptions = {}) {
    this.home = resolveAccHome(options.home);
    this.root = path.join(this.home, "artifacts");
  }

  /** Prepare a contained directory that an adapter may write into directly. */
  async prepareRunDirectory(taskIdInput: string, runIdInput: string): Promise<string> {
    const taskId = assertSafePathSegment(taskIdInput, "taskId");
    const runId = assertSafePathSegment(runIdInput, "runId");
    const root = await this.ensureRoot();
    const requestedDirectory = path.join(root, taskId, runId);
    await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
    const directory = await realpath(requestedDirectory);
    assertContained(root, directory);
    return directory;
  }

  async write(input: ArtifactWriteInput): Promise<ArtifactMetadata> {
    const taskId = assertSafePathSegment(input.taskId, "taskId");
    const runId = assertSafePathSegment(input.runId, "runId");
    const name = assertSafePathSegment(input.name, "artifact name");
    const kind = ArtifactKindSchema.parse(input.kind);
    const directory = await this.prepareRunDirectory(taskId, runId);
    const realHome = await realpath(this.home);
    const realRoot = await realpath(this.root);
    const destination = path.join(directory, name);
    assertContained(realRoot, destination);

    const bytes = asBuffer(input.data);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadataPath = `${destination}.metadata.json`;
    const immutableMetadata = {
      taskId,
      runId,
      kind,
      name,
      path: destination,
      relativePath: path.relative(realHome, destination),
      metadataPath,
      sha256,
      sizeBytes: bytes.byteLength,
    } satisfies Omit<ArtifactMetadata, "createdAt">;

    // A complete prior write is the normal idempotent retry path. Validate the
    // sidecar first so an orphaned/mismatched record can never be "repaired" by
    // replacing evidence bytes.
    let priorMetadata: ArtifactMetadata | null = null;
    try {
      priorMetadata = await readStoredMetadata(metadataPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (priorMetadata) {
      assertMetadataMatches(priorMetadata, immutableMetadata);
      const existing = await readRegularFile(destination);
      if (!existing.equals(bytes)) {
        throw new ArtifactConflictError(
          destination,
          `Artifact bytes must be identical for immutable path: ${destination}`,
        );
      }
      return priorMetadata;
    }

    await atomicWriteFile(destination, bytes);

    const metadata: ArtifactMetadata = {
      ...immutableMetadata,
      createdAt: new Date().toISOString(),
    };
    const metadataState = await installExclusiveFile(
      metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    if (metadataState === "created") return metadata;

    // Concurrent identical writers may generate different createdAt values.
    // Preserve and return whichever complete sidecar won the exclusive link.
    const winner = await readStoredMetadata(metadataPath);
    assertMetadataMatches(winner, immutableMetadata);
    return winner;
  }

  async writeText(
    input: Omit<ArtifactWriteInput, "data"> & { data: string },
  ): Promise<ArtifactMetadata> {
    return await this.write(input);
  }

  async writeJson(
    input: Omit<ArtifactWriteInput, "data"> & { data: unknown },
  ): Promise<ArtifactMetadata> {
    return await this.write({
      ...input,
      data: `${JSON.stringify(input.data, null, 2)}\n`,
    });
  }

  async readMetadata(metadataPath: string): Promise<ArtifactMetadata> {
    const root = await this.ensureRoot();
    const resolved = path.resolve(metadataPath);
    assertContained(root, resolved);
    const parsed = await readStoredMetadata(resolved);
    if (parsed.metadataPath !== resolved) {
      throw new ArtifactConflictError(
        resolved,
        `Artifact metadata path must be identical to its immutable location: ${resolved}`,
      );
    }
    assertContained(root, parsed.path);
    return parsed;
  }

  async ensureRoot(): Promise<string> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const realHome = await realpath(this.home);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const realRoot = await realpath(this.root);
    assertContained(realHome, realRoot);
    return realRoot;
  }
}

/** Re-read immutable evidence and verify containment, type, size, and digest. */
export async function verifyArtifactEvidence(
  artifactRoot: string,
  artifact: ArtifactIntegrityInput,
): Promise<ArtifactIntegrityResult> {
  if (!SHA256.test(artifact.sha256)) {
    throw new Error("Artifact record contains an invalid SHA-256 digest");
  }
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
    throw new Error("Artifact record contains an invalid byte size");
  }
  const root = await realpath(artifactRoot);
  const info = await lstat(artifact.path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ArtifactConflictError(
      artifact.path,
      `Artifact evidence must be a regular file: ${artifact.path}`,
    );
  }
  const storedPath = await realpath(artifact.path);
  assertContained(root, storedPath);
  const bytes = await readFile(storedPath);
  if (bytes.byteLength !== artifact.sizeBytes) {
    throw new ArtifactConflictError(
      storedPath,
      `Artifact size does not match its immutable record: ${storedPath}`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new ArtifactConflictError(
      storedPath,
      `Artifact digest does not match its immutable record: ${storedPath}`,
    );
  }
  return { path: storedPath, sha256: digest, sizeBytes: bytes.byteLength };
}

export async function writeArtifact(
  input: ArtifactWriteInput,
  options: ArtifactStoreOptions = {},
): Promise<ArtifactMetadata> {
  return await new ArtifactStore(options).write(input);
}
