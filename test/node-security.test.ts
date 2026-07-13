import assert from "node:assert/strict";
import { test } from "node:test";
import { enrollNode } from "../src/node/node-runtime.js";
import { NodeWsClient } from "../src/node/ws-client.js";

const inertSession = {
  connected: false,
  disconnect() {},
  startHandshake() {
    throw new Error("not used");
  },
  receive() {
    return [];
  },
  flush() {
    return [];
  },
};

test("execution node refuses plaintext remote WebSocket transport", () => {
  assert.throws(
    () => new NodeWsClient({ session: inertSession as never, url: "ws://agent.example/ws" }),
    /must use wss/u,
  );
  assert.doesNotThrow(
    () => new NodeWsClient({ session: inertSession as never, url: "ws://127.0.0.1:4500" }),
  );
});

test("node enrollment refuses plaintext remote HTTP before network access", async () => {
  await assert.rejects(
    enrollNode({
      home: ".unused",
      cloudHttpUrl: "http://agent.example",
      enrollmentCode: "fixture_code_123",
    }),
    /must use https/u,
  );
});
