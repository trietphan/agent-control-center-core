import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AdapterAvailability,
  AdapterResult,
  AdapterRun,
  AdapterTaskRequest,
  AgentAdapter,
} from "../src/adapters/index.js";
import { ArtifactStore } from "../src/artifacts.js";
import { Coordinator } from "../src/coordinator.js";
import { ControlCenterDb } from "../src/db.js";
import type { AgentKind } from "../src/protocol.js";
import { WorktreeManager } from "../src/worktrees.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandLine(...argv: string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ");
}

async function createRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "--initial-branch=main", "."]);
  git(repo, ["config", "user.name", "ACC Test"]);
  git(repo, ["config", "user.email", "acc@example.com"]);
  await writeFile(join(repo, "README.md"), "# fixture\n", "utf8");
  git(repo, ["add", "--all"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  return repo;
}

class FakeAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  readonly available: boolean;
  readonly requests: AdapterTaskRequest[] = [];
  readonly #runs = new Map<string, { request: AdapterTaskRequest; run: AdapterRun }>();

  constructor(kind: AgentKind, available = true) {
    this.kind = kind;
    this.available = available;
  }

  async availability(): Promise<AdapterAvailability> {
    return {
      available: this.available,
      target: `fake:${this.kind}`,
      version: "test",
      reason: this.available ? null : "disabled in test",
    };
  }

  async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    this.requests.push(request);
    const id = `adapter_${randomUUID()}`;
    await mkdir(request.artifactDir, { recursive: true });
    const stdoutPath = join(request.artifactDir, `${this.kind}.stdout.log`);
    const stderrPath = join(request.artifactDir, `${this.kind}.stderr.log`);
    const resultPath = join(request.artifactDir, `${this.kind}.result.txt`);
    await writeFile(stdoutPath, `${this.kind} started\n`, "utf8");
    await writeFile(stderrPath, "", "utf8");
    await writeFile(resultPath, `${this.kind} ${request.role ?? "execute"} succeeded`, "utf8");
    if ((request.role ?? "execute") === "execute") {
      await writeFile(join(request.workingDirectory, `${this.kind}-change.txt`), "changed\n", "utf8");
    }
    const run: AdapterRun = {
      id,
      taskId: request.task.id ?? "unknown",
      agent: this.kind,
      role: request.role ?? "execute",
      status: "running",
      startedAt: new Date().toISOString(),
      pid: null,
      workingDirectory: request.workingDirectory,
      stdoutPath,
      stderrPath,
      resultPath,
    };
    this.#runs.set(id, { request, run });
    return run;
  }

  async postMessage(): Promise<void> {}

  async collectResult(runId: string): Promise<AdapterResult> {
    const state = this.#runs.get(runId);
    if (!state) throw new Error("run missing");
    return {
      ...state.run,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      signal: null,
      summary: `${this.kind} completed`,
      error: null,
    };
  }

  async stop(runId: string): Promise<AdapterResult> {
    const state = this.#runs.get(runId);
    if (!state) throw new Error("run missing");
    return {
      ...state.run,
      status: "stopped",
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: "SIGTERM",
      summary: "stopped",
      error: null,
    };
  }
}

class MissingEvidenceAdapter extends FakeAdapter {
  override async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    const run = await super.startTask(request);
    await rm(run.resultPath, { force: true });
    return run;
  }
}

class SlowStartAdapter extends FakeAdapter {
  readonly started: Promise<void>;
  stopCalls = 0;
  #resolveStarted!: () => void;
  #resolveRelease!: () => void;
  readonly #release: Promise<void>;

  constructor(kind: AgentKind) {
    super(kind);
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
    this.#release = new Promise((resolve) => {
      this.#resolveRelease = resolve;
    });
  }

  release(): void {
    this.#resolveRelease();
  }

  override async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    const run = await super.startTask(request);
    this.#resolveStarted();
    await this.#release;
    return run;
  }

  override async stop(runId: string): Promise<AdapterResult> {
    this.stopCalls += 1;
    return await super.stop(runId);
  }
}

class DurableStartBoundaryAdapter extends FakeAdapter {
  readonly persistedBeforeReturn: Promise<void>;
  #resolvePersisted!: () => void;
  #resolveRelease!: () => void;
  readonly #release: Promise<void>;

  constructor(kind: AgentKind) {
    super(kind);
    this.persistedBeforeReturn = new Promise((resolve) => {
      this.#resolvePersisted = resolve;
    });
    this.#release = new Promise((resolve) => {
      this.#resolveRelease = resolve;
    });
  }

  release(): void {
    this.#resolveRelease();
  }

  override async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    const run = { ...(await super.startTask(request)), pid: 424_242 };
    await request.onStarted?.(run);
    this.#resolvePersisted();
    await this.#release;
    return run;
  }
}

class SourceEscapingAdapter extends FakeAdapter {
  readonly #sourceRepo: string;

  constructor(kind: AgentKind, sourceRepo: string) {
    super(kind);
    this.#sourceRepo = sourceRepo;
  }

  override async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    assert.equal(request.task.repo, request.workingDirectory);
    const run = await super.startTask(request);
    await writeFile(join(this.#sourceRepo, "escaped.txt"), "must be detected\n", "utf8");
    return run;
  }
}

class ThrowingCollectAdapter extends FakeAdapter {
  override async collectResult(_runId: string): Promise<AdapterResult> {
    throw new Error("result transport failed after logs were written");
  }
}

async function fixture(t: test.TestContext, kinds: AgentKind[]) {
  const root = await mkdtemp(join(tmpdir(), "acc-coordinator-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = await createRepo(root);
  const home = join(root, "acc-home");
  const db = new ControlCenterDb(join(home, "control-center.sqlite"));
  await db.init();
  t.after(async () => await db.close());
  const adapters = new Map<AgentKind, AgentAdapter>(
    kinds.map((kind) => [kind, new FakeAdapter(kind)]),
  );
  const coordinator = new Coordinator({
    db,
    artifacts: new ArtifactStore({ home }),
    worktrees: new WorktreeManager({ home }),
    adapters,
    workerId: "test-worker",
  });
  return { root, repo, home, db, adapters, coordinator };
}

test("runs Codex in an isolated worktree and creates reviewable evidence", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["codex"]);
  const created = await coordinator.createTask({
    id: "task_vertical_slice",
    goal: "Fix the login bug",
    repo,
    agent: "codex",
    successCriteria: ["tests pass"],
    handoffRequired: true,
  });
  assert.equal(created.task.status, "queued");

  const result = await coordinator.runNext();
  assert.equal(result?.status, "needs-review");
  assert.ok(result?.handoffPath?.endsWith("handoff.md"));
  const task = await db.getTask(created.task.id);
  assert.equal(task?.task.status, "needs-review");
  assert.equal(task?.task.claimedBy, null);
  assert.equal(task?.task.claimedAt, null);
  assert.equal(task?.runs[0]?.status, "succeeded");
  assert.ok(task?.runs[0]?.worktreePath);
  assert.ok(task?.artifacts.some((artifact) => artifact.kind === "diff"));
  assert.ok(task?.artifacts.some((artifact) => artifact.kind === "prompt"));
  assert.ok(task?.artifacts.some((artifact) => artifact.kind === "commit"));
  assert.ok(task?.artifacts.some((artifact) => artifact.kind === "handoff"));
  assert.equal(task?.reviews[0]?.status, "pending");
  assert.equal(git(repo, ["status", "--porcelain=v1"]).trim(), "");

  await coordinator.approveTask(created.task.id, "Verified by reviewer.");
  assert.equal((await db.getTask(created.task.id))?.task.status, "done");
});

test("risky route runs Codex then Claude and degrades optional OpenClaw to human review", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["codex", "claude"]);
  const created = await coordinator.createTask({
    id: "task_risky_route",
    goal: "Implement a production authentication migration",
    repo,
    agent: "auto",
    priority: "urgent",
  });
  const result = await coordinator.runNext();
  assert.equal(result?.status, "needs-review");
  const task = await db.getTask(created.task.id);
  assert.deepEqual(task?.runs.map((run) => run.agent), ["codex", "claude"]);
  assert.deepEqual(task?.routeSteps.map((step) => step.status), [
    "succeeded",
    "succeeded",
    "skipped",
  ]);
  assert.ok(task?.events.some((event) => event.type === "route.step_skipped"));
});

test("risky route completes Codex, Claude, and OpenClaw before exact human review", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, [
    "codex",
    "claude",
    "openclaw",
  ]);
  const created = await coordinator.createTask({
    id: "task_full_risky_flow",
    goal: "Implement a production authentication security fix",
    repo,
    agent: "auto",
    priority: "urgent",
    successCriteria: ["tests pass", "no authentication regression"],
    handoffRequired: false,
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "needs-review");
  const task = await db.getTask(created.task.id);
  assert.deepEqual(task?.runs.map((run) => [run.agent, run.role, run.status]), [
    ["codex", "execute", "succeeded"],
    ["claude", "review", "succeeded"],
    ["openclaw", "approval", "succeeded"],
  ]);
  assert.deepEqual(task?.routeSteps.map((step) => step.status), [
    "succeeded",
    "succeeded",
    "succeeded",
  ]);
  assert.equal(new Set(task?.runs.map((run) => run.worktreePath)).size, 1);
  assert.equal(task?.reviews.length, 1);
  assert.equal(task?.reviews[0]?.status, "pending");

  const claude = adapters.get("claude") as FakeAdapter;
  const openclaw = adapters.get("openclaw") as FakeAdapter;
  assert.match(claude.requests[0]?.prompt ?? "", /Prior run 1[\s\S]*codex completed/u);
  assert.match(
    openclaw.requests[0]?.prompt ?? "",
    /Prior run 1[\s\S]*codex completed[\s\S]*Prior run 2[\s\S]*claude completed/u,
  );
  assert.match(openclaw.requests[0]?.prompt ?? "", /ask for APPROVE or REWORK/u);

  const handoff = task?.artifacts.find((artifact) => artifact.kind === "handoff");
  assert.ok(handoff);
  const handoffText = await readFile(handoff.path, "utf8");
  assert.match(handoffText, /codex execute — succeeded/u);
  assert.match(handoffText, /claude review — succeeded/u);
  assert.match(handoffText, /openclaw approval — succeeded/u);
  assert.match(handoffText, /Decision required: APPROVE or REWORK/u);

  await coordinator.approveTask(created.task.id, "All three agent stages reviewed.");
  assert.equal((await db.getTask(created.task.id))?.task.status, "done");
});

test("missing required adapter blocks the task with an explicit reason", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, []);
  const created = await coordinator.createTask({
    id: "task_missing_adapter",
    goal: "Fix API tests",
    repo,
    agent: "codex",
  });
  const result = await coordinator.runNext();
  assert.equal(result?.status, "blocked");
  const task = await db.getTask(created.task.id);
  assert.equal(task?.task.status, "blocked");
  assert.match(task?.task.latestUpdate ?? "", /not registered/);

  adapters.set("codex", new FakeAdapter("codex"));
  await coordinator.retryBlockedTask(
    created.task.id,
    "Adapter is configured; retry the failed step.",
  );
  assert.equal((await db.getTask(created.task.id))?.task.status, "queued");
  const retried = await coordinator.runNext();
  assert.equal(retried?.status, "needs-review");
  const afterRetry = await db.getTask(created.task.id);
  assert.equal(afterRetry?.routeSteps[0]?.status, "succeeded");
  assert.ok(
    afterRetry?.messages.some((message) => message.role === "operator"),
  );
});

test("does not persist success when the minimum audit envelope is missing", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, ["codex"]);
  adapters.set("codex", new MissingEvidenceAdapter("codex"));
  const created = await coordinator.createTask({
    id: "task_missing_evidence",
    goal: "Fix code with durable evidence",
    repo,
    agent: "codex",
    handoffRequired: false,
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "blocked");
  const task = await db.getTask(created.task.id);
  assert.equal(task?.task.status, "blocked");
  assert.equal(task?.runs[0]?.status, "failed");
  assert.equal(task?.routeSteps[0]?.status, "failed");
  assert.match(task?.runs[0]?.error ?? "", /ENOENT/);
});

test("rework preserves the implementation worktree and carries reviewer feedback", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["codex"]);
  const created = await coordinator.createTask({
    id: "task_rework",
    goal: "Fix a small code bug",
    repo,
    agent: "codex",
    handoffRequired: true,
  });
  await coordinator.runNext();
  const first = await db.getTask(created.task.id);
  const firstWorktree = first?.runs[0]?.worktreePath;
  assert.ok(firstWorktree);

  await coordinator.requestRework(created.task.id, "Add an explicit regression test.");
  assert.equal((await db.getTask(created.task.id))?.task.status, "queued");
  await coordinator.runNext();
  const second = await db.getTask(created.task.id);
  assert.equal(second?.task.status, "needs-review");
  assert.equal(second?.runs.length, 2);
  assert.equal(second?.runs[1]?.attempt, 2);
  assert.equal(second?.runs[1]?.worktreePath, firstWorktree);
  assert.ok(
    second?.messages.some((message) =>
      message.body.includes("explicit regression test"),
    ),
  );
});

test("a retry quarantines worktrees from heartbeat-expired runs", async (t) => {
  const { root, repo, db, coordinator } = await fixture(t, ["codex"]);
  const created = await coordinator.createTask({
    id: "task_stale_worktree",
    goal: "Fix a small code bug",
    repo,
    agent: "codex",
  });
  const claimed = await db.claimNextTask("crashed-worker");
  const step = claimed?.routeSteps[0];
  assert.ok(step);
  const stalePath = join(root, "quarantined-worktree");
  const priorRun = await db.createRun({
    taskId: created.task.id,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
    worktreePath: stalePath,
    branch: "acc/prior/run",
    baseCommit: git(repo, ["rev-parse", "HEAD"]).trim(),
  });
  await db.updateRun(priorRun.id, { status: "starting" });
  await db.updateRun(priorRun.id, { status: "running" });
  await db.updateRun(priorRun.id, { status: "succeeded" });
  const staleRun = await db.createRun({
    taskId: created.task.id,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
    worktreePath: stalePath,
    branch: "acc/stale/run",
    baseCommit: git(repo, ["rev-parse", "HEAD"]).trim(),
  });
  await db.updateRun(staleRun.id, { status: "starting" });
  await db.updateRun(staleRun.id, { status: "running" });
  await db.updateRouteStep(step.id, { status: "running", runId: staleRun.id });
  const cutoff = new Date(Date.parse(claimed!.task.claimedAt!) + 1).toISOString();
  await db.recoverStaleTasks(cutoff, "replacement-worker");

  await coordinator.retryBlockedTask(created.task.id, "Retry in a fresh worktree.");
  const result = await coordinator.runNext();
  assert.equal(result?.status, "needs-review");
  const aggregate = await db.getTask(created.task.id);
  assert.equal(aggregate?.runs[0]?.status, "succeeded");
  assert.equal(aggregate?.runs[1]?.status, "stale");
  assert.notEqual(aggregate?.runs[2]?.worktreePath, stalePath);
  assert.ok(aggregate?.runs[2]?.worktreePath?.includes("worktrees/task_stale_worktree"));
});

test("shutdown catches an agent that finishes starting after the signal", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, ["codex"]);
  const slow = new SlowStartAdapter("codex");
  adapters.set("codex", slow);
  const created = await coordinator.createTask({
    id: "task_shutdown_start_race",
    goal: "Fix a small code bug",
    repo,
    agent: "codex",
  });

  const execution = coordinator.runNext();
  await slow.started;
  await coordinator.requestShutdown();
  slow.release();
  const result = await execution;

  assert.equal(result?.status, "blocked");
  assert.equal(slow.stopCalls, 1);
  const aggregate = await db.getTask(created.task.id);
  assert.equal(aggregate?.task.status, "blocked");
  assert.equal(aggregate?.runs[0]?.status, "failed");
  assert.match(aggregate?.runs[0]?.error ?? "", /shutdown requested/);
});

test("adapter start evidence is durable before startTask returns", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, ["codex"]);
  const boundary = new DurableStartBoundaryAdapter("codex");
  adapters.set("codex", boundary);
  const created = await coordinator.createTask({
    id: "task_durable_start_boundary",
    goal: "Fix a small code bug",
    repo,
    agent: "codex",
    handoffRequired: false,
  });

  const execution = coordinator.runNext();
  await boundary.persistedBeforeReturn;
  const whileStartTaskIsBlocked = await db.getTask(created.task.id);
  assert.equal(whileStartTaskIsBlocked?.runs[0]?.status, "running");
  assert.equal(whileStartTaskIsBlocked?.runs[0]?.pid, 424_242);
  assert.ok(
    whileStartTaskIsBlocked?.events.some((event) => event.type === "run.started"),
  );

  boundary.release();
  const result = await execution;
  assert.equal(result?.status, "done");
});

test("the worktree path is authoritative and source-checkout mutation blocks success", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, ["codex"]);
  adapters.set("codex", new SourceEscapingAdapter("codex", repo));
  const created = await coordinator.createTask({
    id: "task_source_escape",
    goal: "Fix a small code bug",
    repo,
    agent: "codex",
    handoffRequired: false,
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "blocked");
  const aggregate = await db.getTask(created.task.id);
  assert.equal(aggregate?.runs[0]?.status, "failed");
  assert.match(aggregate?.runs[0]?.error ?? "", /Isolation violation/);
  assert.equal(aggregate?.task.repo, repo);
});

test("adapter exceptions still register the diagnostic evidence envelope", async (t) => {
  const { repo, db, adapters, coordinator } = await fixture(t, ["codex"]);
  adapters.set("codex", new ThrowingCollectAdapter("codex"));
  const created = await coordinator.createTask({
    id: "task_collect_exception",
    goal: "Fix a small code bug",
    repo,
    agent: "codex",
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "blocked");
  const aggregate = await db.getTask(created.task.id);
  assert.match(aggregate?.runs[0]?.error ?? "", /result transport failed/);
  for (const kind of ["stdout", "stderr", "result"] as const) {
    assert.ok(aggregate?.artifacts.some((artifact) => artifact.kind === kind));
  }
});

test("OpenClaw execution also receives an isolated worktree", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["openclaw"]);
  const created = await coordinator.createTask({
    id: "task_openclaw_isolated",
    goal: "Run an OpenClaw external automation",
    repo,
    agent: "openclaw",
    handoffRequired: false,
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "done");
  const aggregate = await db.getTask(created.task.id);
  assert.notEqual(aggregate?.runs[0]?.worktreePath, repo);
  assert.ok(aggregate?.artifacts.some((artifact) => artifact.kind === "diff"));
  assert.equal(git(repo, ["status", "--porcelain=v1"]).trim(), "");
});

test("independent verification gates route success and persists its log", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["codex"]);
  const created = await coordinator.createTask({
    id: "task_verification_pass",
    goal: "Make a verified change",
    repo,
    agent: "codex",
    verificationCommand: commandLine(
      process.execPath,
      "-e",
      "require('node:fs').accessSync('codex-change.txt'); console.log('verified')",
    ),
    handoffRequired: false,
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "done");
  const aggregate = await db.getTask(created.task.id);
  const testLog = aggregate?.artifacts.find((artifact) => artifact.kind === "test-log");
  assert.ok(testLog);
  assert.match(await readFile(testLog.path, "utf8"), /verified/);
  assert.ok(aggregate?.events.some((event) => event.type === "verification.succeeded"));
});

test("a failing independent verifier blocks an agent-reported success", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["codex"]);
  const created = await coordinator.createTask({
    id: "task_verification_fail",
    goal: "Do not trust the agent's success claim",
    repo,
    agent: "codex",
    verificationCommand: commandLine(process.execPath, "-e", "process.exit(9)"),
    handoffRequired: false,
  });

  const result = await coordinator.runNext();
  assert.equal(result?.status, "blocked");
  const aggregate = await db.getTask(created.task.id);
  assert.equal(aggregate?.task.status, "blocked");
  assert.equal(aggregate?.runs[0]?.status, "failed");
  assert.equal(aggregate?.routeSteps[0]?.status, "failed");
  assert.ok(aggregate?.artifacts.some((artifact) => artifact.kind === "test-log"));
  assert.ok(aggregate?.events.some((event) => event.type === "verification.failed"));
});

test("screenshots are attached only to their owning run with validated bytes", async (t) => {
  const { repo, db, coordinator } = await fixture(t, ["codex"]);
  const created = await coordinator.createTask({
    id: "task_screenshot",
    goal: "Capture visual evidence",
    repo,
    agent: "codex",
    handoffRequired: false,
  });
  await coordinator.runNext();
  const run = (await db.getTask(created.task.id))?.runs[0];
  assert.ok(run);
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  const artifact = await coordinator.attachScreenshot({
    taskId: created.task.id,
    runId: run.id,
    name: "browser.png",
    contentType: "image/png",
    data: png,
    metadata: { source: "browser" },
  });
  assert.equal(artifact.kind, "screenshot");
  assert.equal(artifact.metadata?.contentType, "image/png");
  const identicalRetry = await coordinator.attachScreenshot({
    taskId: created.task.id,
    runId: run.id,
    name: "browser.png",
    contentType: "image/png",
    data: png,
    metadata: { source: "browser" },
  });
  assert.equal(identicalRetry.id, artifact.id);
  const conflictingPng = Buffer.concat([png, Buffer.from([0x01])]);
  await assert.rejects(
    coordinator.attachScreenshot({
      taskId: created.task.id,
      runId: run.id,
      name: "browser.png",
      contentType: "image/png",
      data: conflictingPng,
      metadata: { source: "browser" },
    }),
    /must be identical/,
  );
  assert.deepEqual(await readFile(artifact.path), png);
  assert.equal(
    (await db.getTask(created.task.id))?.artifacts.filter(
      (item) => item.kind === "screenshot" && item.path === artifact.path,
    ).length,
    1,
  );
  await assert.rejects(
    coordinator.attachScreenshot({
      taskId: created.task.id,
      runId: run.id,
      name: "fake.png",
      contentType: "image/png",
      data: Buffer.from("not a png"),
    }),
    /do not match/,
  );
  await assert.rejects(
    coordinator.attachScreenshot({
      taskId: "another_task",
      runId: run.id,
      name: "browser.png",
      contentType: "image/png",
      data: png,
    }),
    /does not belong/,
  );
});
