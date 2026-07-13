import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CoordinatorKernelBridge,
  planDigest,
} from "../src/kernel/coordinator-bridge.js";
import type { Coordinator } from "../src/coordinator.js";
import type { ControlCenterDb } from "../src/db.js";
import type { WorkOfferPayload } from "../src/kernel/bridge.js";

const hex64 = (c: string) => c.repeat(64);
const uid = (n: number) =>
  `019f6a00-0000-7000-8000-${String(n).padStart(12, "0")}`;

function offerForPlan(planBytes: string): WorkOfferPayload {
  return {
    taskId: uid(1),
    runId: uid(2),
    taskRevision: 1,
    planRevision: {
      digest: planDigest(planBytes),
      baseCommit: "9fceb02d0ae598e95dc970b74767f19372d61af8",
    },
    lease: {
      leaseId: uid(3),
      expiresAt: "2026-07-12T11:00:00.000Z",
      renewIntervalMs: 15000,
    },
    policyBundle: {
      digest: "sha256:" + hex64("7"),
      bytesUrl: "https://cloud.example/bundles/x",
    },
    requiredCapabilities: ["worktree"],
    requiredSecrets: [],
  };
}

test("CoordinatorKernelBridge declines malformed plan JSON instead of throwing", () => {
  const malformedPlan = "{";
  const bridge = new CoordinatorKernelBridge({
    coordinator: {} as Coordinator,
    db: {} as ControlCenterDb,
    resolvePlan: () => malformedPlan,
  });
  assert.deepEqual(bridge.decideOffer(offerForPlan(malformedPlan)), {
    action: "decline",
    reason: "POLICY_BUNDLE_UNSUPPORTED",
    detail: "plan document is not valid JSON",
  });
});

test("CoordinatorKernelBridge declines an unsupported required capability before plan fetch", () => {
  const plan = JSON.stringify({ goal: "test", repo: "/tmp/repo", agent: "codex" });
  const bridge = new CoordinatorKernelBridge({
    coordinator: {} as Coordinator,
    db: {} as ControlCenterDb,
    capabilities: ["worktree"],
    resolvePlan: () => {
      throw new Error("plan fetch must not run for an unsupported offer");
    },
  });
  const offer = offerForPlan(plan);
  offer.requiredCapabilities = ["container"];
  assert.deepEqual(bridge.decideOffer(offer), {
    action: "decline",
    reason: "CAPABILITY_MISSING",
    detail: "container",
  });
});

test("CoordinatorKernelBridge declines an unresolved required secret before plan fetch", () => {
  const plan = JSON.stringify({ goal: "test", repo: "/tmp/repo", agent: "codex" });
  const bridge = new CoordinatorKernelBridge({
    coordinator: {} as Coordinator,
    db: {} as ControlCenterDb,
    availableSecrets: ["secret://acme/available"],
    resolvePlan: () => {
      throw new Error("plan fetch must not run for an unsupported offer");
    },
  });
  const offer = offerForPlan(plan);
  offer.requiredSecrets = ["secret://acme/npm-token"];
  assert.deepEqual(bridge.decideOffer(offer), {
    action: "decline",
    reason: "SECRET_MISSING",
    detail: "secret://acme/npm-token",
  });
});
