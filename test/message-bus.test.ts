import assert from "node:assert/strict";
import test from "node:test";
import { InProcessMessageBus } from "../src/message-bus.js";

test("message bus fans out run events and supports unsubscribe", async () => {
  const bus = new InProcessMessageBus();
  const messages: string[] = [];
  const unsubscribe = bus.subscribe((event) => messages.push(event.message));
  const base = {
    id: 1,
    taskId: "task_1",
    type: "run.started",
    level: "info" as const,
    createdAt: new Date(0).toISOString(),
  };
  await bus.publish({ ...base, message: "started" });
  unsubscribe();
  await bus.publish({ ...base, id: 2, message: "hidden" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ["started"]);
});

test("a throwing subscriber cannot fail publishers or other subscribers", async () => {
  const bus = new InProcessMessageBus();
  const messages: string[] = [];
  bus.subscribe(() => {
    throw new Error("broken client");
  });
  bus.subscribe((event) => messages.push(event.message));
  await assert.doesNotReject(
    bus.publish({
      id: 3,
      taskId: "task_1",
      type: "run.succeeded",
      level: "info",
      message: "durable",
      createdAt: new Date(0).toISOString(),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ["durable"]);
});
