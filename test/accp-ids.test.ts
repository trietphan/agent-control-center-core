import assert from "node:assert/strict";
import { test } from "node:test";
import { UuidSchema } from "../src/accp/envelope.js";
import { uuidV7 } from "../src/accp/ids.js";

test("uuidV7 emits a valid time-ordered version 7 identifier", () => {
  const first = uuidV7(1_700_000_000_000);
  const later = uuidV7(1_700_000_000_001);
  assert.equal(UuidSchema.parse(first), first);
  assert.equal(first[14], "7");
  assert.match(first[19]!, /[89ab]/u);
  assert.ok(first < later);
});

test("uuidV7 rejects timestamps outside its 48-bit range", () => {
  assert.throws(() => uuidV7(-1), RangeError);
  assert.throws(() => uuidV7(Number.MAX_SAFE_INTEGER), RangeError);
});
