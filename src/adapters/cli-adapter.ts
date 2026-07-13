import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentKind, RouteRole } from "../protocol.js";
import { buildTaskPrompt } from "./prompt.js";
import {
  ProcessSupervisor,
  probeExecutable,
  type ProbeResult,
  type SupervisedResult,
} from "./process-supervisor.js";
import type { UsageRecord } from "../usage.js";
import type {
  AdapterAvailability,
  AdapterResult,
  AdapterRun,
  AdapterTaskRequest,
  AgentAdapter,
} from "./types.js";
import {
  AdapterCapabilityError,
  AdapterRunNotFoundError,
} from "./types.js";

export interface CliAdapterOptions {
  command?: string;
  commandArgs?: readonly string[];
  supervisor?: ProcessSupervisor;
  availabilityTimeoutMs?: number;
}

interface CliRunContext {
  taskId: string;
  role: RouteRole;
  workingDirectory: string;
  resultPath: string;
  startedAt: string;
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
}

export abstract class CliAdapter implements AgentAdapter {
  abstract readonly kind: AgentKind;

  readonly #command: string;
  readonly #commandArgs: readonly string[];
  readonly #supervisor: ProcessSupervisor;
  readonly #availabilityTimeoutMs: number;
  readonly #runs = new Map<string, CliRunContext>();

  protected constructor(defaultCommand: string, options: CliAdapterOptions = {}) {
    this.#command = options.command ?? defaultCommand;
    this.#commandArgs = options.commandArgs ?? [];
    this.#supervisor = options.supervisor ?? new ProcessSupervisor();
    this.#availabilityTimeoutMs = options.availabilityTimeoutMs ?? 5_000;
  }

  async availability(): Promise<AdapterAvailability> {
    const probe = await this.probe(["--version"]);
    return {
      available: probe.available,
      version: probe.version,
      reason: probe.reason,
      target: this.#command,
    };
  }

  protected async probe(args: readonly string[]): Promise<ProbeResult> {
    return await probeExecutable(
      this.#command,
      [...this.#commandArgs, ...args],
      this.#availabilityTimeoutMs,
    );
  }

  async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    const id = `run_${randomUUID()}`;
    const role = request.role ?? "execute";
    const stdoutPath = join(request.artifactDir, `${this.kind}.stdout.log`);
    const stderrPath = join(request.artifactDir, `${this.kind}.stderr.log`);
    const resultPath = join(request.artifactDir, `${this.kind}.result.txt`);
    const prompt = request.prompt ?? buildTaskPrompt(request);
    await mkdir(request.artifactDir, { recursive: true });
    await writeFile(resultPath, "", "utf8");
    const args = [
      ...this.#commandArgs,
      ...this.buildArguments(request, role, resultPath),
    ];

    const run = await this.#supervisor.start({
      id,
      command: this.#command,
      args,
      cwd: request.workingDirectory,
      ...(request.env ? { env: request.env } : {}),
      stdin: prompt,
      closeStdin: true,
      stdoutPath,
      stderrPath,
    });

    const taskId = request.task.id ?? id;
    this.#runs.set(id, {
      taskId,
      role,
      workingDirectory: request.workingDirectory,
      resultPath,
      startedAt: run.startedAt,
      pid: run.pid,
      stdoutPath,
      stderrPath,
    });
    const adapterRun: AdapterRun = {
      id,
      taskId,
      agent: this.kind,
      role,
      status: "running",
      startedAt: run.startedAt,
      pid: run.pid,
      workingDirectory: request.workingDirectory,
      stdoutPath,
      stderrPath,
      resultPath,
    };
    try {
      await request.onStarted?.(adapterRun);
    } catch (error) {
      // If durable start evidence cannot be recorded, do not leave a detached
      // child running with no recoverable PID in the state database.
      await this.#supervisor.stop(id).catch(() => undefined);
      throw error;
    }
    return adapterRun;
  }

  async postMessage(runId: string, message: string): Promise<void> {
    this.#context(runId);
    try {
      await this.#supervisor.postMessage(runId, message);
    } catch (error) {
      throw new AdapterCapabilityError(
        `${this.kind} non-interactive run ${runId} cannot accept another message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async collectResult(runId: string): Promise<AdapterResult> {
    const context = this.#context(runId);
    const supervised = await this.#supervisor.collect(runId);
    return this.#toResult(context, supervised);
  }

  async stop(runId: string): Promise<AdapterResult> {
    const context = this.#context(runId);
    const supervised = await this.#supervisor.stop(runId);
    return this.#toResult(context, supervised);
  }

  protected abstract buildArguments(
    request: AdapterTaskRequest,
    role: RouteRole,
    resultPath: string,
  ): readonly string[];

  protected abstract collectSummary(
    supervised: SupervisedResult,
    resultPath: string,
  ): Promise<string>;

  /**
   * Parse normalized provider usage from the run's output. Defaults to
   * null; adapters whose CLI reports token/cost data override this.
   */
  protected collectUsage(
    _supervised: SupervisedResult,
    _resultPath: string,
  ): Promise<UsageRecord | null> {
    return Promise.resolve(null);
  }

  protected async readText(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "";
      throw error;
    }
  }

  async #toResult(
    context: CliRunContext,
    supervised: SupervisedResult,
  ): Promise<AdapterResult> {
    const summary = await this.collectSummary(supervised, context.resultPath);
    const usage = await this.collectUsage(supervised, context.resultPath);
    const stderr = await this.readText(context.stderrPath);
    const error =
      supervised.status === "failed"
        ? (supervised.error ?? stderr.trim()) || "Agent process failed"
        : null;

    return {
      id: supervised.id,
      taskId: context.taskId,
      agent: this.kind,
      role: context.role,
      status: supervised.status,
      startedAt: context.startedAt,
      finishedAt: supervised.finishedAt,
      pid: context.pid,
      workingDirectory: context.workingDirectory,
      stdoutPath: context.stdoutPath,
      stderrPath: context.stderrPath,
      resultPath: context.resultPath,
      exitCode: supervised.exitCode,
      signal: supervised.signal,
      summary: summary.trim(),
      error,
      ...(usage ? { usage } : {}),
    };
  }

  #context(runId: string): CliRunContext {
    const context = this.#runs.get(runId);
    if (!context) throw new AdapterRunNotFoundError(runId);
    return context;
  }
}
