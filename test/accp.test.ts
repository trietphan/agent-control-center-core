import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  EnvelopeSchema,
  MessageDedupIndex,
  buildSigningInput,
  canonicalJson,
  computePayloadDigest,
  decideCursorAction,
  isExpired,
  isWithinClockSkew,
} from "../src/accp/envelope.js";
import {
  MESSAGE_SCHEMAS,
  MESSAGE_TYPES,
  isAccpMessageType,
  parsePayload,
  type AccpMessageType,
} from "../src/accp/messages.js";
import { ACCP_VALID_PAYLOADS as VALID_PAYLOADS } from "../src/accp/test-vectors.js";

const uuid = (n: number) => `019f6a00-0000-7000-8000-${String(n).padStart(12, "0")}`;
const hex64 = (c: string) => c.repeat(64);
const digest = (c: string) => `sha256:${hex64(c)}`;
const gitSha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
const at = "2026-07-12T10:00:00.000Z";

test("every catalog message type has a valid fixture that parses", () => {
  assert.equal(MESSAGE_TYPES.length, 24);
  for (const type of MESSAGE_TYPES) {
    const parsed = parsePayload(type, VALID_PAYLOADS[type]);
    assert.ok(parsed, `fixture for ${type} should parse`);
  }
});

test("unknown message types are rejected by the type guard", () => {
  assert.equal(isAccpMessageType("work.offer"), true);
  assert.equal(isAccpMessageType("work.destroy_everything"), false);
});

test("work.offer without a lease field fails", () => {
  const bad = structuredClone(VALID_PAYLOADS["work.offer"]) as Record<string, unknown>;
  delete (bad.lease as Record<string, unknown>).renewIntervalMs;
  assert.throws(() => parsePayload("work.offer", bad));
});

test("work.declined with an unknown reason fails (closed enum)", () => {
  const bad = { ...(VALID_PAYLOADS["work.declined"] as object), reason: "FELT_LIKE_IT" };
  assert.throws(() => parsePayload("work.declined", bad));
});

test("artifact.declared with a short digest fails", () => {
  const bad = { ...(VALID_PAYLOADS["artifact.declared"] as object), digest: "abc123" };
  assert.throws(() => parsePayload("artifact.declared", bad));
});

test("review.decision enum excludes invented states", () => {
  const bad = { ...(VALID_PAYLOADS["review.decision"] as object), decision: "policy-hold" };
  assert.throws(() => parsePayload("review.decision", bad));
});

test("run.event_batch caps events at 256", () => {
  const base = VALID_PAYLOADS["run.event_batch"] as { events: unknown[] };
  const one = base.events[0] as object;
  const bad = { ...base, events: Array.from({ length: 257 }, () => ({ ...one })) };
  assert.throws(() => parsePayload("run.event_batch", bad));
});

test("run.event_batch rejects non-contiguous cursors", () => {
  const base = structuredClone(
    VALID_PAYLOADS["run.event_batch"],
  ) as { events: Array<{ cursor: number }> };
  base.events[1]!.cursor += 1;
  assert.throws(() => parsePayload("run.event_batch", base), /contiguous/u);
});

test("envelope fixture parses and signing input excludes the signature", () => {
  const payload = VALID_PAYLOADS["work.offer"];
  const envelope = {
    protocol: "accp/1.0",
    schemaDigest: digest("9"),
    type: "work.offer",
    messageId: uuid(50),
    sessionId: uuid(51),
    workspaceId: uuid(52),
    senderId: "cloud",
    idempotencyKey: `task:${uuid(1)}:plan:${hex64("c")}:offer:1`,
    sequence: 7,
    sentAt: at,
    payloadDigest: computePayloadDigest(payload),
    payload,
    signature: "ed25519:AAAA",
  };
  const parsed = EnvelopeSchema.parse(envelope);
  const input = buildSigningInput(parsed);
  assert.ok(!input.includes("ed25519:AAAA"), "signature must not be signed");
  assert.ok(input.includes('"payloadDigest"'));
});

test("command and proposal envelopes require idempotencyKey", () => {
  const requiredTypes = [
    "work.offer",
    "lease.renewed",
    "lease.revoked",
    "run.cancel_requested",
    "run.message_posted",
    "review.decision",
    "effect.granted",
    "effect.revoked",
    "work.accepted",
    "work.declined",
    "run.completion_proposed",
    "artifact.declared",
    "artifact.upload_granted",
    "artifact.committed",
    "effect.observed",
  ] satisfies readonly AccpMessageType[];
  for (const [index, type] of requiredTypes.entries()) {
    const payload = VALID_PAYLOADS[type];
    const envelope = {
      protocol: "accp/1.0",
      schemaDigest: digest("9"),
      type,
      messageId: uuid(60 + index),
      sessionId: uuid(90),
      workspaceId: uuid(91),
      senderId: type.startsWith("work.") ? "cloud" : "node:test",
      sequence: index + 1,
      sentAt: at,
      payloadDigest: computePayloadDigest(payload),
      payload,
      signature: "ed25519:AAAA",
    };
    assert.throws(
      () => EnvelopeSchema.parse(envelope),
      /idempotencyKey/u,
      `${type} must require an idempotency key`,
    );
    assert.doesNotThrow(() =>
      EnvelopeSchema.parse({ ...envelope, idempotencyKey: `test:${type}` }),
    );
  }
});

test("non-command envelopes may omit idempotencyKey", () => {
  const payload = VALID_PAYLOADS["node.hello"];
  assert.doesNotThrow(() =>
    EnvelopeSchema.parse({
      protocol: "accp/1.0",
      schemaDigest: digest("9"),
      type: "node.hello",
      messageId: uuid(92),
      sessionId: uuid(93),
      workspaceId: uuid(94),
      senderId: "node:test",
      sequence: 1,
      sentAt: at,
      payloadDigest: computePayloadDigest(payload),
      payload,
      signature: "ed25519:AAAA",
    }),
  );
});

test("canonicalJson is key-order independent and digests are stable", () => {
  const a = { b: 1, a: { d: [1, 2], c: "x" } };
  const b = { a: { c: "x", d: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(computePayloadDigest(a), computePayloadDigest(b));
  assert.match(computePayloadDigest(a), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => canonicalJson({ bad: Number.POSITIVE_INFINITY }));
});

test("clock skew and expiry rules follow §2.2", () => {
  const now = Date.parse(at);
  assert.equal(isWithinClockSkew(at, now + CLOCK_SKEW_TOLERANCE_MS), true);
  assert.equal(isWithinClockSkew(at, now + CLOCK_SKEW_TOLERANCE_MS + 1), false);
  // A fresh message is never killed by skew...
  assert.equal(isExpired(at, now + CLOCK_SKEW_TOLERANCE_MS - 1), false);
  // ...and an expired one is never rescued by it.
  assert.equal(isExpired(at, now + CLOCK_SKEW_TOLERANCE_MS + 1), true);
  assert.equal(isExpired(undefined, now), false);
});

test("MessageDedupIndex detects duplicates and stays bounded", () => {
  const index = new MessageDedupIndex(3);
  assert.equal(index.check("m1"), false);
  assert.equal(index.check("m1"), true);
  index.check("m2");
  index.check("m3");
  index.check("m4"); // evicts m1
  assert.equal(index.size, 3);
  assert.equal(index.check("m1"), false, "evicted id is treated as new");
});

test("decideCursorAction covers accept/duplicate/overlap/gap", () => {
  assert.deepEqual(decideCursorAction(100, 101, 105), { action: "accept" });
  assert.deepEqual(decideCursorAction(100, 90, 100), {
    action: "duplicate",
    ackAt: 100,
  });
  assert.deepEqual(decideCursorAction(100, 95, 103), {
    action: "overlap",
    applyFromCursor: 101,
  });
  assert.deepEqual(decideCursorAction(100, 105, 110), {
    action: "gap",
    missingFromCursor: 101,
    missingToCursor: 104,
  });
  assert.throws(() => decideCursorAction(100, 105, 104));
});

test("every schema in MESSAGE_SCHEMAS rejects a plainly wrong payload", () => {
  for (const type of MESSAGE_TYPES) {
    assert.throws(
      () => MESSAGE_SCHEMAS[type].parse({ nonsense: true }),
      `${type} should reject a nonsense payload`,
    );
  }
});
