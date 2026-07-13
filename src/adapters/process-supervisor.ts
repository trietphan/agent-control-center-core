import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";

import { CONTROL_RUN_TOKEN_ENV, type AdapterTerminalStatus } from "./types.js";
import { AdapterRunNotFoundError } from "./types.js";

export interface ProcessSpec {
  id?: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  closeStdin?: boolean;
  stdoutPath: string;
  stderrPath: string;
  /** Per-run override. Set to 0 to disable the wall-clock timeout. */
  timeoutMs?: number;
  /** Per-run shorthand that applies to both output streams. */
  maxOutputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface SupervisedRun {
  id: string;
  status: "running";
  pid: number | null;
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface SupervisedResult {
  id: string;
  status: AdapterTerminalStatus;
  pid: number | null;
  startedAt: string;
  finishedAt: string;
  stdoutPath: string;
  stderrPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}

export interface ProcessSupervisorOptions {
  killGraceMs?: number;
  /** Default wall-clock limit for every process. Set to 0 to disable. */
  timeoutMs?: number;
  /** Shorthand default applied to stdout and stderr. */
  maxOutputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

type OutputKind = "stdout" | "stderr";

interface InternalRun {
  id: string;
  pid: number | null;
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
  child: ReturnType<typeof spawn>;
  stdoutStream: WriteStream;
  stderrStream: WriteStream;
  stopRequested: boolean;
  finalizing: boolean;
  result: SupervisedResult | null;
  completion: Promise<SupervisedResult>;
  resolveCompletion: (result: SupervisedResult) => void;
  killTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  terminationCompletion: Promise<void> | null;
  resolveTermination: (() => void) | null;
  terminationResolved: boolean;
  processError: Error | null;
  failureReason: string | null;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
}

function validateNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve();
      return;
    }

    stream.once("close", resolve);
    if (!stream.writableEnded) stream.end();
  });
}

export class ProcessSupervisor {
  readonly #killGraceMs: number;
  readonly #timeoutMs: number;
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;
  readonly #runs = new Map<string, InternalRun>();

  constructor(options: ProcessSupervisorOptions = {}) {
    this.#killGraceMs = validateNonnegativeInteger(
      options.killGraceMs ?? 2_000,
      "killGraceMs",
    );
    this.#timeoutMs = validateNonnegativeInteger(
      options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      "timeoutMs",
    );
    const sharedLimit = validateNonnegativeInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.#maxStdoutBytes = validateNonnegativeInteger(
      options.maxStdoutBytes ?? sharedLimit,
      "maxStdoutBytes",
    );
    this.#maxStderrBytes = validateNonnegativeInteger(
      options.maxStderrBytes ?? sharedLimit,
      "maxStderrBytes",
    );
  }

  async start(spec: ProcessSpec): Promise<SupervisedRun> {
    const id = spec.id ?? `run_${randomUUID()}`;
    if (this.#runs.has(id)) {
      throw new Error(`A process run already exists with id ${id}`);
    }

    await Promise.all([
      mkdir(dirname(spec.stdoutPath), { recursive: true }),
      mkdir(dirname(spec.stderrPath), { recursive: true }),
    ]);

    const specSharedLimit =
      spec.maxOutputBytes === undefined
        ? undefined
        : validateNonnegativeInteger(spec.maxOutputBytes, "maxOutputBytes");
    const timeoutMs = validateNonnegativeInteger(
      spec.timeoutMs ?? this.#timeoutMs,
      "timeoutMs",
    );
    const maxStdoutBytes = validateNonnegativeInteger(
      spec.maxStdoutBytes ?? specSharedLimit ?? this.#maxStdoutBytes,
      "maxStdoutBytes",
    );
    const maxStderrBytes = validateNonnegativeInteger(
      spec.maxStderrBytes ?? specSharedLimit ?? this.#maxStderrBytes,
      "maxStderrBytes",
    );

    const stdoutStream = createWriteStream(spec.stdoutPath, { flags: "w" });
    const stderrStream = createWriteStream(spec.stderrPath, { flags: "w" });

    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      shell: false,
      // On POSIX this makes the child the leader of a dedicated process group,
      // allowing stop/timeout to terminate every process the agent launched.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolveCompletion!: (result: SupervisedResult) => void;
    const completion = new Promise<SupervisedResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const state: InternalRun = {
      id,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      stdoutPath: spec.stdoutPath,
      stderrPath: spec.stderrPath,
      child,
      stdoutStream,
      stderrStream,
      stopRequested: false,
      finalizing: false,
      result: null,
      completion,
      resolveCompletion,
      killTimer: null,
      timeoutTimer: null,
      terminationCompletion: null,
      resolveTermination: null,
      terminationResolved: false,
      processError: null,
      failureReason: null,
      timeoutMs,
      maxStdoutBytes,
      maxStderrBytes,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
    this.#runs.set(id, state);

    stdoutStream.on("error", (error) => {
      this.#fail(
        state,
        `Failed to write stdout artifact ${state.stdoutPath}: ${error.message}`,
      );
    });
    stderrStream.on("error", (error) => {
      this.#fail(
        state,
        `Failed to write stderr artifact ${state.stderrPath}: ${error.message}`,
      );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.#captureOutput(state, "stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#captureOutput(state, "stderr", chunk);
    });
    // A command can exit before the initial prompt is fully written. Handle the
    // resulting EPIPE locally so it becomes a process result instead of an
    // uncaught stream error in the control plane.
    child.stdin?.on("error", () => undefined);

    child.once("error", (error) => {
      state.processError = error;
      state.failureReason ??= error.message;
      if (!stderrStream.destroyed) {
        stderrStream.write(`[process-supervisor] ${error.message}\n`);
      }
    });

    child.once("close", (exitCode, signal) => {
      void this.#finalize(state, exitCode, signal);
    });

    if (timeoutMs > 0) {
      state.timeoutTimer = setTimeout(() => {
        this.#fail(state, `Process timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      state.timeoutTimer.unref();
    }

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      await completion;
      throw error;
    }

    state.pid = child.pid ?? null;
    // A stream can fail before the spawn event is delivered. Re-signal now that
    // a stable POSIX process-group id is available.
    if (state.terminationCompletion) this.#signalTree(state, "SIGTERM");
    if (spec.closeStdin ?? true) child.stdin?.end(spec.stdin);
    else if (spec.stdin !== undefined) child.stdin?.write(spec.stdin);

    return {
      id,
      status: "running",
      pid: state.pid,
      startedAt: state.startedAt,
      stdoutPath: state.stdoutPath,
      stderrPath: state.stderrPath,
    };
  }

  async postMessage(runId: string, message: string): Promise<void> {
    const state = this.#get(runId);
    if (state.result || !state.child.stdin || state.child.stdin.writableEnded) {
      throw new Error(`Process run ${runId} is not accepting stdin`);
    }

    await new Promise<void>((resolve, reject) => {
      state.child.stdin?.write(`${message}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  collect(runId: string): Promise<SupervisedResult> {
    return this.#get(runId).completion;
  }

  async stop(runId: string): Promise<SupervisedResult> {
    const state = this.#get(runId);
    if (state.result) return state.result;

    state.stopRequested = true;
    this.#beginTermination(state);

    return state.completion;
  }

  #captureOutput(state: InternalRun, kind: OutputKind, chunk: Buffer): void {
    const stream = kind === "stdout" ? state.stdoutStream : state.stderrStream;
    const current = kind === "stdout" ? state.stdoutBytes : state.stderrBytes;
    const maximum =
      kind === "stdout" ? state.maxStdoutBytes : state.maxStderrBytes;
    const remaining = Math.max(0, maximum - current);
    const bytesToWrite = Math.min(remaining, chunk.byteLength);

    if (bytesToWrite > 0 && !stream.destroyed) {
      try {
        stream.write(chunk.subarray(0, bytesToWrite));
      } catch (error) {
        this.#fail(
          state,
          `Failed to write ${kind} artifact: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (kind === "stdout") state.stdoutBytes += bytesToWrite;
    else state.stderrBytes += bytesToWrite;

    if (chunk.byteLength > remaining) {
      this.#fail(
        state,
        `${kind} exceeded the maximum of ${maximum} bytes`,
      );
    }
  }

  #fail(state: InternalRun, reason: string): void {
    if (state.result) return;
    state.failureReason ??= reason;
    this.#beginTermination(state);
  }

  #beginTermination(state: InternalRun): void {
    if (state.result || state.terminationCompletion) return;
    state.terminationCompletion = new Promise<void>((resolve) => {
      state.resolveTermination = resolve;
    });
    this.#signalTree(state, "SIGTERM");
    state.killTimer = setTimeout(() => {
      if (this.#treeIsAlive(state)) this.#signalTree(state, "SIGKILL");
      void this.#waitForTreeExit(state).then(() => this.#resolveTermination(state));
    }, this.#killGraceMs);
    // Keep this timer referenced: once the direct child exits it may be the only
    // thing ensuring SIGKILL reaches a stubborn descendant.
  }

  #signalTree(state: InternalRun, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && state.pid !== null) {
      try {
        process.kill(-state.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        // Fall back to the direct process if process-group signalling is denied.
      }
    }
    state.child.kill(signal);
  }

  #treeIsAlive(state: InternalRun): boolean {
    if (process.platform !== "win32" && state.pid !== null) {
      try {
        process.kill(-state.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    return state.child.exitCode === null && state.child.signalCode === null;
  }

  async #waitForTreeExit(state: InternalRun): Promise<void> {
    const deadline = Date.now() + 250;
    while (this.#treeIsAlive(state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.#treeIsAlive(state)) {
      state.failureReason ??= "Process tree did not exit after SIGKILL";
    }
  }

  #resolveTermination(state: InternalRun): void {
    if (state.terminationResolved) return;
    state.terminationResolved = true;
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
    state.resolveTermination?.();
  }

  async #awaitTermination(state: InternalRun): Promise<void> {
    if (!state.terminationCompletion) return;
    if (!this.#treeIsAlive(state)) this.#resolveTermination(state);
    await state.terminationCompletion;
  }

  async #finalize(
    state: InternalRun,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (state.result || state.finalizing) return;
    state.finalizing = true;
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }

    if (
      process.platform !== "win32" &&
      !state.terminationCompletion &&
      this.#treeIsAlive(state)
    ) {
      state.failureReason ??=
        "Agent process exited while descendant processes remained alive";
      this.#beginTermination(state);
    }

    await this.#awaitTermination(state);

    await Promise.all([
      closeStream(state.stdoutStream),
      closeStream(state.stderrStream),
    ]);

    const hasFailure = Boolean(state.failureReason || state.processError);
    const status: AdapterTerminalStatus = hasFailure
      ? "failed"
      : state.stopRequested
        ? "stopped"
        : exitCode === 0
          ? "succeeded"
          : "failed";
    const error =
      status !== "failed"
        ? null
        : state.failureReason ??
          state.processError?.message ??
          (exitCode !== null
            ? `Process exited with code ${exitCode}`
            : signal
              ? `Process terminated by ${signal}`
              : "Process failed");
    const result: SupervisedResult = {
      id: state.id,
      status,
      pid: state.pid,
      startedAt: state.startedAt,
      finishedAt: new Date().toISOString(),
      stdoutPath: state.stdoutPath,
      stderrPath: state.stderrPath,
      exitCode,
      signal,
      error,
    };
    state.result = result;
    state.resolveCompletion(result);
  }

  #get(runId: string): InternalRun {
    const state = this.#runs.get(runId);
    if (!state) throw new AdapterRunNotFoundError(runId);
    return state;
  }
}

export interface RecoveredProcessTermination {
  runId: string;
  pid: number;
  status: "terminated" | "not-found" | "unverified" | "failed";
  detail: string;
}

async function captureCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 2_000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timeout.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (bytes >= 2 * 1024 * 1024) return;
      const remaining = 2 * 1024 * 1024 - bytes;
      const captured = chunk.subarray(0, remaining);
      chunks.push(captured);
      bytes += captured.byteLength;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function groupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !groupAlive(processGroupId);
}

/**
 * Best-effort crash recovery for a detached local CLI group. A PID is never
 * signalled until a live member exposes the unguessable durable run token in
 * its inherited environment; otherwise the worktree remains quarantined.
 */
export async function terminateVerifiedProcessGroup(input: {
  runId: string;
  pid: number;
  graceMs?: number;
}): Promise<RecoveredProcessTermination> {
  const { runId, pid } = input;
  if (process.platform === "win32") {
    return {
      runId,
      pid,
      status: "unverified",
      detail: "Verified process-group recovery is not available on Windows.",
    };
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return { runId, pid, status: "unverified", detail: "Persisted PID is unsafe." };
  }
  let members: number[];
  try {
    const listing = await captureCommand("ps", ["-axo", "pid=,pgid="]);
    members = listing
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((parts) => parts.length >= 2 && parts[1] === pid)
      .map((parts) => parts[0]!)
      .filter((memberPid) => Number.isSafeInteger(memberPid) && memberPid > 1);
  } catch (error) {
    return {
      runId,
      pid,
      status: "unverified",
      detail: `Could not inspect process group: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (members.length === 0) {
    return { runId, pid, status: "not-found", detail: "Process group is no longer live." };
  }
  if (members.includes(process.pid)) {
    return { runId, pid, status: "unverified", detail: "Process group contains the worker." };
  }
  const token = `${CONTROL_RUN_TOKEN_ENV}=${runId}`;
  let verified = false;
  for (const memberPid of members) {
    try {
      const environment = await captureCommand("ps", [
        "eww",
        "-p",
        String(memberPid),
        "-o",
        "command=",
      ]);
      if (environment.includes(token)) {
        verified = true;
        break;
      }
    } catch {
      // Another member may still be inspectable.
    }
  }
  if (!verified) {
    return {
      runId,
      pid,
      status: "unverified",
      detail: "No live group member carried the persisted run token.",
    };
  }

  try {
    process.kill(-pid, "SIGTERM");
    if (!(await waitForGroupExit(pid, input.graceMs ?? 2_000))) {
      process.kill(-pid, "SIGKILL");
      if (!(await waitForGroupExit(pid, 500))) {
        return {
          runId,
          pid,
          status: "failed",
          detail: "Verified group remained live after SIGKILL.",
        };
      }
    }
    return { runId, pid, status: "terminated", detail: "Verified process group terminated." };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return { runId, pid, status: "not-found", detail: "Process group exited during recovery." };
    }
    return {
      runId,
      pid,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ProbeResult {
  available: boolean;
  version: string | null;
  reason: string | null;
  stdout: string;
  stderr: string;
}

export async function probeExecutable(
  command: string,
  args: readonly string[] = ["--version"],
  timeoutMs = 5_000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        available: false,
        version: null,
        reason: `Timed out after ${timeoutMs}ms`,
        stdout,
        stderr,
      });
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 64_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish({
        available: false,
        version: null,
        reason: error.message,
        stdout,
        stderr,
      });
    });
    child.once("close", (code) => {
      const output = (stdout.trim() || stderr.trim()).split("\n")[0] ?? null;
      finish({
        available: code === 0,
        version: code === 0 ? output : null,
        reason:
          code === 0
            ? null
            : stderr.trim() || stdout.trim() || `Exited with code ${code}`,
        stdout,
        stderr,
      });
    });
  });
}
