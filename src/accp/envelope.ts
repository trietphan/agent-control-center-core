// ACCP v1 envelope, canonicalization, and transport helpers.
import { createHash } from "node:crypto";
import { z } from "zod";

export const UuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "uuidv7",
  );
export const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "sha256 digest");
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 hex");
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "git sha");
// RFC 3339 UTC instant; accp-v1.md §3 pins UTC with trailing Z.
export const DateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/, "rfc3339 utc");
export const CursorSchema = z.number().int().nonnegative();

// Envelope per accp-v1.md §2 field table. `payload` stays unknown here; the
// per-type schemas in messages.ts validate it.
export const EnvelopeSchema = z.object({
  protocol: z.string().min(1),
  schemaDigest: DigestSchema,
  type: z.string().min(1),
  messageId: UuidSchema,
  sessionId: UuidSchema,
  workspaceId: UuidSchema,
  senderId: z.string().regex(/^(node:.+|cloud)$/, "senderId"),
  idempotencyKey: z.string().min(1).max(200).optional(),
  correlationId: UuidSchema.optional(),
  causationId: UuidSchema.optional(),
  sequence: z.number().int().positive(),
  sentAt: DateTimeSchema,
  expiresAt: DateTimeSchema.optional(),
  payloadDigest: DigestSchema,
  payload: z.unknown(),
  signature: z.string().regex(/^ed25519:[A-Za-z0-9_-]+=*$/, "signature"),
}).superRefine((envelope, ctx) => {
  if (COMMAND_OR_PROPOSAL_TYPES.has(envelope.type) && !envelope.idempotencyKey) {
    ctx.addIssue({
      code: "custom",
      path: ["idempotencyKey"],
      message: `${envelope.type} requires idempotencyKey`,
    });
  }
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

const COMMAND_OR_PROPOSAL_TYPES = new Set([
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
]);

// RFC 8785 (JCS) canonicalization subset sufficient for ACCP payloads:
// lexicographic key order by UTF-16 code units (JS default string sort),
// no insignificant whitespace, ECMAScript number serialization, and a hard
// rejection of non-finite numbers and undefined values inside containers.
// Precedent: JCS is the canonicalization JWS/JWK thumbprints build on.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("non-finite number is not canonicalizable");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`${typeof value} is not canonicalizable`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export function computePayloadDigest(payload: unknown): string {
  const hash = createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
  return `sha256:${hash}`;
}

// Signed bytes = JCS canonicalization of the envelope with `signature`
// removed (accp-v1.md §2.1). The digest transitively covers the payload via
// payloadDigest, which callers must have verified first.
export function buildSigningInput(envelope: Omit<Envelope, "signature"> | Envelope): string {
  const { signature: _signature, ...unsigned } = envelope as Envelope;
  return canonicalJson(unsigned);
}

// Clock-skew rule (accp-v1.md §2.2): ±120s, and expiry comparisons use the
// receiver clock minus the tolerance.
export const CLOCK_SKEW_TOLERANCE_MS = 120_000;

export function isWithinClockSkew(sentAt: string, receiverNowMs: number): boolean {
  const sent = Date.parse(sentAt);
  return Math.abs(receiverNowMs - sent) <= CLOCK_SKEW_TOLERANCE_MS;
}

export function isExpired(expiresAt: string | undefined, receiverNowMs: number): boolean {
  if (expiresAt === undefined) return false;
  return Date.parse(expiresAt) < receiverNowMs - CLOCK_SKEW_TOLERANCE_MS;
}

// Bounded per-sender duplicate index (accp-v1.md §5.1: "receivers keep a
// bounded dedup index"). Insertion-ordered eviction.
export class MessageDedupIndex {
  #seen = new Set<string>();
  readonly #capacity: number;

  constructor(capacity = 10_000) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  /** Returns true when the messageId is a duplicate. Records it otherwise. */
  check(messageId: string): boolean {
    if (this.#seen.has(messageId)) return true;
    this.#seen.add(messageId);
    if (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.values().next().value as string;
      this.#seen.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.#seen.size;
  }
}

// Contiguous-cursor acceptance for run.event_batch (accp-v1.md §5.3, §6.11):
// acks carry the highest contiguous cursor; duplicates are re-acked;
// gaps are legal and later reconciled.
export type CursorDecision =
  | { action: "accept" }
  | { action: "duplicate"; ackAt: number }
  | { action: "overlap"; applyFromCursor: number }
  | { action: "gap"; missingFromCursor: number; missingToCursor: number };

export function decideCursorAction(
  highestContiguousAcked: number,
  batchFirstCursor: number,
  batchLastCursor: number,
): CursorDecision {
  if (batchLastCursor < batchFirstCursor) {
    throw new RangeError("batch cursor range is inverted");
  }
  if (batchLastCursor <= highestContiguousAcked) {
    return { action: "duplicate", ackAt: highestContiguousAcked };
  }
  if (batchFirstCursor <= highestContiguousAcked) {
    return { action: "overlap", applyFromCursor: highestContiguousAcked + 1 };
  }
  if (batchFirstCursor === highestContiguousAcked + 1) {
    return { action: "accept" };
  }
  return {
    action: "gap",
    missingFromCursor: highestContiguousAcked + 1,
    missingToCursor: batchFirstCursor - 1,
  };
}
