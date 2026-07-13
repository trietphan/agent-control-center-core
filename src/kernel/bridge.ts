// Stable execution-kernel boundary for ACCP federation.
import type { z } from "zod";
import type {
  ReviewDecisionSchema,
  WorkOfferSchema,
} from "../accp/messages.js";

export type WorkOfferPayload = z.infer<typeof WorkOfferSchema>;
export type ReviewDecisionPayload = z.infer<typeof ReviewDecisionSchema>;

export type OfferDecision =
  | { action: "accept" }
  | {
      action: "decline";
      reason:
        | "REPO_BASE_UNAVAILABLE"
        | "SECRET_MISSING"
        | "CAPABILITY_MISSING"
        | "POLICY_BUNDLE_UNSUPPORTED"
        | "CAPACITY";
      detail?: string;
    };

export interface KernelBridge {
  decideOffer(offer: WorkOfferPayload): OfferDecision;
  onReviewDecision?(decision: ReviewDecisionPayload): void;
}

/** Minimal event sink required by the execution kernel; avoids a node cycle. */
export interface ExecutionReporter {
  readonly nodeCursor: number;
  emitEvent(
    kind: string,
    data: Record<string, unknown>,
    ids: { runId?: string; taskId?: string },
    now: Date,
  ): unknown;
  proposeCompletion(payload: unknown, now: Date): import("../accp/envelope.js").Envelope;
}

export interface SimulatedKernelOptions {
  /** Secret references the simulated keychain can resolve. */
  availableSecrets?: readonly string[];
  /** Capabilities this node advertises. */
  capabilities?: readonly string[];
  /** Remaining run capacity. */
  availableRuns?: number;
}

/** Deterministic in-memory kernel used by the federation walking skeleton. */
export class SimulatedKernel implements KernelBridge {
  readonly decisions: ReviewDecisionPayload[] = [];
  readonly #secrets: ReadonlySet<string>;
  readonly #capabilities: ReadonlySet<string>;
  #capacity: number;

  constructor(options: SimulatedKernelOptions = {}) {
    this.#secrets = new Set(options.availableSecrets ?? []);
    this.#capabilities = new Set(options.capabilities ?? ["worktree"]);
    this.#capacity = options.availableRuns ?? 1;
  }

  decideOffer(offer: WorkOfferPayload): OfferDecision {
    if (this.#capacity <= 0) {
      return { action: "decline", reason: "CAPACITY" };
    }
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
      if (!this.#secrets.has(secretRef)) {
        return { action: "decline", reason: "SECRET_MISSING", detail: secretRef };
      }
    }
    this.#capacity -= 1;
    return { action: "accept" };
  }

  onReviewDecision(decision: ReviewDecisionPayload): void {
    this.decisions.push(decision);
  }
}
