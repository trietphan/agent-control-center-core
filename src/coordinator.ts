import { basename, dirname, extname, resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import {
  CONTROL_RUN_TOKEN_ENV,
  type AgentAdapter,
  type AdapterResult,
  type AdapterRun,
} from "./adapters/index.js";
import {
  ArtifactStore,
  type ArtifactMetadata,
} from "./artifacts.js";
import {
  ControlCenterDb,
  type EventLevel,
  type ArtifactRecord,
  type MessageRecord,
  type RouteStepRecord,
  type RunRecord,
  type TaskAggregate,
} from "./db.js";
import { InProcessMessageBus, type MessageBus } from "./message-bus.js";
import { buildAgentPrompt } from "./prompt.js";
import {
  TaskPayloadSchema,
  type AgentKind,
  type RunStatus,
  type TaskPayload,
} from "./protocol.js";
import { routeTask } from "./router.js";
import {
  WorktreeManager,
  type SourceRepositorySnapshot,
  type WorktreeInfo,
} from "./worktrees.js";
import {
  ProcessTaskVerifier,
  type TaskVerifier,
  type VerificationResult,
} from "./verifier.js";

interface StepOutcome {
  step: RouteStepRecord;
  run: RunRecord | null;
  result: AdapterResult | null;
  worktree: WorktreeInfo | null;
  succeeded: boolean;
  skipped: boolean;
  error: string | null;
}

interface ActiveRunControl {
  taskId: string;
  dbRunId: string;
  adapterRunId: string;
  adapter: AgentAdapter;
}

type RunControlPhase = "starting" | "active" | "verifying" | "finalizing";

export type RunControlErrorCode =
  | "run_not_found"
  | "run_not_owned"
  | "run_starting"
  | "run_finalizing"
  | "run_terminal";

export class RunControlError extends Error {
  readonly code: RunControlErrorCode;

  constructor(code: RunControlErrorCode, message: string) {
    super(message);
    this.name = "RunControlError";
    this.code = code;
  }
}

export type ScreenshotContentType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

function assertScreenshotBytes(
  name: string,
  contentType: ScreenshotContentType,
  data: Uint8Array,
): void {
  const extension = extname(name).toLowerCase();
  const matches =
    contentType === "image/png"
      ? extension === ".png" &&
        data.length >= 8 &&
        Buffer.from(data.subarray(0, 8)).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
      : contentType === "image/jpeg"
        ? (extension === ".jpg" || extension === ".jpeg") &&
          data.length >= 3 &&
          data[0] === 0xff &&
          data[1] === 0xd8 &&
          data[2] === 0xff
        : contentType === "image/webp"
          ? extension === ".webp" &&
            data.length >= 12 &&
            Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
            Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
          : extension === ".gif" &&
            data.length >= 6 &&
            ["GIF87a", "GIF89a"].includes(
              Buffer.from(data.subarray(0, 6)).toString("ascii"),
            );
  if (!matches) {
    throw new Error(`Screenshot bytes do not match ${contentType} and ${extension || "no extension"}`);
  }
}

export interface CoordinatorOptions {
  db: ControlCenterDb;
  artifacts: ArtifactStore;
  worktrees: WorktreeManager;
  adapters: ReadonlyMap<AgentKind, AgentAdapter>;
  bus?: MessageBus;
  workerId?: string;
  maxAdapterArtifactBytes?: number;
  heartbeatIntervalMs?: number;
  verifier?: TaskVerifier;
}

export interface RunTaskResult {
  taskId: string;
  status: "done" | "needs-review" | "blocked";
  handoffPath: string | null;
  outcomes: StepOutcome[];
}

function terminalRunStatus(result: AdapterResult): RunStatus {
  if (result.status === "succeeded") return "succeeded";
  if (result.status === "stopped") return "stopped";
  if (result.status === "stale") return "stale";
  return "failed";
}

function historicalAdapterResult(run: RunRecord): AdapterResult | null {
  if (!run.finishedAt) return null;
  const status =
    run.status === "succeeded"
      ? "succeeded"
      : run.status === "stopped"
        ? "stopped"
        : run.status === "failed" || run.status === "stale"
          ? "failed"
          : null;
  if (!status) return null;
  return {
    id: run.adapterRunId ?? run.id,
    taskId: run.taskId,
    agent: run.agent,
    role: run.role,
    status,
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.finishedAt,
    pid: run.pid,
    workingDirectory: run.worktreePath ?? "",
    stdoutPath: run.stdoutPath ?? "",
    stderrPath: run.stderrPath ?? "",
    resultPath: run.resultPath ?? "",
    exitCode: run.exitCode,
    signal: run.signal as NodeJS.Signals | null,
    summary: run.summary ?? "",
    error: run.error,
  };
}

export class Coordinator {
  readonly #db: ControlCenterDb;
  readonly #artifacts: ArtifactStore;
  readonly #worktrees: WorktreeManager;
  readonly #adapters: ReadonlyMap<AgentKind, AgentAdapter>;
  readonly #bus: MessageBus;
  readonly #workerId: string;
  readonly #maxAdapterArtifactBytes: number;
  readonly #heartbeatIntervalMs: number;
  readonly #verifier: TaskVerifier;
  readonly #activeRuns = new Map<string, ActiveRunControl>();
  readonly #activeVerifications = new Map<string, string>();
  readonly #runPhases = new Map<
    string,
    { taskId: string; phase: RunControlPhase }
  >();
  readonly #stopRequestedRuns = new Set<string>();
  #shutdownRequested = false;

  constructor(options: CoordinatorOptions) {
    this.#db = options.db;
    this.#artifacts = options.artifacts;
    this.#worktrees = options.worktrees;
    this.#adapters = options.adapters;
    this.#bus = options.bus ?? new InProcessMessageBus();
    this.#workerId = options.workerId ?? `local:${process.pid}`;
    this.#maxAdapterArtifactBytes =
      options.maxAdapterArtifactBytes ?? 16 * 1024 * 1024;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.#verifier =
      options.verifier ?? new ProcessTaskVerifier({ artifacts: options.artifacts });
  }

  async createTask(input: unknown): Promise<TaskAggregate> {
    const parsed = TaskPayloadSchema.parse(input);
    // Queue entries outlive the shell that created them. Persist a stable path
    // so a daemon launched from another working directory resolves the same repo.
    const task: TaskPayload = { ...parsed, repo: resolve(parsed.repo) };
    const plan = routeTask(task);
    const created = await this.#db.createTask(task, plan);
    await this.#publish({
      taskId: created.task.id,
      type: "route.decided",
      message: plan.reasons.join(" "),
      data: {
        mode: plan.mode,
        risk: plan.risk,
        agents: plan.steps.map((step) => step.agent),
      },
    });
    return created;
  }

  async runNext(): Promise<RunTaskResult | null> {
    if (this.#shutdownRequested) return null;
    const claimed = await this.#db.claimNextTask(this.#workerId);
    if (!claimed) return null;
    return await this.executeTask(claimed.task.id);
  }

  async executeTask(taskId: string): Promise<RunTaskResult> {
    const aggregate = await this.#db.getTask(taskId);
    if (!aggregate) throw new Error(`Task not found: ${taskId}`);
    if (aggregate.task.status !== "running") {
      throw new Error(`Task ${taskId} must be claimed before execution`);
    }
    if (aggregate.task.claimedBy !== this.#workerId) {
      throw new Error(
        `Task ${taskId} is claimed by ${aggregate.task.claimedBy ?? "nobody"}, not ${this.#workerId}`,
      );
    }
    if (this.#shutdownRequested) {
      return await this.#blockForShutdown(taskId, []);
    }
    await this.#db.heartbeatTask(taskId, this.#workerId);
    const heartbeat =
      this.#heartbeatIntervalMs > 0
        ? setInterval(() => {
            // A later heartbeat can recover from a transient SQLite busy error.
            // Ownership is still enforced by the DB CAS predicate.
            void this.#db.heartbeatTask(taskId, this.#workerId).catch(() => undefined);
          }, this.#heartbeatIntervalMs)
        : null;
    heartbeat?.unref();
    try {
      return await this.#executeClaimedTask(aggregate);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async #executeClaimedTask(aggregate: TaskAggregate): Promise<RunTaskResult> {
    const taskId = aggregate.task.id;

    const pending = aggregate.routeSteps.filter((step) => step.status === "pending");
    const sequences = [...new Set(pending.map((step) => step.sequence))].sort(
      (a, b) => a - b,
    );
    const outcomes: StepOutcome[] = [];
    const priorResults = aggregate.runs
      .map(historicalAdapterResult)
      .filter((result): result is AdapterResult => result != null);
    const feedback = [
      ...aggregate.reviews.flatMap((review) =>
        review.note ? [`Review ${review.status}: ${review.note}`] : [],
      ),
      ...aggregate.messages.map((message) => `${message.role}: ${message.body}`),
    ];
    const executionTask: TaskAggregate["task"] = {
      ...aggregate.task,
      ...(feedback.length
        ? {
            context: [
              aggregate.task.context,
              "Prior attempt feedback and run-scoped messages:",
              ...feedback,
            ]
              .filter(Boolean)
              .join("\n\n"),
          }
        : {}),
    };
    const quarantinedWorktrees = new Set(
      aggregate.runs
        .filter(
          (run) =>
            run.worktreePath &&
            (run.status === "stale" ||
              run.error?.startsWith("Worker heartbeat expired")),
        )
        .map((run) => run.worktreePath!),
    );
    const latestWorktreeRun =
      aggregate.task.routePlan.mode === "parallel"
        ? null
        : [...aggregate.runs]
            .reverse()
            .find(
              (run) =>
                run.worktreePath &&
                run.branch &&
                run.baseCommit &&
                run.status !== "stale" &&
                !run.error?.startsWith("Worker heartbeat expired") &&
                !quarantinedWorktrees.has(run.worktreePath),
            ) ?? null;
    let inheritedWorktree: WorktreeInfo | null = latestWorktreeRun
      ? {
          taskId,
          runId: latestWorktreeRun.id,
          sourceRepo: aggregate.task.repo,
          worktreePath: latestWorktreeRun.worktreePath!,
          branch: latestWorktreeRun.branch!,
          baseRef: aggregate.task.baseRef,
          baseCommit: latestWorktreeRun.baseCommit!,
          createdAt: latestWorktreeRun.createdAt,
          preserved: true,
        }
      : null;

    for (const sequence of sequences) {
      if (this.#shutdownRequested) {
        return await this.#blockForShutdown(taskId, outcomes);
      }
      const group = pending.filter((step) => step.sequence === sequence);
      const groupOutcomes = await Promise.all(
        group.map((step) =>
          this.#executeStep(
            executionTask,
            step,
            [...priorResults],
            inheritedWorktree,
          ),
        ),
      );
      outcomes.push(...groupOutcomes);
      for (const outcome of groupOutcomes) {
        if (outcome.result?.status === "succeeded") {
          priorResults.push(outcome.result);
        }
      }
      inheritedWorktree ??=
        groupOutcomes.find((outcome) => outcome.worktree)?.worktree ?? null;

      if (this.#shutdownRequested) {
        return await this.#blockForShutdown(taskId, outcomes);
      }

      const requiredFailure = groupOutcomes.find(
        (outcome) => outcome.step.required && !outcome.succeeded,
      );
      if (requiredFailure) {
        let detail =
          requiredFailure.error ??
          `${requiredFailure.step.agent} ${requiredFailure.step.role} failed`;
        let handoffPath: string | null = null;
        try {
          handoffPath = await this.#writeHandoff(taskId, "blocked", detail);
        } catch (error) {
          detail = `${detail}; could not persist handoff evidence: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        await this.#db.updateTaskStatus(taskId, "blocked", detail);
        await this.#publish({
          taskId,
          ...(requiredFailure.run ? { runId: requiredFailure.run.id } : {}),
          type: "task.blocked",
          level: "error",
          message: detail,
        });
        return { taskId, status: "blocked", handoffPath, outcomes };
      }
    }

    if (this.#shutdownRequested) {
      return await this.#blockForShutdown(taskId, outcomes);
    }

    const refreshed = await this.#db.getTask(taskId);
    if (!refreshed) throw new Error(`Task disappeared during execution: ${taskId}`);
    const needsReview =
      refreshed.task.handoffRequired || refreshed.task.routePlan.risk === "high";
    const status = needsReview ? "needs-review" : "done";
    const update = needsReview
      ? "Execution evidence is ready for human review."
      : "All required route steps completed successfully.";
    const latestRun = [...refreshed.runs].reverse().find((run) => run.status === "succeeded");
    let handoffPath: string | null;
    try {
      handoffPath = await this.#writeHandoff(taskId, status);
    } catch (error) {
      const detail = `Could not persist completion evidence: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await this.#db.updateTaskStatus(taskId, "blocked", detail);
      await this.#publish({
        taskId,
        ...(latestRun ? { runId: latestRun.id } : {}),
        type: "task.blocked",
        level: "error",
        message: detail,
      });
      return { taskId, status: "blocked", handoffPath: null, outcomes };
    }
    await this.#db.finalizeTaskExecution({
      taskId,
      status,
      latestUpdate: update,
      ...(latestRun ? { runId: latestRun.id } : {}),
    });
    await this.#publish({
      taskId,
      ...(latestRun ? { runId: latestRun.id } : {}),
      type: needsReview ? "review.requested" : "task.completed",
      message: update,
      ...(handoffPath ? { data: { handoffPath } } : {}),
    });
    return { taskId, status, handoffPath, outcomes };
  }

  async approveTask(taskId: string, note?: string): Promise<void> {
    const review = await this.#db.approveTaskReview(taskId, note);
    await this.#publish({
      taskId,
      ...(review.runId ? { runId: review.runId } : {}),
      type: "review.approved",
      message: note?.trim() || "Task approved by human reviewer.",
    });
  }

  async approveReview(
    reviewId: string,
    expectedUpdatedAt: string,
    note?: string,
  ): Promise<string> {
    const pending = await this.#db.getReview(reviewId);
    if (!pending) throw new Error(`Review not found: ${reviewId}`);
    const review = await this.#db.approveTaskReview(pending.taskId, note, {
      reviewId,
      updatedAt: expectedUpdatedAt,
    });
    await this.#publish({
      taskId: review.taskId,
      ...(review.runId ? { runId: review.runId } : {}),
      type: "review.approved",
      message: note?.trim() || "Task approved by human reviewer.",
      data: { reviewId },
    });
    return review.taskId;
  }

  async requestRework(taskId: string, note: string): Promise<void> {
    const { review } = await this.#db.requestTaskRework(taskId, note);
    await this.#publish({
      taskId,
      ...(review.runId ? { runId: review.runId } : {}),
      type: "review.rework_requested",
      level: "warn",
      message: note,
    });
  }

  async requestReviewRework(
    reviewId: string,
    expectedUpdatedAt: string,
    note: string,
  ): Promise<string> {
    const pending = await this.#db.getReview(reviewId);
    if (!pending) throw new Error(`Review not found: ${reviewId}`);
    const { review } = await this.#db.requestTaskRework(pending.taskId, note, {
      reviewId,
      updatedAt: expectedUpdatedAt,
    });
    await this.#publish({
      taskId: review.taskId,
      ...(review.runId ? { runId: review.runId } : {}),
      type: "review.rework_requested",
      level: "warn",
      message: note,
      data: { reviewId },
    });
    return review.taskId;
  }

  async retryBlockedTask(
    taskId: string,
    note?: string,
    allowUnconfirmedRemote = false,
  ): Promise<void> {
    const message = await this.#db.retryBlockedTask(
      taskId,
      note,
      allowUnconfirmedRemote,
    );
    await this.#publish({
      taskId,
      type: "task.retry_requested",
      level: "warn",
      message: message.body,
    });
  }

  async postMessage(taskId: string, body: string): Promise<void> {
    const controls = [...this.#activeRuns.values()].filter(
      (item) => item.taskId === taskId,
    );
    if (controls.length === 0) {
      throw new Error(`This supervisor does not own a live run for task ${taskId}`);
    }
    if (controls.length > 1) {
      throw new Error(
        `Task ${taskId} has ${controls.length} parallel live runs; target a run through the daemon API`,
      );
    }
    const [control] = controls;
    if (!control) throw new Error(`Task ${taskId} has no live adapter run`);
    const message = await this.#db.addMessage({
      taskId,
      runId: control.dbRunId,
      direction: "user-to-agent",
      role: "user",
      body,
    });
    try {
      await control.adapter.postMessage(control.adapterRunId, body);
      await this.#db.updateMessageDelivery(message.id, "delivered");
    } catch (error) {
      const unsupported = error instanceof Error && error.name === "AdapterCapabilityError";
      await this.#db.updateMessageDelivery(
        message.id,
        unsupported ? "unsupported" : "failed",
      );
      throw error;
    }
  }

  async postMessageToRun(runId: string, body: string): Promise<MessageRecord> {
    const run = await this.#db.getRun(runId);
    if (!run) throw new RunControlError("run_not_found", `Run not found: ${runId}`);
    const control = this.#activeRuns.get(runId);
    if (!control) this.#throwControlPhase(runId, run.status);
    const message = await this.#db.addMessage({
      taskId: run.taskId,
      runId,
      direction: "user-to-agent",
      role: "user",
      body,
    });
    try {
      await control!.adapter.postMessage(control!.adapterRunId, body);
      await this.#db.updateMessageDelivery(message.id, "delivered");
      return { ...message, deliveryStatus: "delivered" };
    } catch (error) {
      const unsupported = error instanceof Error && error.name === "AdapterCapabilityError";
      const deliveryStatus = unsupported ? "unsupported" : "failed";
      await this.#db.updateMessageDelivery(message.id, deliveryStatus);
      throw error;
    }
  }

  async stopRun(
    runId: string,
  ): Promise<"accepted" | "already-terminal" | "finalizing"> {
    const run = await this.#db.getRun(runId);
    if (!run) throw new RunControlError("run_not_found", `Run not found: ${runId}`);
    if (["succeeded", "failed", "stopped", "stale"].includes(run.status)) {
      return "already-terminal";
    }
    const phase = this.#runPhases.get(runId)?.phase;
    if (phase === "finalizing") return "finalizing";
    await this.#publish({
      taskId: run.taskId,
      runId,
      type: "run.stop_requested",
      level: "warn",
      message: "Operator requested cancellation for this run.",
    });
    const verificationTaskId = this.#activeVerifications.get(runId);
    if (verificationTaskId) {
      await this.#verifier.stop(runId);
      return "accepted";
    }
    const control = this.#activeRuns.get(runId);
    if (control) {
      await control.adapter.stop(control.adapterRunId);
      return "accepted";
    }
    if (phase === "starting") {
      this.#stopRequestedRuns.add(runId);
      return "accepted";
    }
    throw new RunControlError(
      "run_not_owned",
      `This supervisor does not own live run ${runId}`,
    );
  }

  async stopTask(taskId: string): Promise<void> {
    const runIds = [...this.#runPhases.entries()]
      .filter(([, state]) => state.taskId === taskId)
      .map(([runId]) => runId);
    if (runIds.length === 0) {
      throw new Error(`This supervisor does not own a live run for task ${taskId}`);
    }
    await Promise.all(runIds.map((runId) => this.stopRun(runId)));
  }

  async stopAllActiveRuns(): Promise<void> {
    const taskIds = [
      ...new Set([
        ...[...this.#activeRuns.values()].map((item) => item.taskId),
        ...this.#activeVerifications.values(),
        ...[...this.#runPhases.values()].map((state) => state.taskId),
      ]),
    ];
    await Promise.allSettled(taskIds.map((taskId) => this.stopTask(taskId)));
  }

  async attachScreenshot(input: {
    taskId: string;
    runId: string;
    name: string;
    contentType: ScreenshotContentType;
    data: Uint8Array;
    metadata?: Record<string, unknown>;
  }): Promise<ArtifactRecord> {
    const run = await this.#db.getRun(input.runId);
    if (!run || run.taskId !== input.taskId) {
      throw new Error(`Run ${input.runId} does not belong to task ${input.taskId}`);
    }
    const size = input.data.byteLength;
    if (size > this.#maxAdapterArtifactBytes) {
      throw new Error(`Screenshot exceeded ${this.#maxAdapterArtifactBytes} bytes`);
    }
    assertScreenshotBytes(input.name, input.contentType, input.data);
    const artifact = await this.#artifacts.write({
      taskId: input.taskId,
      runId: input.runId,
      kind: "screenshot",
      name: input.name,
      data: input.data,
    });
    const record = await this.#db.addArtifact({
      ...artifact,
      metadata: { ...input.metadata, contentType: input.contentType },
    });
    await this.#publish({
      taskId: input.taskId,
      runId: input.runId,
      type: "artifact.screenshot_attached",
      message: `Attached screenshot ${input.name}.`,
      data: { artifactId: record.id, sha256: record.sha256, sizeBytes: record.sizeBytes },
    });
    return record;
  }

  async requestShutdown(): Promise<void> {
    this.#shutdownRequested = true;
    await this.stopAllActiveRuns();
  }

  async #executeStep(
    task: TaskAggregate["task"],
    step: RouteStepRecord,
    priorResults: AdapterResult[],
    inheritedWorktree: WorktreeInfo | null,
  ): Promise<StepOutcome> {
    if (this.#shutdownRequested) {
      return await this.#unavailableStep(step, "Worker shutdown requested before execution.");
    }
    const adapter = this.#adapters.get(step.agent);
    if (!adapter) {
      return await this.#unavailableStep(step, `Adapter is not registered: ${step.agent}`);
    }
    const availability = await adapter.availability();
    if (!availability.available) {
      return await this.#unavailableStep(
        step,
        `${step.agent} unavailable: ${availability.reason ?? availability.target}`,
      );
    }
    if (this.#shutdownRequested) {
      return await this.#unavailableStep(step, "Worker shutdown requested before execution.");
    }

    let run = await this.#db.createRun({
      taskId: task.id,
      routeStepId: step.id,
      agent: step.agent,
      role: step.role,
    });
    this.#runPhases.set(run.id, { taskId: task.id, phase: "starting" });
    await this.#db.updateRouteStep(step.id, { status: "running", runId: run.id });
    run = await this.#db.updateRun(run.id, {
      status: "starting",
      startedAt: new Date().toISOString(),
    });
    await this.#publish({
      taskId: task.id,
      runId: run.id,
      type: "run.starting",
      message: `${step.agent} is starting the ${step.role} step.`,
    });

    let worktree = inheritedWorktree;
    let adapterRun: AdapterRun | null = null;
    let sourceSnapshot: SourceRepositorySnapshot | null = null;
    try {
      if (!worktree) {
        worktree = await this.#worktrees.create({
          taskId: task.id,
          runId: run.id,
          repo: task.repo,
          baseRef: task.baseRef,
        });
      }
      if (this.#shutdownRequested) {
        throw new Error("Worker shutdown requested before agent start.");
      }
      const workingDirectory = worktree.worktreePath;
      sourceSnapshot = await this.#worktrees.captureSourceSnapshot(
        worktree.sourceRepo,
      );
      run = await this.#db.updateRun(run.id, {
        worktreePath: worktree?.worktreePath ?? null,
        branch: worktree?.branch ?? null,
        baseCommit: worktree?.baseCommit ?? null,
      });
      const promptTask: TaskPayload = {
        id: task.id,
        goal: task.goal,
        repo: workingDirectory,
        baseRef: task.baseRef,
        agent: task.agent,
        priority: task.priority,
        ...(task.context ? { context: task.context } : {}),
        successCriteria: task.successCriteria,
        ...(task.verificationCommand
          ? { verificationCommand: task.verificationCommand }
          : {}),
        handoffRequired: task.handoffRequired,
      };
      const prompt = buildAgentPrompt({ task: promptTask, role: step.role, priorResults });
      const artifactDir = await this.#artifacts.prepareRunDirectory(task.id, run.id);
      const promptArtifact = await this.#artifacts.writeText({
        taskId: task.id,
        runId: run.id,
        kind: "prompt",
        name: "prompt.md",
        data: prompt,
      });
      await this.#db.addArtifact({
        ...promptArtifact,
        metadata: { agent: step.agent, role: step.role },
      });
      if (this.#stopRequestedRuns.delete(run.id)) {
        throw new Error("Operator requested cancellation before agent start.");
      }
      let persistedAdapterRun: AdapterRun | null = null;
      let startPersistence: Promise<void> | null = null;
      const persistAdapterStart = async (started: AdapterRun): Promise<void> => {
        if (persistedAdapterRun) {
          if (
            persistedAdapterRun.id !== started.id ||
            persistedAdapterRun.pid !== started.pid
          ) {
            throw new Error("Adapter reported conflicting process-start evidence");
          }
          return;
        }
        if (startPersistence) return await startPersistence;
        startPersistence = (async () => {
          run = await this.#db.updateRun(run.id, {
            status: "running",
            adapterRunId: started.id,
            pid: started.pid,
            stdoutPath: started.stdoutPath,
            stderrPath: started.stderrPath,
            resultPath: started.resultPath,
          });
          await this.#publish({
            taskId: task.id,
            runId: run.id,
            type: "run.started",
            message: `${step.agent} started ${step.role}.`,
            data: { pid: started.pid, worktreePath: workingDirectory },
          });
          persistedAdapterRun = started;
        })();
        return await startPersistence;
      };
      adapterRun = await adapter.startTask({
        task: promptTask,
        role: step.role,
        prompt,
        workingDirectory,
        artifactDir,
        env: { [CONTROL_RUN_TOKEN_ENV]: run.id },
        onStarted: persistAdapterStart,
      });
      // Third-party adapters may not yet implement the callback. Preserve
      // compatibility while built-in local adapters close the crash window.
      await persistAdapterStart(adapterRun);
      this.#activeRuns.set(run.id, {
        taskId: task.id,
        dbRunId: run.id,
        adapterRunId: adapterRun.id,
        adapter,
      });
      this.#runPhases.set(run.id, { taskId: task.id, phase: "active" });
      if (this.#stopRequestedRuns.delete(run.id)) {
        await adapter.stop(adapterRun.id);
        this.#activeRuns.delete(run.id);
      }
      if (this.#shutdownRequested) {
        throw new Error("Worker shutdown requested while agent was starting.");
      }

      const result = await adapter.collectResult(adapterRun.id);
      this.#activeRuns.delete(run.id);
      this.#runPhases.set(run.id, { taskId: task.id, phase: "finalizing" });
      if (sourceSnapshot) {
        await this.#worktrees.assertSourceUnchanged(sourceSnapshot);
      }
      // A terminal run is not durable until its audit evidence is durable. Keep
      // the run in `running` while logs and Git state are copied and hashed so a
      // storage failure cannot leave a misleading `succeeded` record.
      await this.#ingestAdapterArtifacts(task.id, run.id, result);
      if (
        result.status === "succeeded" &&
        step.role === "execute" &&
        task.verificationCommand
      ) {
        this.#runPhases.set(run.id, { taskId: task.id, phase: "verifying" });
        await this.#runVerification({
          taskId: task.id,
          runId: run.id,
          commandLine: task.verificationCommand,
          worktree,
        });
        this.#runPhases.set(run.id, { taskId: task.id, phase: "finalizing" });
      }
      if (worktree) {
        const captured = await this.#worktrees.captureReviewArtifacts({
          taskId: task.id,
          runId: run.id,
          worktreePath: worktree.worktreePath,
          baseCommit: worktree.baseCommit,
          store: this.#artifacts,
        });
        for (const artifact of Object.values(captured.artifacts)) {
          await this.#db.addArtifact(artifact);
        }
      }
      run = await this.#db.updateRun(run.id, {
        status: terminalRunStatus(result),
        exitCode: result.exitCode,
        signal: result.signal,
        summary: result.summary,
        error: result.error,
        ...(result.usage ? { usageJson: JSON.stringify(result.usage) } : {}),
        finishedAt: result.finishedAt,
      });
      const succeeded = result.status === "succeeded";
      await this.#db.updateRouteStep(step.id, {
        status: succeeded ? "succeeded" : "failed",
      });
      await this.#publish({
        taskId: task.id,
        runId: run.id,
        type: succeeded ? "run.succeeded" : "run.failed",
        level: succeeded ? "info" : "error",
        message: succeeded
          ? `${step.agent} completed ${step.role}.`
          : result.error || `${step.agent} failed ${step.role}.`,
      });
      this.#runPhases.delete(run.id);
      this.#stopRequestedRuns.delete(run.id);
      return {
        step: {
          ...step,
          status: succeeded ? "succeeded" : "failed",
          runId: run.id,
        },
        run,
        result,
        worktree,
        succeeded,
        skipped: false,
        error: result.error,
      };
    } catch (error) {
      const active = this.#activeRuns.get(run.id);
      if (active) {
        await active.adapter.stop(active.adapterRunId).catch(() => undefined);
        this.#activeRuns.delete(run.id);
      }
      this.#runPhases.set(run.id, { taskId: task.id, phase: "finalizing" });
      let message = error instanceof Error ? error.message : String(error);
      if (sourceSnapshot) {
        try {
          await this.#worktrees.assertSourceUnchanged(sourceSnapshot);
        } catch (isolationError) {
          const isolationMessage =
            isolationError instanceof Error
              ? isolationError.message
              : String(isolationError);
          if (!message.includes(isolationMessage)) {
            message = `${message}\n${isolationMessage}`;
          }
        }
      }
      let evidenceError: string | null = null;
      if (adapterRun) {
        try {
          await this.#ingestAdapterArtifacts(task.id, run.id, adapterRun);
        } catch (captureError) {
          evidenceError =
            captureError instanceof Error ? captureError.message : String(captureError);
        }
      }
      const current = await this.#db.getRun(run.id);
      if (current && current.status !== "failed") {
        if (current.status === "starting" || current.status === "running") {
          run = await this.#db.updateRun(run.id, {
            status: "failed",
            error: message,
            finishedAt: new Date().toISOString(),
          });
        }
      }
      await this.#db.updateRouteStep(step.id, { status: "failed" });
      if (worktree) {
        try {
          const captured = await this.#worktrees.captureReviewArtifacts({
            taskId: task.id,
            runId: run.id,
            worktreePath: worktree.worktreePath,
            baseCommit: worktree.baseCommit,
            store: this.#artifacts,
          });
          for (const artifact of Object.values(captured.artifacts)) {
            await this.#db.addArtifact(artifact);
          }
        } catch {
          // Preserve the original execution failure; capture is best-effort here.
        }
      }
      await this.#publish({
        taskId: task.id,
        runId: run.id,
        type: "run.failed",
        level: "error",
        message,
      });
      if (evidenceError) {
        await this.#publish({
          taskId: task.id,
          runId: run.id,
          type: "artifact.capture_failed",
          level: "error",
          message: evidenceError,
        });
      }
      this.#runPhases.delete(run.id);
      this.#stopRequestedRuns.delete(run.id);
      return {
        step: { ...step, status: "failed", runId: run.id },
        run,
        result: null,
        worktree,
        succeeded: false,
        skipped: false,
        error: message,
      };
    }
  }

  async #unavailableStep(step: RouteStepRecord, message: string): Promise<StepOutcome> {
    if (!step.required) {
      await this.#db.updateRouteStep(step.id, { status: "skipped" });
      await this.#publish({
        taskId: step.taskId,
        type: "route.step_skipped",
        level: "warn",
        message,
        data: { agent: step.agent, role: step.role },
      });
      return {
        step: { ...step, status: "skipped" },
        run: null,
        result: null,
        worktree: null,
        succeeded: true,
        skipped: true,
        error: null,
      };
    }
    await this.#db.updateRouteStep(step.id, { status: "failed" });
    await this.#publish({
      taskId: step.taskId,
      type: "route.step_failed",
      level: "error",
      message,
      data: { agent: step.agent, role: step.role },
    });
    return {
      step: { ...step, status: "failed" },
      run: null,
      result: null,
      worktree: null,
      succeeded: false,
      skipped: false,
      error: message,
    };
  }

  #throwControlPhase(runId: string, status: RunStatus): never {
    const phase = this.#runPhases.get(runId)?.phase;
    if (phase === "starting") {
      throw new RunControlError("run_starting", `Run ${runId} is still starting`);
    }
    if (phase === "verifying" || phase === "finalizing") {
      throw new RunControlError("run_finalizing", `Run ${runId} is finalizing evidence`);
    }
    if (["succeeded", "failed", "stopped", "stale"].includes(status)) {
      throw new RunControlError("run_terminal", `Run ${runId} is already ${status}`);
    }
    throw new RunControlError(
      "run_not_owned",
      `This supervisor does not own live run ${runId}`,
    );
  }

  async #blockForShutdown(
    taskId: string,
    outcomes: StepOutcome[],
  ): Promise<RunTaskResult> {
    let message = "Worker shutdown interrupted task execution; retry is explicit.";
    let handoffPath: string | null = null;
    try {
      handoffPath = await this.#writeHandoff(taskId, "blocked", message);
    } catch (error) {
      message = `${message} Could not persist handoff evidence: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    const aggregate = await this.#db.getTask(taskId);
    if (aggregate?.task.status === "running") {
      await this.#db.updateTaskStatus(taskId, "blocked", message);
    }
    await this.#publish({
      taskId,
      type: "task.blocked",
      level: "warn",
      message,
    });
    return { taskId, status: "blocked", handoffPath, outcomes };
  }

  async #ingestAdapterArtifacts(
    taskId: string,
    runId: string,
    result: Pick<AdapterResult, "stdoutPath" | "stderrPath" | "resultPath">,
  ): Promise<void> {
    const runDirectory = await this.#artifacts.prepareRunDirectory(taskId, runId);
    const files = [
      { path: result.stdoutPath, kind: "stdout" as const },
      { path: result.stderrPath, kind: "stderr" as const },
      { path: result.resultPath, kind: "result" as const },
    ];
    for (const file of files) {
      // These three files are the minimum audit envelope promised by every
      // adapter. Missing evidence is an execution failure, not a silent skip.
      const resolvedPath = resolve(file.path);
      if (dirname(resolvedPath) !== runDirectory) {
        throw new Error(`Adapter artifact escaped its run directory: ${file.path}`);
      }
      const info = await lstat(resolvedPath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Adapter artifact is not a regular file: ${file.path}`);
      }
      if (info.size > this.#maxAdapterArtifactBytes) {
        throw new Error(
          `Adapter artifact ${basename(file.path)} exceeded ${this.#maxAdapterArtifactBytes} bytes`,
        );
      }
      const data = await readFile(file.path);
      const artifact = await this.#artifacts.write({
        taskId,
        runId,
        kind: file.kind,
        name: basename(file.path),
        data,
      });
      await this.#db.addArtifact(artifact);
    }
  }

  async #runVerification(input: {
    taskId: string;
    runId: string;
    commandLine: string;
    worktree: WorktreeInfo;
  }): Promise<VerificationResult> {
    const before = await this.#worktrees.capture(
      input.worktree.worktreePath,
      input.worktree.baseCommit,
    );
    this.#activeVerifications.set(input.runId, input.taskId);
    await this.#publish({
      taskId: input.taskId,
      runId: input.runId,
      type: "verification.started",
      message: "Independent verification started in the isolated worktree.",
      data: { commandLine: input.commandLine },
    });
    let result: VerificationResult;
    try {
      result = await this.#verifier.run({
        taskId: input.taskId,
        runId: input.runId,
        commandLine: input.commandLine,
        workingDirectory: input.worktree.worktreePath,
        onStarted: async ({ pid, startedAt }) => {
          await this.#publish({
            taskId: input.taskId,
            runId: input.runId,
            type: "verification.process_started",
            message: "Independent verifier process started.",
            data: { pid, startedAt },
          });
        },
      });
    } finally {
      this.#activeVerifications.delete(input.runId);
    }
    await this.#db.addArtifact({
      ...result.artifact,
      metadata: {
        command: result.command,
        args: result.args,
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        error: result.error,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      },
    });
    const after = await this.#worktrees.capture(
      input.worktree.worktreePath,
      input.worktree.baseCommit,
    );
    const mutated =
      before.head !== after.head ||
      before.status !== after.status ||
      before.diff !== after.diff;
    if (mutated) {
      await this.#publish({
        taskId: input.taskId,
        runId: input.runId,
        type: "verification.failed",
        level: "error",
        message: "Verification modified tracked or untracked repository state.",
      });
      throw new Error("Independent verification modified repository state");
    }
    const succeeded = result.status === "succeeded";
    await this.#publish({
      taskId: input.taskId,
      runId: input.runId,
      type: succeeded ? "verification.succeeded" : "verification.failed",
      level: succeeded ? "info" : "error",
      message: succeeded
        ? `Verification passed: ${result.command}.`
        : result.error ?? `Verification ended with ${result.status}.`,
      data: { exitCode: result.exitCode, signal: result.signal },
    });
    if (!succeeded) {
      throw new Error(
        result.error ??
          `Independent verification ${result.status} with exit ${result.exitCode ?? "n/a"}`,
      );
    }
    return result;
  }

  async #writeHandoff(
    taskId: string,
    status: "done" | "needs-review" | "blocked",
    blockedReason?: string,
  ): Promise<string | null> {
    const aggregate = await this.#db.getTask(taskId);
    if (!aggregate) return null;
    const latestRun = [...aggregate.runs].reverse()[0];
    if (!latestRun) return null;
    const body = [
      `# Handoff: ${aggregate.task.goal}`,
      "",
      `Task: ${aggregate.task.id}`,
      `Status: ${status}`,
      `Repository: ${aggregate.task.repo}`,
      `Route: ${aggregate.task.routePlan.steps.map((step) => `${step.agent}:${step.role}`).join(" -> ")}`,
      "",
      "## Success criteria",
      ...(aggregate.task.successCriteria.length
        ? aggregate.task.successCriteria.map((item) => `- ${item}`)
        : ["- No explicit criteria supplied."]),
      "",
      "## Runs",
      ...aggregate.runs.flatMap((run) => [
        `### ${run.agent} ${run.role} — ${run.status}`,
        `- Run: ${run.id}`,
        `- Worktree: ${run.worktreePath ?? "n/a"}`,
        `- Branch: ${run.branch ?? "n/a"}`,
        `- Exit: ${run.exitCode ?? "n/a"}`,
        `- Summary: ${run.summary?.trim() || run.error?.trim() || "No summary."}`,
        "",
      ]),
      "## Artifacts",
      ...aggregate.artifacts.map(
        (artifact) => `- ${artifact.kind}: ${artifact.path} (${artifact.sizeBytes} bytes)`,
      ),
      "",
      status === "needs-review"
        ? "Decision required: APPROVE or REWORK."
        : status === "blocked"
          ? `Blocked: ${blockedReason ?? aggregate.task.latestUpdate}`
          : "All required steps completed; no handoff approval was requested.",
      "",
    ].join("\n");
    const artifact = await this.#artifacts.writeText({
      taskId,
      runId: latestRun.id,
      kind: "handoff",
      name: "handoff.md",
      data: body,
    });
    await this.#db.addArtifact(artifact);
    return artifact.path;
  }

  async #publish(input: {
    taskId: string;
    runId?: string;
    type: string;
    level?: EventLevel;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const event = await this.#db.appendEvent(input);
    await this.#bus.publish({
      id: event.id,
      taskId: event.taskId,
      ...(event.runId ? { runId: event.runId } : {}),
      type: event.type,
      level: event.level,
      message: event.message,
      ...(event.data ? { data: event.data } : {}),
      createdAt: event.createdAt,
    });
  }
}
