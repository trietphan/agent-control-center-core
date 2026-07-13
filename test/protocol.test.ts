import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactKindSchema,
  TaskPayloadSchema,
  assertRunTransition,
  assertTaskTransition,
  taskPayloadJsonSchema,
} from "../src/protocol.js";

test("task payload applies stable CLI-first defaults", () => {
  const task = TaskPayloadSchema.parse({
    goal: "Fix the login bug",
    repo: "/tmp/example",
  });
  assert.equal(task.agent, "auto");
  assert.equal(task.priority, "normal");
  assert.equal(task.baseRef, "HEAD");
  assert.equal(task.handoffRequired, true);
  assert.deepEqual(task.successCriteria, []);
  assert.throws(
    () =>
      TaskPayloadSchema.parse({
        goal: "Fix the login bug",
        repo: "/tmp/example",
        typoPriority: "urgent",
      }),
    /Unrecognized key/u,
  );
});

test("task ids are safe durable storage keys", () => {
  const base = {
    goal: "Inspect an external automation",
    repo: "/tmp/repo",
  };

  assert.equal(TaskPayloadSchema.parse({ ...base, id: "task_123.ok" }).id, "task_123.ok");
  for (const id of ["../escape", "task/escape", ".", "..", " task with spaces "]) {
    assert.throws(() => TaskPayloadSchema.parse({ ...base, id }));
  }
});

test("task state rejects impossible jumps", () => {
  assert.doesNotThrow(() => assertTaskTransition("queued", "running"));
  assert.doesNotThrow(() => assertTaskTransition("running", "needs-review"));
  assert.throws(() => assertTaskTransition("queued", "done"), /Invalid task transition/);
});

test("run state keeps execution and review lifecycle separate", () => {
  assert.doesNotThrow(() => assertRunTransition("queued", "starting"));
  assert.doesNotThrow(() => assertRunTransition("starting", "running"));
  assert.doesNotThrow(() => assertRunTransition("running", "succeeded"));
  assert.throws(() => assertRunTransition("queued", "succeeded"), /Invalid run transition/);
});

test("shared task protocol is exportable as JSON Schema", () => {
  const schema = taskPayloadJsonSchema() as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  assert.equal(schema.type, "object");
  assert.ok(schema.properties?.goal);
  assert.ok(schema.properties?.agent);
  assert.ok(schema.required?.includes("goal"));
  assert.ok(schema.required?.includes("repo"));
  assert.equal(schema.additionalProperties, false);
});

test("artifact protocol covers the complete audit envelope", () => {
  for (const kind of ["prompt", "commit", "screenshot", "test-log"] as const) {
    assert.equal(ArtifactKindSchema.parse(kind), kind);
  }
});
