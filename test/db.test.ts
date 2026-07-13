import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlCenterDb } from "../src/db.js";
import { TaskPayloadSchema } from "../src/protocol.js";
import { routeTask } from "../src/router.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "acc-db-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const filename = join(root, "control-center.sqlite");
  const db = new ControlCenterDb(filename);
  await db.init();
  t.after(async () => await db.close());
  return { root, filename, db };
}

function payload(id: string) {
  return TaskPayloadSchema.parse({
    id,
    goal: "Fix the login bug",
    repo: "/tmp/example-repo",
    agent: "auto",
    priority: "high",
    successCriteria: ["tests pass", "no regression"],
  });
}

test("persists normalized task, route, run, event, artifact, message, and review", async (t) => {
  const { root, db } = await fixture(t);
  const taskInput = payload("task_db_flow");
  const created = await db.createTask(taskInput, routeTask(taskInput));
  assert.equal(created.task.status, "queued");
  assert.equal(created.task.routePlan.steps[0]?.agent, "codex");
  assert.equal(created.events[0]?.type, "task.created");

  const claimed = await db.claimNextTask("test-worker");
  assert.equal(claimed?.task.id, taskInput.id);
  assert.equal(claimed?.task.status, "running");
  assert.equal(claimed?.task.claimedBy, "test-worker");

  const routeStep = claimed?.routeSteps[0];
  assert.ok(routeStep);
  const run = await db.createRun({
    taskId: taskInput.id!,
    routeStepId: routeStep.id,
    agent: routeStep.agent,
    role: routeStep.role,
    worktreePath: join(root, "worktree"),
  });
  await db.updateRouteStep(routeStep.id, { status: "running", runId: run.id });
  await db.updateRun(run.id, { status: "starting" });
  await db.updateRun(run.id, {
    status: "running",
    adapterRunId: "adapter_1",
    pid: 123,
    startedAt: new Date().toISOString(),
  });
  const finished = await db.updateRun(run.id, {
    status: "succeeded",
    exitCode: 0,
    summary: "Implemented and verified.",
    finishedAt: new Date().toISOString(),
  });
  assert.equal(finished.attempt, 1);
  assert.equal(finished.exitCode, 0);

  const artifactPath = join(root, "result.md");
  const artifact = await db.addArtifact({
    taskId: taskInput.id!,
    runId: run.id,
    kind: "result",
    name: "result.md",
    path: artifactPath,
    relativePath: "artifacts/result.md",
    metadataPath: `${artifactPath}.metadata.json`,
    sha256: "a".repeat(64),
    sizeBytes: 42,
    createdAt: new Date().toISOString(),
  });
  assert.equal(artifact.kind, "result");
  assert.deepEqual(await db.getArtifact(artifact.id), artifact);
  assert.equal(await db.getArtifact("artifact_missing"), null);

  const message = await db.addMessage({
    taskId: taskInput.id!,
    runId: run.id,
    direction: "user-to-agent",
    role: "user",
    body: "Please include the regression test.",
  });
  assert.equal(message.deliveryStatus, "queued");

  const review = await db.createReview({ taskId: taskInput.id!, runId: run.id });
  const decided = await db.decideReview(review.id, "approved", "Evidence looks good.");
  assert.equal(decided.status, "approved");
  await assert.rejects(
    db.decideReview(review.id, "rework_requested"),
    /already decided/,
  );

  await db.updateRouteStep(routeStep.id, { status: "succeeded" });
  await db.updateTaskStatus(taskInput.id!, "needs-review", "Evidence is ready.");
  const loaded = await db.getTask(taskInput.id!);
  assert.equal(loaded?.runs[0]?.summary, "Implemented and verified.");
  assert.equal(loaded?.artifacts.length, 1);
  assert.equal(loaded?.messages.length, 1);
  assert.equal(loaded?.reviews[0]?.status, "approved");
});

test("artifact rows reject conflicting evidence and reuse identical retries", async (t) => {
  const { root, db } = await fixture(t);
  const taskInput = payload("task_db_artifact_immutable");
  const created = await db.createTask(taskInput, routeTask(taskInput));
  const claimed = await db.claimNextTask("artifact-worker");
  assert.ok(claimed);
  const routeStep = created.routeSteps[0]!;
  const run = await db.createRun({
    taskId: taskInput.id!,
    routeStepId: routeStep.id,
    agent: routeStep.agent,
    role: routeStep.role,
  });
  const artifactPath = join(root, "immutable-result.md");
  const input = {
    taskId: taskInput.id!,
    runId: run.id,
    kind: "result" as const,
    name: "immutable-result.md",
    path: artifactPath,
    relativePath: "artifacts/immutable-result.md",
    metadataPath: `${artifactPath}.metadata.json`,
    sha256: "a".repeat(64),
    sizeBytes: 42,
    createdAt: new Date().toISOString(),
    metadata: { source: "adapter" },
  };

  const first = await db.addArtifact(input);
  const retry = await db.addArtifact({
    ...input,
    createdAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.deepEqual(retry, first);

  await assert.rejects(
    db.addArtifact({ ...input, sha256: "b".repeat(64) }),
    /must be identical/,
  );
  await assert.rejects(
    db.addArtifact({ ...input, metadata: { source: "different" } }),
    /must be identical/,
  );
  assert.deepEqual(await db.getArtifact(first.id), first);
});

test("BEGIN IMMEDIATE claim prevents two workers from claiming one task", async (t) => {
  const { filename, db: first } = await fixture(t);
  const second = new ControlCenterDb(filename);
  await second.init();
  t.after(async () => await second.close());

  const taskInput = payload("task_claim_once");
  await first.createTask(taskInput, routeTask(taskInput));
  const claims = await Promise.all([
    first.claimNextTask("worker-a"),
    second.claimNextTask("worker-b"),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean)?.task.id, taskInput.id);
  const stored = await first.getTask(taskInput.id!);
  assert.ok(["worker-a", "worker-b"].includes(stored?.task.claimedBy ?? ""));
});

test("one DB instance serializes concurrent transactions and writes while serving reads", async (t) => {
  const { db } = await fixture(t);
  const taskInputs = Array.from({ length: 20 }, (_, index) =>
    payload(`task_same_connection_${index}`),
  );

  const taskCreates = taskInputs.map(async (taskInput) =>
    await db.createTask(taskInput, routeTask(taskInput)),
  );
  const ordinaryWrites = Array.from({ length: 20 }, (_, index) =>
    db.claimIdempotencyKey(`same-connection:${index}`, `hash_${index}`),
  );
  const ordinaryReads = Array.from({ length: 20 }, () => db.listTasks());

  const [created, claims] = await Promise.all([
    Promise.all(taskCreates),
    Promise.all(ordinaryWrites),
    Promise.all(ordinaryReads),
  ]).then(([taskResults, claimResults]) => [taskResults, claimResults] as const);

  assert.equal(created.length, taskInputs.length);
  assert.ok(claims.every((claim) => claim.kind === "new"));
  assert.deepEqual(
    new Set((await db.listTasks()).map((taskRecord) => taskRecord.id)),
    new Set(taskInputs.map((taskInput) => taskInput.id!)),
  );
  for (let index = 0; index < ordinaryWrites.length; index += 1) {
    assert.equal(
      (await db.claimIdempotencyKey(
        `same-connection:${index}`,
        `hash_${index}`,
      )).kind,
      "pending",
    );
  }
});

test("restricts the database directory and SQLite files to the current user", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not portable to Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "acc-db-permissions-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o777 });
  await chmod(stateDir, 0o777);
  const filename = join(stateDir, "control-center.sqlite");
  const db = new ControlCenterDb(filename);
  await db.init();
  t.after(async () => await db.close());

  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, path);
  }
});

test("review approval and rework apply all state changes atomically", async (t) => {
  const { filename, db: first } = await fixture(t);
  const second = new ControlCenterDb(filename);
  await second.init();
  t.after(async () => await second.close());

  const approvalInput = payload("task_atomic_approval");
  await first.createTask(approvalInput, routeTask(approvalInput));
  await first.claimNextTask("approval-worker");
  const approvalReview = await first.finalizeTaskExecution({
    taskId: approvalInput.id!,
    status: "needs-review",
    latestUpdate: "Waiting for approval.",
  });
  assert.ok(approvalReview);
  const approvals = await Promise.allSettled([
    first.approveTaskReview(approvalInput.id!, "Approved with evidence."),
    second.approveTaskReview(approvalInput.id!, "Duplicate approval."),
  ]);
  assert.equal(approvals.filter((item) => item.status === "fulfilled").length, 1);
  const approved = await first.getTask(approvalInput.id!);
  assert.equal(approved?.task.status, "done");
  assert.equal(approved?.task.claimedBy, null);
  assert.equal(approved?.reviews.find((item) => item.id === approvalReview.id)?.status, "approved");

  const reworkInput = payload("task_atomic_rework");
  await first.createTask(reworkInput, routeTask(reworkInput));
  const reworkClaim = await first.claimNextTask("rework-worker");
  const step = reworkClaim?.routeSteps[0];
  assert.ok(step);
  const run = await first.createRun({
    taskId: reworkInput.id!,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
  });
  await first.updateRouteStep(step.id, { status: "running", runId: run.id });
  const reworkReview = await first.finalizeTaskExecution({
    taskId: reworkInput.id!,
    status: "needs-review",
    latestUpdate: "Please review.",
    runId: run.id,
  });
  assert.ok(reworkReview);
  const rework = await first.requestTaskRework(
    reworkInput.id!,
    "Add a regression test.",
  );
  assert.equal(rework.review.id, reworkReview.id);
  assert.equal(rework.review.status, "rework_requested");
  assert.equal(rework.message.runId, run.id);
  assert.equal(rework.message.deliveryStatus, "queued");
  const requeued = await first.getTask(reworkInput.id!);
  assert.equal(requeued?.task.status, "queued");
  assert.equal(requeued?.task.claimedBy, null);
  assert.equal(requeued?.routeSteps[0]?.status, "pending");
  assert.equal(requeued?.routeSteps[0]?.runId, null);
  assert.equal(requeued?.messages.at(-1)?.body, "Add a regression test.");
});

test("exact review decisions reject stale UI revisions atomically", async (t) => {
  const { db } = await fixture(t);
  const taskInput = payload("task_exact_review");
  await db.createTask(taskInput, routeTask(taskInput));
  await db.claimNextTask("exact-review-worker");
  const review = await db.finalizeTaskExecution({
    taskId: taskInput.id!,
    status: "needs-review",
    latestUpdate: "Waiting for an exact decision.",
  });
  assert.ok(review);
  assert.deepEqual(await db.getReview(review.id), review);

  await assert.rejects(
    db.approveTaskReview(taskInput.id!, "stale", {
      reviewId: review.id,
      updatedAt: new Date(0).toISOString(),
    }),
    /changed concurrently/,
  );
  assert.equal((await db.getTask(taskInput.id!))?.task.status, "needs-review");
  assert.equal((await db.getReview(review.id))?.status, "pending");

  const approved = await db.approveTaskReview(taskInput.id!, "current", {
    reviewId: review.id,
    updatedAt: review.updatedAt,
  });
  assert.equal(approved.status, "approved");
  assert.equal((await db.getTask(taskInput.id!))?.task.status, "done");
});

test("compare-and-swap updates prevent competing task and run transitions", async (t) => {
  const { filename, db: first } = await fixture(t);
  const second = new ControlCenterDb(filename);
  await second.init();
  t.after(async () => await second.close());

  const taskInput = payload("task_cas_transitions");
  await first.createTask(taskInput, routeTask(taskInput));
  const claimed = await first.claimNextTask("cas-worker");
  const taskTransitions = await Promise.allSettled([
    first.updateTaskStatus(taskInput.id!, "blocked", "Blocked by first writer."),
    second.updateTaskStatus(taskInput.id!, "needs-review", "Ready from second writer."),
  ]);
  assert.equal(taskTransitions.filter((item) => item.status === "fulfilled").length, 1);
  assert.ok(["blocked", "needs-review"].includes((await first.getTask(taskInput.id!))!.task.status));

  const step = claimed?.routeSteps[0];
  assert.ok(step);
  const run = await first.createRun({
    taskId: taskInput.id!,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
  });
  await first.updateRun(run.id, { status: "starting" });
  await first.updateRun(run.id, { status: "running" });
  const runTransitions = await Promise.allSettled([
    first.updateRun(run.id, { status: "succeeded", exitCode: 0 }),
    second.updateRun(run.id, { status: "failed", error: "Concurrent failure" }),
  ]);
  assert.equal(runTransitions.filter((item) => item.status === "fulfilled").length, 1);
  assert.ok(["succeeded", "failed"].includes((await first.getRun(run.id))!.status));
});

test("heartbeats are owner-scoped and stale recovery closes execution state", async (t) => {
  const { db } = await fixture(t);
  const taskInput = payload("task_stale_recovery");
  await db.createTask(taskInput, routeTask(taskInput));
  const claimed = await db.claimNextTask("worker-owner");
  const step = claimed?.routeSteps[0];
  assert.ok(step);

  await assert.rejects(
    db.heartbeatTask(taskInput.id!, "worker-intruder"),
    /not running or is not claimed/,
  );
  const heartbeatAt = await db.heartbeatTask(taskInput.id!, "worker-owner");
  const stillFresh = await db.recoverStaleTasks(heartbeatAt, "recovery-worker");
  assert.deepEqual(stillFresh.taskIds, []);

  const startingRun = await db.createRun({
    taskId: taskInput.id!,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
  });
  await db.updateRun(startingRun.id, { status: "starting" });
  const runningRun = await db.createRun({
    taskId: taskInput.id!,
    routeStepId: step.id,
    agent: step.agent,
    role: step.role,
  });
  await db.updateRun(runningRun.id, { status: "starting" });
  await db.updateRun(runningRun.id, { status: "running", pid: 123 });
  await db.appendEvent({
    taskId: taskInput.id!,
    runId: runningRun.id,
    type: "verification.process_started",
    message: "Verifier started.",
    data: { pid: 456, startedAt: new Date().toISOString() },
  });
  const remoteRun = await db.createRun({
    taskId: taskInput.id!,
    routeStepId: step.id,
    agent: "openclaw",
    role: "execute",
  });
  await db.updateRun(remoteRun.id, { status: "starting" });
  await db.updateRun(remoteRun.id, {
    status: "running",
    adapterRunId: "remote_42",
  });
  await db.updateRouteStep(step.id, { status: "running", runId: runningRun.id });

  const cutoff = new Date(Date.parse(heartbeatAt) + 1).toISOString();
  const recovered = await db.recoverStaleTasks(cutoff, "recovery-worker");
  assert.deepEqual(recovered.taskIds, [taskInput.id!]);
  assert.deepEqual(
    [...recovered.staleRunIds].sort(),
    [runningRun.id, remoteRun.id].sort(),
  );
  assert.deepEqual(recovered.failedRunIds, [startingRun.id]);
  assert.deepEqual(recovered.processCandidates, [
    {
      taskId: taskInput.id!,
      runId: runningRun.id,
      pid: 456,
      agent: "verifier",
    },
  ]);
  assert.deepEqual(recovered.remoteCandidates, [
    {
      taskId: taskInput.id!,
      runId: remoteRun.id,
      remoteId: "remote_42",
      agent: "openclaw",
    },
  ]);
  const aggregate = await db.getTask(taskInput.id!);
  assert.equal(aggregate?.task.status, "blocked");
  assert.equal(aggregate?.task.claimedBy, null);
  assert.equal(aggregate?.task.claimedAt, null);
  assert.equal(aggregate?.routeSteps[0]?.status, "failed");
  assert.equal(aggregate?.runs.find((item) => item.id === startingRun.id)?.status, "failed");
  assert.equal(aggregate?.runs.find((item) => item.id === runningRun.id)?.status, "stale");
  assert.ok(aggregate?.events.some((event) => event.type === "run.stale"));
  assert.ok(aggregate?.events.some((event) => event.type === "run.failed"));
  assert.ok(aggregate?.events.some((event) => event.type === "task.stale_recovered"));
  await assert.rejects(
    db.retryBlockedTask(taskInput.id!, "Unsafe duplicate retry."),
    /unconfirmed remote OpenClaw work/,
  );
  await db.appendEvent({
    taskId: taskInput.id!,
    runId: remoteRun.id,
    type: "run.remote_cancellation_confirmed",
    message: "Remote stop confirmed.",
  });
  await db.retryBlockedTask(taskInput.id!, "Safe retry after remote stop.");
  assert.equal((await db.getTask(taskInput.id!))?.task.status, "queued");
});

test("replays the durable global event cursor with optional task filtering", async (t) => {
  const { db } = await fixture(t);
  const firstTask = payload("task_event_cursor_a");
  const secondTask = payload("task_event_cursor_b");
  await db.createTask(firstTask, routeTask(firstTask));
  await db.createTask(secondTask, routeTask(secondTask));
  const firstExtra = await db.appendEvent({
    taskId: firstTask.id!,
    type: "test.first",
    message: "First task update.",
  });
  const secondExtra = await db.appendEvent({
    taskId: secondTask.id!,
    type: "test.second",
    message: "Second task update.",
  });

  const firstPage = await db.listEventsAfter(0, undefined, 2);
  assert.equal(firstPage.length, 2);
  assert.ok((firstPage[0]?.id ?? 0) < (firstPage[1]?.id ?? 0));

  const secondPage = await db.listEventsAfter(firstPage.at(-1)!.id);
  assert.deepEqual(
    secondPage.map((event) => event.id),
    [firstExtra.id, secondExtra.id],
  );
  const firstTaskReplay = await db.listEventsAfter(0, firstTask.id!, 10);
  assert.deepEqual(
    firstTaskReplay.map((event) => event.taskId),
    [firstTask.id!, firstTask.id!],
  );
  assert.ok(firstTaskReplay.every((event, index) => index === 0 || event.id > firstTaskReplay[index - 1]!.id));
  await assert.rejects(db.listEventsAfter(-1), /non-negative safe integer/);
  await assert.rejects(db.listEventsAfter(0, undefined, 0), /Limit must be/);
});

test("lists runs and reviews globally with coordinator-facing filters", async (t) => {
  const { db } = await fixture(t);
  const firstTask = payload("task_global_queries_a");
  const secondTask = payload("task_global_queries_b");
  const firstCreated = await db.createTask(firstTask, routeTask(firstTask));
  const secondCreated = await db.createTask(secondTask, routeTask(secondTask));
  const firstStep = firstCreated.routeSteps[0];
  const secondStep = secondCreated.routeSteps[0];
  assert.ok(firstStep);
  assert.ok(secondStep);

  const firstRun = await db.createRun({
    taskId: firstTask.id!,
    routeStepId: firstStep.id,
    agent: "codex",
    role: firstStep.role,
  });
  const secondRun = await db.createRun({
    taskId: secondTask.id!,
    routeStepId: secondStep.id,
    agent: "claude",
    role: secondStep.role,
  });
  await db.updateRun(secondRun.id, { status: "starting" });
  await db.updateRun(secondRun.id, { status: "running" });

  assert.equal((await db.listRuns()).length, 2);
  assert.deepEqual(
    (await db.listRuns(undefined, { agent: "claude", status: "running" })).map(
      (run) => run.id,
    ),
    [secondRun.id],
  );
  assert.deepEqual(
    (await db.listRuns(firstTask.id!, { limit: 1 })).map((run) => run.id),
    [firstRun.id],
  );

  const firstReview = await db.createReview({ taskId: firstTask.id! });
  const secondReview = await db.createReview({ taskId: secondTask.id! });
  await db.decideReview(secondReview.id, "approved", "Looks good.");
  assert.equal((await db.listReviews()).length, 2);
  assert.deepEqual(
    (await db.listReviews(undefined, { status: "pending" })).map(
      (review) => review.id,
    ),
    [firstReview.id],
  );
  assert.deepEqual(
    (await db.listReviews(secondTask.id!, { status: "approved", limit: 1 })).map(
      (review) => review.id,
    ),
    [secondReview.id],
  );
});

test("idempotency claims distinguish pending, conflict, replay, and safe release", async (t) => {
  const { db } = await fixture(t);
  const first = await db.claimIdempotencyKey("create:task_1", "hash_a");
  assert.equal(first.kind, "new");
  assert.equal(
    (await db.claimIdempotencyKey("create:task_1", "hash_a")).kind,
    "pending",
  );
  assert.equal(
    (await db.claimIdempotencyKey("create:task_1", "hash_b")).kind,
    "conflict",
  );

  const response = { statusCode: 201, body: { taskId: "task_1", queued: true } };
  const completed = await db.completeIdempotencyKey(
    "create:task_1",
    "hash_a",
    response,
  );
  assert.equal(completed.state, "completed");
  assert.equal(completed.responseStatus, 201);
  assert.deepEqual(completed.responseBody, response.body);
  const replay = await db.claimIdempotencyKey("create:task_1", "hash_a");
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.equal(replay.responseStatus, 201);
    assert.deepEqual(replay.responseBody, response.body);
  }
  assert.deepEqual(
    await db.completeIdempotencyKey("create:task_1", "hash_a", response),
    completed,
  );
  assert.equal(await db.releaseIdempotencyKey("create:task_1", "hash_a"), false);

  assert.equal((await db.claimIdempotencyKey("retry:task_1", "hash_c")).kind, "new");
  assert.equal(await db.releaseIdempotencyKey("retry:task_1", "wrong_hash"), false);
  assert.equal(
    (await db.claimIdempotencyKey("retry:task_1", "hash_c")).kind,
    "pending",
  );
  assert.equal(await db.releaseIdempotencyKey("retry:task_1", "hash_c"), true);
  assert.equal((await db.claimIdempotencyKey("retry:task_1", "hash_c")).kind, "new");
});

test("concurrent idempotency claims elect one new owner without double execution", async (t) => {
  const { filename, db: first } = await fixture(t);
  const second = new ControlCenterDb(filename);
  await second.init();
  t.after(async () => await second.close());

  const sameConnectionClaims = await Promise.all([
    first.claimIdempotencyKey("message:run_1", "same_hash"),
    first.claimIdempotencyKey("message:run_1", "same_hash"),
  ]);
  assert.equal(
    sameConnectionClaims.filter((claim) => claim.kind === "new").length,
    1,
  );
  assert.equal(
    sameConnectionClaims.filter((claim) => claim.kind === "pending").length,
    1,
  );

  const claims = await Promise.all([
    first.claimIdempotencyKey("cancel:run_1", "same_hash"),
    second.claimIdempotencyKey("cancel:run_1", "same_hash"),
  ]);
  assert.equal(claims.filter((claim) => claim.kind === "new").length, 1);
  assert.equal(claims.filter((claim) => claim.kind === "pending").length, 1);
  assert.equal(
    (await second.claimIdempotencyKey("cancel:run_1", "different_hash")).kind,
    "conflict",
  );
});
