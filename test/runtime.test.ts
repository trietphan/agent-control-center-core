import assert from "node:assert/strict";
import test from "node:test";
import { isRemoteCancellationConfirmed } from "../src/runtime.js";

test("only an explicit remote stop unlocks retry after crash recovery", () => {
  assert.equal(isRemoteCancellationConfirmed("stopped"), true);
  assert.equal(isRemoteCancellationConfirmed("succeeded"), false);
  assert.equal(isRemoteCancellationConfirmed("failed"), false);
  assert.equal(isRemoteCancellationConfirmed("stale"), false);
});
