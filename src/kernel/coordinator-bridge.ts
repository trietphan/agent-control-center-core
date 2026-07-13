// CoordinatorKernelBridge: binds the REAL execution kernel behind the
// KernelBridge seam. A work.offer is accepted only after every
// §6.4 precondition passes; acceptance then drives the shipped coordinator
// (isolated worktree, adapter run, independent verification, immutable
// evidence) and the machine-observed facts flow back through the
// NodeSession as events plus a completion proposal.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../accp/envelope.js";
import type { Envelope } from "../accp/envelope.js";
import type { Coordinator, RunTaskResult } from "../coordinator.js";
import type { ControlCenterDb } from "../db.js";
import type {
  ExecutionReporter,
  KernelBridge,
  OfferDecision,
  ReviewDecisionPayload,
  WorkOfferPayload,
} from "./bridge.js";

// The decoded plan bytes: what the cloud's plan compiler emits and the node
// fetches by digest. v1 carries the task fields the local kernel needs.
export const PlanDocumentSchema = z.object({
  goal: z.string().min(1),
  repo: z.string().min(1),
  agent: z.enum(["codex", "claude", "openclaw", "auto"]),
  context: z.string().optional(),
  successCriteria: z.array(z.string()).optional(),
  verificationCommand: z.string().optional(),
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;

export function planDigest(planBytes: string): string {
  return createHash("sha256").update(planBytes, "utf8").digest("hex");
}

function sha256Hex(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export interface CoordinatorBridgeOptions {
  coordinator: Coordinator;
  db: ControlCenterDb;
  /** Capabilities this execution node can actually satisfy. */
  capabilities?: readonly string[];
  /** Secret references already resolvable by the node's secret provider. */
  availableSecrets?: readonly string[];
  /** Fetch plan bytes by digest (production: artifact/plan store; tests
   * supply the canonical bytes directly). null = unavailable. */
  resolvePlan: (digest: string) => string | null;
  /** Notified after an offer is accepted; the node runtime queues the
   * lease for sequential execution. */
  onAccepted?: (leaseId: string, offer: WorkOfferPayload) => void;
}

export interface ExecutionOutcome {
  runResult: RunTaskResult;
  localTaskId: string;
  completionEnvelope: Envelope;
}

export class CoordinatorKernelBridge implements KernelBridge {
  readonly #coordinator: Coordinator;
  readonly #db: ControlCenterDb;
  readonly #resolvePlan: (digest: string) => string | null;
  readonly #capabilities: ReadonlySet<string>;
  readonly #availableSecrets: ReadonlySet<string>;
  readonly #accepted = new Map<
    string,
    { offer: WorkOfferPayload; plan: PlanDocument }
  >();
  readonly reviewDecisions: ReviewDecisionPayload[] = [];
  readonly #onAccepted: ((leaseId: string, offer: WorkOfferPayload) => void) | undefined;

  constructor(options: CoordinatorBridgeOptions) {
    this.#coordinator = options.coordinator;
    this.#db = options.db;
    this.#resolvePlan = options.resolvePlan;
    this.#capabilities = new Set(options.capabilities ?? ["worktree"]);
    this.#availableSecrets = new Set(options.availableSecrets ?? []);
    this.#onAccepted = options.onAccepted;
  }

  decideOffer(offer: WorkOfferPayload): OfferDecision {
    for (const capability of offer.requiredCapabilities) {
      if (!this.#capabilities.has(capability)) {
        return {
          action: "decline",
          reason: "CAPABILITY_MISSING",
          detail: capability,
        };
      }
    }
    for (const secretRef of offer.requiredSecrets) {
      if (!this.#availableSecrets.has(secretRef)) {
        return {
          action: "decline",
          reason: "SECRET_MISSING",
          detail: secretRef,
        };
      }
    }
    const bytes = this.#resolvePlan(offer.planRevision.digest);
    if (bytes === null) {
      // The plan store is a required capability of an executing node; a
      // session-level SCHEMA_VIOLATION nack path is the spec refinement.
      return {
        action: "decline",
        reason: "CAPABILITY_MISSING",
        detail: "plan bytes unavailable for digest",
      };
    }
    if (planDigest(bytes) !== offer.planRevision.digest) {
      // Tampered or stale offer: must never execute (accp-v1.md §6.4).
      throw new Error("plan bytes do not match the offered plan digest");
    }
    let rawPlan: unknown;
    try {
      rawPlan = JSON.parse(bytes) as unknown;
    } catch {
      return {
        action: "decline",
        reason: "POLICY_BUNDLE_UNSUPPORTED",
        detail: "plan document is not valid JSON",
      };
    }
    const parsed = PlanDocumentSchema.safeParse(rawPlan);
    if (!parsed.success) {
      return {
        action: "decline",
        reason: "POLICY_BUNDLE_UNSUPPORTED",
        detail: "plan document schema unsupported by this node version",
      };
    }
    const plan = parsed.data;
    // Base commit must be fetchable BEFORE acceptance — decline, never
    // fail mid-run.
    try {
      execFileSync(
        "git",
        ["-C", plan.repo, "cat-file", "-e", `${offer.planRevision.baseCommit}^{commit}`],
        { stdio: "ignore" },
      );
    } catch {
      return {
        action: "decline",
        reason: "REPO_BASE_UNAVAILABLE",
        detail: `${offer.planRevision.baseCommit} not present in ${plan.repo}`,
      };
    }
    this.#accepted.set(offer.lease.leaseId, { offer, plan });
    this.#onAccepted?.(offer.lease.leaseId, offer);
    return { action: "accept" };
  }

  onReviewDecision(decision: ReviewDecisionPayload): void {
    this.reviewDecisions.push(decision);
  }

  /**
   * Execute one accepted offer through the real kernel and report the
   * machine-observed outcome through the session: kernel timeline events,
   * then a completion proposal whose digests cover the exact evidence set.
   */
  async executeAccepted(
    leaseId: string,
    session: ExecutionReporter,
    now = new Date(),
  ): Promise<ExecutionOutcome> {
    const entry = this.#accepted.get(leaseId);
    if (!entry) throw new Error(`no accepted offer for lease ${leaseId}`);
    const { offer, plan } = entry;
    const ids = { runId: offer.runId, taskId: offer.taskId };

    session.emitEvent(
      "run.started",
      { leaseId, planRevisionDigest: offer.planRevision.digest },
      ids,
      now,
    );
    const created = await this.#coordinator.createTask({
      goal: plan.goal,
      repo: plan.repo,
      agent: plan.agent,
      baseRef: offer.planRevision.baseCommit,
      ...(plan.context === undefined ? {} : { context: plan.context }),
      ...(plan.successCriteria === undefined
        ? {}
        : { successCriteria: plan.successCriteria }),
      ...(plan.verificationCommand === undefined
        ? {}
        : { verificationCommand: plan.verificationCommand }),
    });
    const runResult = await this.#coordinator.runNext();
    if (!runResult || runResult.taskId !== created.task.id) {
      throw new Error("kernel did not execute the task created for this offer");
    }

    // Mirror the kernel's append-only local timeline as protocol events —
    // machine-observed facts only, never agent prose (invariant 2).
    const aggregate = await this.#db.getTask(created.task.id);
    if (!aggregate) throw new Error("executed task disappeared");
    for (const event of aggregate.events) {
      session.emitEvent(
        `kernel.${event.type}`,
        { localTaskId: created.task.id, localEventId: event.id },
        ids,
        now,
      );
    }
    const evidence = aggregate.runs.map((run) => ({
      localRunId: run.id,
      status: run.status,
      exitCode: run.exitCode,
      resultPath: run.resultPath,
      usageJson: run.usageJson,
    }));
    session.emitEvent(
      "run.completion_proposed",
      { localTaskId: created.task.id, status: runResult.status },
      ids,
      now,
    );

    const outcome = runResult.status === "blocked" ? "failed" : "succeeded";
    const evidenceManifestDigest = sha256Hex(evidence);
    const completionDigest = sha256Hex({
      runId: offer.runId,
      taskRevision: offer.taskRevision,
      planRevisionDigest: offer.planRevision.digest,
      outcome,
      evidenceManifestDigest,
    });
    const completionEnvelope = session.proposeCompletion(
      {
        runId: offer.runId,
        taskId: offer.taskId,
        taskRevision: offer.taskRevision,
        planRevisionDigest: offer.planRevision.digest,
        outcome,
        completionDigest,
        evidenceManifestDigest,
        finalCursor: session.nodeCursor,
      },
      now,
    );
    return { runResult, localTaskId: created.task.id, completionEnvelope };
  }
}
