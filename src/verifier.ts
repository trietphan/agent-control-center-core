import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProcessSupervisor, type SupervisedResult } from "./adapters/index.js";
import { ArtifactStore, type ArtifactMetadata } from "./artifacts.js";

export interface VerificationRequest {
  taskId: string;
  runId: string;
  commandLine: string;
  workingDirectory: string;
  timeoutMs?: number;
  onStarted?: (process: { pid: number | null; startedAt: string }) => Promise<void>;
}

export interface VerificationResult {
  status: "succeeded" | "failed" | "stopped";
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  artifact: ArtifactMetadata;
}

export interface TaskVerifier {
  run(request: VerificationRequest): Promise<VerificationResult>;
  stop(runId: string): Promise<void>;
}

/**
 * Split a human-friendly command line into an argv vector without invoking a
 * shell. Quotes and backslash escapes are syntax only; operators such as `&&`
 * remain ordinary arguments and can never execute a second command.
 */
export function parseVerificationCommand(commandLine: string): string[] {
  const input = commandLine.trim();
  if (!input) throw new Error("Verification command cannot be empty");

  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const finishToken = () => {
    if (!tokenStarted) return;
    argv.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quote === "single") {
      if (character === "'") quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        index += 1;
        if (index >= input.length) {
          throw new Error("Verification command ends with an incomplete escape");
        }
        token += input[index]!;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      finishToken();
    } else if (character === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (character === '"') {
      quote = "double";
      tokenStarted = true;
    } else if (character === "\\") {
      index += 1;
      if (index >= input.length) {
        throw new Error("Verification command ends with an incomplete escape");
      }
      token += input[index]!;
      tokenStarted = true;
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) throw new Error(`Verification command has an unterminated ${quote} quote`);
  finishToken();
  if (argv.length === 0 || !argv[0]) {
    throw new Error("Verification command must contain an executable");
  }
  return argv;
}

export interface ProcessTaskVerifierOptions {
  artifacts: ArtifactStore;
  supervisor?: ProcessSupervisor;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Runs explicit verification in the isolated worktree and persists one log. */
export class ProcessTaskVerifier implements TaskVerifier {
  readonly #artifacts: ArtifactStore;
  readonly #supervisor: ProcessSupervisor;
  readonly #timeoutMs: number | undefined;
  readonly #maxOutputBytes: number | undefined;
  readonly #active = new Map<string, string>();
  readonly #stopBeforeStart = new Set<string>();

  constructor(options: ProcessTaskVerifierOptions) {
    this.#artifacts = options.artifacts;
    this.#supervisor = options.supervisor ?? new ProcessSupervisor();
    this.#timeoutMs = options.timeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes;
  }

  async run(request: VerificationRequest): Promise<VerificationResult> {
    const argv = parseVerificationCommand(request.commandLine);
    const command = argv[0]!;
    const args = argv.slice(1);
    const artifactDir = await this.#artifacts.prepareRunDirectory(
      request.taskId,
      request.runId,
    );
    const supervisorRunId = `verification_${randomUUID()}`;
    const stdoutPath = join(artifactDir, ".verification.stdout.tmp");
    const stderrPath = join(artifactDir, ".verification.stderr.tmp");
    const fallbackStartedAt = new Date().toISOString();
    const effectiveTimeoutMs = request.timeoutMs ?? this.#timeoutMs;
    let supervised: SupervisedResult;

    if (this.#stopBeforeStart.delete(request.runId)) {
      supervised = {
        id: supervisorRunId,
        status: "stopped",
        pid: null,
        startedAt: fallbackStartedAt,
        finishedAt: new Date().toISOString(),
        stdoutPath,
        stderrPath,
        exitCode: null,
        signal: null,
        error: null,
      };
    } else {
      this.#active.set(request.runId, supervisorRunId);
      try {
        const started = await this.#supervisor.start({
          id: supervisorRunId,
          command,
          args,
          cwd: request.workingDirectory,
          stdoutPath,
          stderrPath,
          env: {
            ACC_CONTROL_RUN_ID: request.runId,
            CI: process.env.CI ?? "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          ...(effectiveTimeoutMs !== undefined
            ? { timeoutMs: effectiveTimeoutMs }
            : {}),
          ...(this.#maxOutputBytes !== undefined
            ? { maxOutputBytes: this.#maxOutputBytes }
            : {}),
        });
        try {
          await request.onStarted?.({ pid: started.pid, startedAt: started.startedAt });
        } catch (error) {
          await this.#supervisor.stop(supervisorRunId).catch(() => undefined);
          throw error;
        }
        supervised = await this.#supervisor.collect(supervisorRunId);
      } catch (error) {
        supervised = {
          id: supervisorRunId,
          status: "failed",
          pid: null,
          startedAt: fallbackStartedAt,
          finishedAt: new Date().toISOString(),
          stdoutPath,
          stderrPath,
          exitCode: null,
          signal: null,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        this.#active.delete(request.runId);
      }
    }

    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8").catch(() => ""),
      readFile(stderrPath, "utf8").catch(() => ""),
    ]);
    const body = [
      "# Independent verification",
      "",
      `Command argv: ${JSON.stringify([command, ...args])}`,
      `Working directory: ${request.workingDirectory}`,
      `Status: ${supervised.status}`,
      `Started: ${supervised.startedAt}`,
      `Finished: ${supervised.finishedAt}`,
      `Exit code: ${supervised.exitCode ?? "n/a"}`,
      `Signal: ${supervised.signal ?? "n/a"}`,
      `Error: ${supervised.error ?? "n/a"}`,
      "",
      "## stdout",
      stdout || "(empty)",
      "",
      "## stderr",
      stderr || "(empty)",
      "",
    ].join("\n");
    const artifact = await this.#artifacts.writeText({
      taskId: request.taskId,
      runId: request.runId,
      kind: "test-log",
      name: "test-log.txt",
      data: body,
    });
    await Promise.all([
      rm(stdoutPath, { force: true }),
      rm(stderrPath, { force: true }),
    ]);

    return {
      status:
        supervised.status === "succeeded"
          ? "succeeded"
          : supervised.status === "stopped"
            ? "stopped"
            : "failed",
      command,
      args,
      startedAt: supervised.startedAt,
      finishedAt: supervised.finishedAt,
      exitCode: supervised.exitCode,
      signal: supervised.signal,
      error: supervised.error,
      artifact,
    };
  }

  async stop(runId: string): Promise<void> {
    const supervisorRunId = this.#active.get(runId);
    if (!supervisorRunId) {
      this.#stopBeforeStart.add(runId);
      return;
    }
    await this.#supervisor.stop(supervisorRunId);
  }
}
