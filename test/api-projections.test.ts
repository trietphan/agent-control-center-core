import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactContentUrl,
  projectTaskBoardRow,
  projectTaskDetail,
  toTaskBoardRow,
  toTaskDetail,
} from "../src/api-projections.js";
import type { RunRecord, TaskAggregate } from "../src/db.js";

const createdAt = "2026-07-09T12:00:00.000Z";
const updatedAt = "2026-07-09T12:10:00.000Z";

function run(
  id: string,
  status: RunRecord["status"],
  created: string,
): RunRecord {
  return {
    id,
    taskId: "task_dashboard",
    routeStepId: `step_${id}`,
    adapterRunId: `private-adapter-${id}`,
    agent: "codex",
    role: "execute",
    attempt: 1,
    status,
    usageJson: null,
    pid: 4242,
    worktreePath: `/private/worktrees/${id}`,
    branch: `acc/task/${id}`,
    baseCommit: "a".repeat(40),
    stdoutPath: `/private/artifacts/${id}/stdout.log`,
    stderrPath: `/private/artifacts/${id}/stderr.log`,
    resultPath: `/private/artifacts/${id}/result.txt`,
    exitCode: status === "succeeded" ? 0 : null,
    signal: null,
    summary: status === "succeeded" ? "Completed." : null,
    error: status === "failed" ? "Failed." : null,
    startedAt: status === "queued" ? null : created,
    finishedAt: ["succeeded", "failed", "stopped", "stale"].includes(status)
      ? updatedAt
      : null,
    createdAt: created,
    updatedAt,
  };
}

function aggregate(): TaskAggregate {
  const steps = [
    ["step_pending", 0, "pending"],
    ["step_running", 1, "running"],
    ["step_succeeded", 2, "succeeded"],
    ["step_failed", 3, "failed"],
    ["step_skipped", 4, "skipped"],
  ] as const;
  return {
    task: {
      id: "task_dashboard",
      goal: "Ship the dashboard projection",
      repo: "/private/source/acme-control-center",
      baseRef: "main",
      agent: "parallel",
      priority: "high",
      context: "Keep the response compact.",
      successCriteria: ["No path disclosure", "Useful board state"],
      verificationCommand: "npm test",
      handoffRequired: true,
      status: "needs-review",
      routePlan: {
        mode: "sequential",
        risk: "high",
        reasons: ["Independent review is required."],
        steps: steps.map(([id, sequence]) => ({
          id,
          sequence,
          agent: "codex" as const,
          role: "execute" as const,
          required: true,
          reason: `Route reason ${sequence}`,
        })),
      },
      latestUpdate: "Evidence is ready.",
      claimedBy: null,
      claimedAt: null,
      createdAt,
      updatedAt,
    },
    routeSteps: steps.map(([id, sequence, status]) => ({
      id,
      taskId: "task_dashboard",
      sequence,
      agent: "codex" as const,
      role: "execute" as const,
      required: true,
      reason: `Route reason ${sequence}`,
      status,
      runId: status === "pending" ? null : `run_${status}`,
      createdAt,
      updatedAt,
    })),
    runs: [
      run("terminal", "succeeded", "2026-07-09T12:04:00.000Z"),
      run("running", "running", "2026-07-09T12:03:00.000Z"),
      run("queued", "queued", "2026-07-09T12:01:00.000Z"),
      run("starting", "starting", "2026-07-09T12:02:00.000Z"),
    ],
    events: [
      {
        id: 9,
        taskId: "task_dashboard",
        runId: "run_running",
        type: "run.started",
        level: "info",
        message: "Run started.",
        data: { worktreePath: "/private/event/worktree" },
        createdAt: "2026-07-09T12:09:00.000Z",
      },
      {
        id: 4,
        taskId: "task_dashboard",
        runId: null,
        type: "task.created",
        level: "info",
        message: "Task created.",
        data: null,
        createdAt,
      },
    ],
    artifacts: [
      {
        id: "artifact/private",
        taskId: "task_dashboard",
        runId: "run_terminal",
        kind: "prompt",
        path: "/private/artifacts/run_terminal/prompt.md",
        relativePath: "artifacts/task_dashboard/run_terminal/prompt.md",
        sha256: "b".repeat(64),
        sizeBytes: 120,
        metadata: { internalPath: "/private/metadata/path" },
        createdAt: "2026-07-09T12:05:00.000Z",
      },
      {
        id: "artifact_diff",
        taskId: "task_dashboard",
        runId: "run_terminal",
        kind: "diff",
        path: "/private/artifacts/run_terminal/diff.patch",
        relativePath: "artifacts/task_dashboard/run_terminal/diff.patch",
        sha256: "c".repeat(64),
        sizeBytes: 880,
        metadata: null,
        createdAt: "2026-07-09T12:06:00.000Z",
      },
    ],
    messages: [
      {
        id: "message_1",
        taskId: "task_dashboard",
        runId: "run_terminal",
        direction: "system",
        role: "reviewer",
        body: "Please review the evidence.",
        deliveryStatus: "queued",
        createdAt: "2026-07-09T12:07:00.000Z",
      },
    ],
    reviews: [
      {
        id: "review_old",
        taskId: "task_dashboard",
        runId: "run_terminal",
        reviewer: null,
        status: "pending",
        note: null,
        createdAt: "2026-07-09T12:07:00.000Z",
        updatedAt: "2026-07-09T12:07:00.000Z",
      },
      {
        id: "review_new",
        taskId: "task_dashboard",
        runId: "run_terminal",
        reviewer: "operator",
        status: "pending",
        note: null,
        createdAt: "2026-07-09T12:08:00.000Z",
        updatedAt: "2026-07-09T12:08:00.000Z",
      },
    ],
  };
}

test("board rows summarize route, active execution, evidence, review, and next action", () => {
  const input = aggregate();
  const originalRunOrder = input.runs.map((item) => item.id);
  const row = projectTaskBoardRow(input);

  assert.deepEqual(row.routeProgress, {
    total: 5,
    completed: 3,
    pending: 1,
    running: 1,
    succeeded: 1,
    failed: 1,
    skipped: 1,
    percent: 60,
  });
  assert.deepEqual(
    row.activeRuns.map((item) => [item.id, item.status]),
    [
      ["queued", "queued"],
      ["starting", "starting"],
      ["running", "running"],
    ],
  );
  assert.equal(row.evidenceSummary.totalArtifacts, 2);
  assert.equal(row.evidenceSummary.totalBytes, 1_000);
  assert.equal(row.evidenceSummary.byKind.prompt, 1);
  assert.equal(row.evidenceSummary.byKind.diff, 1);
  assert.equal(row.evidenceSummary.byKind.screenshot, 0);
  assert.equal(row.pendingReview?.id, "review_new");
  assert.equal(row.latestEvent?.id, 9);
  assert.equal(row.nextAction, "review");
  assert.deepEqual(input.runs.map((item) => item.id), originalRunOrder);
  assert.deepEqual(toTaskBoardRow(input), row);
});

test("next action is deterministic for every operational task state", () => {
  const input = aggregate();
  const projected = (
    status: TaskAggregate["task"]["status"],
    reviews = input.reviews,
  ) =>
    projectTaskBoardRow({
      ...input,
      task: { ...input.task, status },
      reviews,
    }).nextAction;

  assert.equal(projected("queued"), "execute");
  assert.equal(projected("running"), "monitor");
  assert.equal(projected("needs-review"), "review");
  assert.equal(projected("needs-review", []), "inspect");
  assert.equal(projected("blocked"), "retry");
  assert.equal(projected("done"), "none");
});

test("task detail exposes content URLs without filesystem paths or unsafe metadata", () => {
  const input = aggregate();
  const detail = projectTaskDetail(input);

  assert.equal(detail.task.repositoryName, "acme-control-center");
  assert.deepEqual(detail.summary, projectTaskBoardRow(input));
  assert.deepEqual(
    detail.artifacts.map((item) => [item.name, item.contentUrl]),
    [
      ["prompt.md", "/v1/artifacts/artifact%2Fprivate/content"],
      ["diff.patch", "/v1/artifacts/artifact_diff/content"],
    ],
  );
  assert.equal("path" in detail.artifacts[0]!, false);
  assert.equal("relativePath" in detail.artifacts[0]!, false);
  assert.equal("metadata" in detail.artifacts[0]!, false);
  assert.equal("worktreePath" in detail.runs[0]!, false);
  assert.equal("stdoutPath" in detail.runs[0]!, false);
  assert.equal("adapterRunId" in detail.runs[0]!, false);
  assert.equal("data" in detail.events[0]!, false);

  const serialized = JSON.stringify(detail);
  for (const secret of [
    "/private/source/acme-control-center",
    "/private/artifacts/run_terminal/prompt.md",
    "/private/worktrees/terminal",
    "/private/event/worktree",
    "/private/metadata/path",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  detail.task.successCriteria.push("DTO mutation");
  detail.task.route.reasons.push("DTO mutation");
  assert.equal(input.task.successCriteria.includes("DTO mutation"), false);
  assert.equal(input.task.routePlan.reasons.includes("DTO mutation"), false);
  assert.deepEqual(toTaskDetail(input), projectTaskDetail(input));
});

test("artifact content URLs encode opaque ids", () => {
  assert.equal(
    artifactContentUrl("artifact with/slash?#"),
    "/v1/artifacts/artifact%20with%2Fslash%3F%23/content",
  );
});

test("path-safe labels do not leak paths created on another operating system", () => {
  const input = aggregate();
  input.task.repo = "C:\\Users\\operator\\secret-repo";
  input.artifacts[0]!.path =
    "C:\\Users\\operator\\.acc\\artifacts\\task\\prompt.md";
  const detail = projectTaskDetail(input);

  assert.equal(detail.task.repositoryName, "secret-repo");
  assert.equal(detail.artifacts[0]?.name, "prompt.md");
  assert.equal(JSON.stringify(detail).includes("C:\\Users\\operator"), false);
});
