import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { startControlCenterDaemon, type DaemonHandle } from "../src/daemon.js";
import { DAEMON_LEASE_FILENAME } from "../src/daemon-lease.js";
import { ControlCenterDb, type EventRecord } from "../src/db.js";
import { InProcessMessageBus } from "../src/message-bus.js";
import type { AgentKind } from "../src/protocol.js";
import type { ControlCenterRuntime } from "../src/runtime.js";
import { WorktreeManager } from "../src/worktrees.js";

const TEST_TOKEN = "t".repeat(43);

class BlockingAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly messages: string[] = [];
  readonly started: Promise<void>;
  #resolveStarted!: () => void;
  #resolveResult!: (result: AdapterResult) => void;
  #result: Promise<AdapterResult> | null = null;
  #run: AdapterRun | null = null;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#resolveStarted = resolve;
    });
  }

  async availability(): Promise<AdapterAvailability> {
    return { available: true, target: "fake:blocking", version: "test", reason: null };
  }

  async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    const stdoutPath = join(request.artifactDir, "codex.stdout.log");
    const stderrPath = join(request.artifactDir, "codex.stderr.log");
    const resultPath = join(request.artifactDir, "codex.result.txt");
    await writeFile(stdoutPath, "running\n", "utf8");
    await writeFile(stderrPath, "", "utf8");
    await writeFile(resultPath, "waiting for operator\n", "utf8");
    await writeFile(join(request.workingDirectory, "candidate.txt"), "change\n", "utf8");
    this.#run = {
      id: "adapter_blocking",
      taskId: request.task.id!,
      agent: "codex",
      role: request.role ?? "execute",
      status: "running",
      startedAt: new Date().toISOString(),
      pid: null,
      workingDirectory: request.workingDirectory,
      stdoutPath,
      stderrPath,
      resultPath,
    };
    this.#result = new Promise((resolve) => {
      this.#resolveResult = resolve;
    });
    this.#resolveStarted();
    return this.#run;
  }

  async postMessage(_runId: string, message: string): Promise<void> {
    this.messages.push(message);
  }

  async collectResult(): Promise<AdapterResult> {
    if (!this.#result) throw new Error("adapter has not started");
    return await this.#result;
  }

  async stop(): Promise<AdapterResult> {
    if (!this.#run || !this.#result) throw new Error("adapter has not started");
    const result: AdapterResult = {
      ...this.#run,
      status: "stopped",
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: "SIGTERM",
      summary: "stopped by operator",
      error: null,
    };
    this.#resolveResult(result);
    return result;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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

async function runtimeFixture(
  root: string,
  adapters = new Map<AgentKind, AgentAdapter>(),
): Promise<ControlCenterRuntime> {
  const home = join(root, "acc-home");
  const db = new ControlCenterDb(join(home, "control-center.sqlite"));
  await db.init();
  const artifacts = new ArtifactStore({ home });
  await artifacts.ensureRoot();
  const bus = new InProcessMessageBus();
  const coordinator = new Coordinator({
    db,
    artifacts,
    worktrees: new WorktreeManager({ home }),
    adapters,
    bus,
    workerId: "daemon-test",
    heartbeatIntervalMs: 1_000,
  });
  return {
    config: {
      homeDir: home,
      databasePath: join(home, "control-center.sqlite"),
      artifactsDir: join(home, "artifacts"),
      worktreesDir: join(home, "worktrees"),
      workerHeartbeatMs: 1_000,
      workerStaleAfterMs: 10_000,
    },
    db,
    adapters,
    coordinator,
    bus,
    recovery: null,
    recoverDeadWorker: async (workerId, recoveredBy = "daemon-test") => ({
      ...(await db.recoverTasksOwnedBy(workerId, recoveredBy)),
      processCleanup: [],
      remoteCleanup: [],
    }),
    close: async () => await db.close(),
  };
}

async function daemonFixture(
  t: test.TestContext,
  options: { maxJsonBytes?: number } = {},
): Promise<{ root: string; repo: string; runtime: ControlCenterRuntime; daemon: DaemonHandle }> {
  const root = await mkdtemp(join(tmpdir(), "acc-daemon-api-"));
  const repo = await createRepo(root);
  const runtime = await runtimeFixture(root);
  const daemon = await startControlCenterDaemon({
    runtime,
    host: "127.0.0.1",
    port: 0,
    token: TEST_TOKEN,
    enableWorker: false,
    ...(options.maxJsonBytes ? { maxJsonBytes: options.maxJsonBytes } : {}),
    logger: { info: () => undefined, error: () => undefined },
  });
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, runtime, daemon };
}

function authorized(
  daemon: DaemonHandle,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${daemon.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      ...init.headers,
    },
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("daemon immediately recovers fresh tasks owned by a reclaimed dead lease", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-daemon-dead-owner-"));
  const repo = await createRepo(root);
  const runtime = await runtimeFixture(root);
  const deadPid = 2_147_483_000;
  const deadWorker = `daemon:${deadPid}`;
  const created = await runtime.coordinator.createTask({
    id: "task_dead_daemon",
    goal: "Implement a small fix",
    repo,
    baseRef: "HEAD",
    agent: "codex",
    priority: "normal",
    successCriteria: [],
    handoffRequired: true,
  });
  const claimed = await runtime.db.claimNextTask(deadWorker);
  assert.equal(claimed?.task.id, created.task.id);
  const step = claimed!.routeSteps[0]!;
  const run = await runtime.db.createRun({
    taskId: created.task.id,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
  });
  await runtime.db.updateRouteStep(step.id, { status: "running", runId: run.id });
  await runtime.db.updateRun(run.id, {
    status: "starting",
    startedAt: new Date().toISOString(),
  });

  const leasePath = join(runtime.config.homeDir, DAEMON_LEASE_FILENAME);
  await writeFile(
    leasePath,
    `${JSON.stringify({
      version: 1,
      pid: deadPid,
      instanceToken: "d".repeat(43),
      acquiredAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  if (process.platform !== "win32") await chmod(leasePath, 0o600);

  const daemon = await startControlCenterDaemon({
    runtime,
    host: "127.0.0.1",
    port: 0,
    token: TEST_TOKEN,
    enableWorker: false,
    logger: { info: () => undefined, error: () => undefined },
  });
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  const recovered = await runtime.db.getTask(created.task.id);
  assert.equal(recovered?.task.status, "blocked");
  assert.equal(recovered?.runs[0]?.status, "failed");
  assert.ok(
    recovered?.events.some((event) => event.type === "task.dead_owner_recovered"),
  );
});

test("daemon enforces loopback bearer, Host, Origin, and JSON limits", async (t) => {
  const { daemon, repo } = await daemonFixture(t, { maxJsonBytes: 1024 });
  const missing = await fetch(`${daemon.url}/v1/health`);
  assert.equal(missing.status, 401);
  assert.equal((await json(missing)).error instanceof Object, true);

  const wrong = await fetch(`${daemon.url}/v1/health`, {
    headers: { Authorization: "Bearer wrong-token-value" },
  });
  assert.equal(wrong.status, 401);

  const healthy = await authorized(daemon, "/v1/health");
  assert.equal(healthy.status, 200);
  assert.equal(((await json(healthy)).data as { status: string }).status, "ready");

  const hostileOrigin = await authorized(daemon, "/v1/health", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(hostileOrigin.status, 403);

  const oversized = JSON.stringify({ goal: "x".repeat(2_000), repo, agent: "codex" });
  const tooLarge = await authorized(daemon, "/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "large-1" },
    body: oversized,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(((await json(tooLarge)).error as { code: string }).code, "payload_too_large");
});

test("task API is projected, mutation-idempotent, and replayable", async (t) => {
  const { daemon, repo } = await daemonFixture(t);
  const body = JSON.stringify({
    id: "task_api",
    goal: "Build a reliable API slice",
    repo,
    agent: "codex",
    handoffRequired: true,
  });
  const create = () =>
    authorized(daemon, "/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "create-task-api" },
      body,
    });
  const first = await create();
  assert.equal(first.status, 201);
  const firstBody = await json(first);
  assert.equal(((firstBody.data as { task: { id: string } }).task.id), "task_api");

  const replay = await create();
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");

  const conflict = await authorized(daemon, "/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "create-task-api" },
    body: JSON.stringify({ id: "task_other", goal: "Different", repo }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(((await json(conflict)).error as { code: string }).code, "idempotency_conflict");

  const list = await authorized(daemon, "/v1/tasks?status=queued");
  const tasks = ((await json(list)).data as { tasks: Array<{ id: string; nextAction: string }> }).tasks;
  assert.deepEqual(tasks.map((task) => task.id), ["task_api"]);
  assert.equal(tasks[0]?.nextAction, "execute");

  const detail = await authorized(daemon, "/v1/tasks/task_api");
  const detailText = await detail.text();
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detailText, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.doesNotMatch(detailText, /stdoutPath|worktreePath|adapterRunId/);
});

test("daemon accepts concurrent task mutations on its shared DB instance", async (t) => {
  const { daemon, repo, runtime } = await daemonFixture(t);
  const count = 20;
  const responses = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      authorized(daemon, "/v1/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `concurrent-create-${index}`,
        },
        body: JSON.stringify({
          id: `task_concurrent_api_${index}`,
          goal: `Create concurrent task ${index}`,
          repo,
          agent: "codex",
          handoffRequired: true,
        }),
      }),
    ),
  );

  assert.deepEqual(
    responses.map((response) => response.status),
    Array.from({ length: count }, () => 201),
  );
  assert.equal((await runtime.db.listTasks()).length, count);
});

async function readSseEvents(
  response: Response,
  count: number,
  abort: AbortController,
): Promise<EventRecord[]> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: EventRecord[] = [];
  let buffer = "";
  const timer = setTimeout(() => abort.abort(), 5_000);
  try {
    while (events.length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (data) events.push(JSON.parse(data) as EventRecord);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    abort.abort();
  }
  return events;
}

test("SSE streams durable IDs without replay/live gaps and resumes from cursor", async (t) => {
  const { daemon, repo } = await daemonFixture(t);
  const firstAbort = new AbortController();
  const stream = await authorized(daemon, "/v1/events?after=0", {
    signal: firstAbort.signal,
    headers: { Accept: "text/event-stream" },
  });
  assert.equal(stream.status, 200);

  const taskBody = JSON.stringify({ id: "task_sse_one", goal: "Stream one", repo });
  const created = await authorized(daemon, "/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "sse-create-one" },
    body: taskBody,
  });
  assert.equal(created.status, 201);
  const events = await readSseEvents(stream, 2, firstAbort);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["task.created", "route.decided"]);
  assert.ok(events[1]!.id > events[0]!.id);

  const cursor = events[1]!.id;
  const secondAbort = new AbortController();
  const resumed = await authorized(daemon, "/v1/events", {
    signal: secondAbort.signal,
    headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) },
  });
  const secondCreated = await authorized(daemon, "/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "sse-create-two" },
    body: JSON.stringify({ id: "task_sse_two", goal: "Stream two", repo }),
  });
  assert.equal(secondCreated.status, 201);
  const resumedEvents = await readSseEvents(resumed, 2, secondAbort);
  assert.equal(resumedEvents.length, 2);
  assert.ok(resumedEvents.every((event) => event.id > cursor));
  assert.deepEqual(resumedEvents.map((event) => event.taskId), ["task_sse_two", "task_sse_two"]);
});

test("screenshot upload and artifact content are validated by run ownership and hash", async (t) => {
  const { daemon, repo, runtime } = await daemonFixture(t);
  const created = await runtime.coordinator.createTask({
    id: "task_artifact_api",
    goal: "Attach browser evidence",
    repo,
    agent: "codex",
  });
  const claimed = await runtime.db.claimNextTask("daemon-test");
  assert.ok(claimed);
  const step = created.routeSteps[0]!;
  const run = await runtime.db.createRun({
    taskId: created.task.id,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const upload = await authorized(
    daemon,
    `/v1/tasks/${created.task.id}/runs/${run.id}/screenshots`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "upload-png" },
      body: JSON.stringify({
        name: "browser.png",
        contentType: "image/png",
        dataBase64: png.toString("base64"),
      }),
    },
  );
  assert.equal(upload.status, 201);
  const artifact = (await json(upload)).data as {
    id: string;
    contentUrl: string;
    sha256: string;
  };
  const identicalRetry = await authorized(
    daemon,
    `/v1/tasks/${created.task.id}/runs/${run.id}/screenshots`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "upload-png-identical",
      },
      body: JSON.stringify({
        name: "browser.png",
        contentType: "image/png",
        dataBase64: png.toString("base64"),
      }),
    },
  );
  assert.equal(identicalRetry.status, 201);
  assert.equal(
    ((await json(identicalRetry)).data as { id: string }).id,
    artifact.id,
  );

  const conflictingPng = Buffer.concat([png, Buffer.from([0x01])]);
  const conflictingUpload = await authorized(
    daemon,
    `/v1/tasks/${created.task.id}/runs/${run.id}/screenshots`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "upload-png-conflict",
      },
      body: JSON.stringify({
        name: "browser.png",
        contentType: "image/png",
        dataBase64: conflictingPng.toString("base64"),
      }),
    },
  );
  assert.equal(conflictingUpload.status, 409);

  const content = await authorized(daemon, artifact.contentUrl);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  assert.equal(
    artifact.sha256,
    createHash("sha256").update(png).digest("hex"),
  );
  const aggregate = await runtime.db.getTask(created.task.id);
  assert.equal(
    aggregate?.artifacts.filter((item) => item.kind === "screenshot").length,
    1,
  );
});

test("daemon owns live run messaging and cancellation end to end", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-daemon-live-"));
  const repo = await createRepo(root);
  const adapter = new BlockingAdapter();
  const runtime = await runtimeFixture(
    root,
    new Map<AgentKind, AgentAdapter>([["codex", adapter]]),
  );
  const daemon = await startControlCenterDaemon({
    runtime,
    port: 0,
    token: TEST_TOKEN,
    pollMs: 100,
    logger: { info: () => undefined, error: () => undefined },
  });
  t.after(async () => {
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
  });

  const create = await authorized(daemon, "/v1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "live-create" },
    body: JSON.stringify({
      id: "task_live_control",
      goal: "Keep running until the operator cancels",
      repo,
      agent: "codex",
      handoffRequired: false,
    }),
  });
  assert.equal(create.status, 201);
  await adapter.started;

  let runId: string | null = null;
  for (let attempt = 0; attempt < 50 && !runId; attempt += 1) {
    const detail = await authorized(daemon, "/v1/tasks/task_live_control");
    const data = (await json(detail)).data as {
      runs: Array<{ id: string; status: string }>;
    };
    runId = data.runs.find((run) => run.status === "running")?.id ?? null;
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(runId);

  const message = await authorized(daemon, `/v1/runs/${runId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "live-message" },
    body: JSON.stringify({ body: "Please stop after preserving evidence." }),
  });
  assert.equal(message.status, 202);
  assert.deepEqual(adapter.messages, ["Please stop after preserving evidence."]);

  const cancelRequest = () =>
    authorized(daemon, `/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "live-cancel" },
      body: "{}",
    });
  const cancelled = await cancelRequest();
  assert.equal(cancelled.status, 202);
  const replayed = await cancelRequest();
  assert.equal(replayed.status, 202);
  assert.equal(replayed.headers.get("idempotency-replayed"), "true");

  let finalStatus = "";
  for (let attempt = 0; attempt < 100 && finalStatus !== "blocked"; attempt += 1) {
    const detail = await authorized(daemon, "/v1/tasks/task_live_control");
    finalStatus = (((await json(detail)).data as { task: { status: string } }).task.status);
    if (finalStatus !== "blocked") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(finalStatus, "blocked");
  const aggregate = await runtime.db.getTask("task_live_control");
  assert.equal(aggregate?.runs[0]?.status, "stopped");
  assert.ok(aggregate?.artifacts.some((artifact) => artifact.kind === "handoff"));
});

test("review API targets an exact review revision and rejects stale decisions", async (t) => {
  const { daemon, repo, runtime } = await daemonFixture(t);
  const task = await runtime.coordinator.createTask({
    id: "task_review_api",
    goal: "Require an exact approval",
    repo,
    agent: "codex",
  });
  await runtime.db.claimNextTask("daemon-test");
  const review = await runtime.db.finalizeTaskExecution({
    taskId: task.task.id,
    status: "needs-review",
    latestUpdate: "Awaiting exact review.",
  });
  assert.ok(review);

  const stale = await authorized(daemon, `/v1/reviews/${review.id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "review-stale" },
    body: JSON.stringify({
      decision: "approved",
      expectedUpdatedAt: new Date(0).toISOString(),
      note: "stale browser",
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal(((await json(stale)).error as { code: string }).code, "state_conflict");
  assert.equal((await runtime.db.getReview(review.id))?.status, "pending");

  const approved = await authorized(daemon, `/v1/reviews/${review.id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "review-current" },
    body: JSON.stringify({
      decision: "approved",
      expectedUpdatedAt: review.updatedAt,
      note: "Evidence verified.",
    }),
  });
  assert.equal(approved.status, 200);
  assert.equal(
    (((await json(approved)).data as { task: { status: string } }).task.status),
    "done",
  );
});
