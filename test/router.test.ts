import assert from "node:assert/strict";
import test from "node:test";
import { TaskPayloadSchema } from "../src/protocol.js";
import { routeTask } from "../src/router.js";

function task(overrides: Record<string, unknown>) {
  return TaskPayloadSchema.parse({
    goal: "Implement a repository change",
    repo: "/tmp/repo",
    ...overrides,
  });
}

test("explicit parallel assignment fans out Codex and Claude", () => {
  const route = routeTask(task({ agent: "parallel" }));
  assert.equal(route.mode, "parallel");
  assert.deepEqual(
    route.steps.map((item) => [item.sequence, item.agent, item.role]),
    [
      [0, "codex", "execute"],
      [0, "claude", "execute"],
    ],
  );
});

test("risky coding routes through implementation, review, and approval handoff", () => {
  const route = routeTask(
    task({
      goal: "Deploy an authentication schema migration to production",
      successCriteria: ["No account lockout"],
    }),
  );
  assert.equal(route.risk, "high");
  assert.equal(route.mode, "sequential");
  assert.deepEqual(
    route.steps.map((item) => [item.agent, item.role, item.required]),
    [
      ["codex", "execute", true],
      ["claude", "review", true],
      ["openclaw", "approval", false],
    ],
  );
});

test("planner-first delegation routes Claude before Codex and OpenClaw execution", () => {
  const route = routeTask(
    task({
      goal:
        "Use a planner-first workflow where Claude is the planner assigner, then Codex and OpenClaw execute the assigned work.",
      context:
        "Claude should assign repository work to Codex and external workflow handoff work to OpenClaw.",
    }),
  );
  assert.equal(route.mode, "sequential");
  assert.deepEqual(
    route.steps.map((item) => [item.sequence, item.agent, item.role, item.required]),
    [
      [0, "claude", "review", true],
      [1, "codex", "execute", true],
      [2, "openclaw", "execute", true],
    ],
  );
  assert.match(route.reasons.join("\n"), /planner-first delegation/i);
});

test("an explicit Codex assignment does not bypass the risky-work review gate", () => {
  const route = routeTask(
    task({
      agent: "codex",
      goal: "Implement a production payment migration",
    }),
  );
  assert.deepEqual(
    route.steps.map((item) => item.agent),
    ["codex", "claude", "openclaw"],
  );
});

test("architecture-only work routes to Claude", () => {
  const route = routeTask(task({ goal: "Review architecture trade-offs for the queue" }));
  assert.equal(route.steps[0]?.agent, "claude");
  assert.equal(route.steps[0]?.role, "review");
});

test("code review routes to Claude instead of being mistaken for implementation", () => {
  const route = routeTask(task({ goal: "Review the authentication code for security risks" }));
  assert.equal(route.steps[0]?.agent, "claude");
});

test("external automation work routes to OpenClaw", () => {
  const route = routeTask(task({ goal: "Set up a macOS cron automation for Telegram" }));
  assert.equal(route.steps[0]?.agent, "openclaw");
});

test("repository implementation defaults to Codex", () => {
  const route = routeTask(task({ goal: "Fix failing API tests" }));
  assert.equal(route.steps[0]?.agent, "codex");
});
