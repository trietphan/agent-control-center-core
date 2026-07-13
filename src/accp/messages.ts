// ACCP v1 message payload schemas.
import { z } from "zod";
import {
  CursorSchema,
  DateTimeSchema,
  DigestSchema,
  GitShaSchema,
  Sha256HexSchema,
  UuidSchema,
} from "./envelope.js";

const Capacity = z.object({
  maxConcurrentRuns: z.number().int().positive(),
  availableRuns: z.number().int().nonnegative(),
});

// §6.1
export const NodeHelloSchema = z.object({
  supportedProtocols: z.array(z.string()).nonempty(),
  schemaBundleDigest: DigestSchema,
  nodeVersion: z.string(),
  platform: z.string(),
  adapterManifests: z.array(
    z.object({
      adapterId: z.string(),
      manifestDigest: DigestSchema,
      readiness: z.enum([
        "ready",
        "degraded",
        "unavailable",
        "misconfigured",
        "unauthenticated",
      ]),
    }),
  ),
  capabilities: z.array(z.string()),
  capacity: Capacity,
  resume: z.object({ cloudCursor: CursorSchema, nodeCursor: CursorSchema }),
});

// §6.2
export const NodeWelcomeSchema = z.object({
  protocol: z.string(),
  connectionEpoch: z.number().int().positive(),
  schemaBundleDigest: DigestSchema,
  cloudCursor: CursorSchema,
  nodeCursorAck: CursorSchema,
  policyBundleDigest: DigestSchema,
  limits: z.object({
    maxUnackedBatches: z.number().int().positive(),
    maxEventsPerBatch: z.number().int().positive(),
    maxEnvelopeBytes: z.number().int().positive(),
    heartbeatIntervalMs: z.literal(15000),
    deadAfterMs: z.literal(45000),
  }),
  serverTime: DateTimeSchema,
  deprecation: z
    .object({ noNewWorkAt: DateTimeSchema, removalAt: DateTimeSchema })
    .optional(),
});

// §6.3
export const NodeHeartbeatSchema = z.object({
  status: z.enum(["online", "degraded", "draining"]),
  capacity: Capacity,
  activeLeaseIds: z.array(UuidSchema),
  buffer: z.object({ events: CursorSchema, bytes: z.number().int() }),
});

// §6.4 — the normative seed contract.
export const WorkOfferSchema = z.object({
  taskId: UuidSchema,
  runId: UuidSchema,
  taskRevision: z.number().int().positive(),
  planRevision: z.object({ digest: Sha256HexSchema, baseCommit: GitShaSchema }),
  lease: z.object({
    leaseId: UuidSchema,
    expiresAt: DateTimeSchema,
    renewIntervalMs: z.number().int().min(5000),
  }),
  policyBundle: z.object({ digest: DigestSchema, bytesUrl: z.string().url() }),
  requiredCapabilities: z.array(z.string()),
  requiredSecrets: z.array(z.string()),
});

// §6.5
export const WorkAcceptedSchema = z.object({
  taskId: UuidSchema,
  runId: UuidSchema,
  leaseId: UuidSchema,
  persistedAt: DateTimeSchema,
  planRevisionDigest: Sha256HexSchema,
});

// §6.6
export const WorkDeclinedSchema = z.object({
  taskId: UuidSchema,
  runId: UuidSchema,
  leaseId: UuidSchema,
  reason: z.enum([
    "REPO_BASE_UNAVAILABLE",
    "SECRET_MISSING",
    "CAPABILITY_MISSING",
    "POLICY_BUNDLE_UNSUPPORTED",
    "CAPACITY",
  ]),
  detail: z.string().max(2000).optional(),
  retryAfterMs: z.number().int().positive().optional(),
});

// §6.7
export const LeaseRenewedSchema = z.object({
  leaseId: UuidSchema,
  runId: UuidSchema,
  expiresAt: DateTimeSchema,
});

// §6.8
export const LeaseRevokedSchema = z.object({
  leaseId: UuidSchema,
  runId: UuidSchema,
  reason: z.enum([
    "OPERATOR_STOP",
    "POLICY_CHANGE",
    "SUPERSEDED",
    "NODE_DEGRADED",
  ]),
  stopDeadlineAt: DateTimeSchema,
});

// §6.9
export const RunCancelRequestedSchema = z.object({
  runId: UuidSchema,
  reason: z.string().max(2000),
  deadlineAt: DateTimeSchema,
});

// §6.10
export const RunMessagePostedSchema = z.object({
  runId: UuidSchema,
  operatorMessageId: UuidSchema,
  body: z.string().min(1).max(16384),
  postedBy: z.string(),
  postedAt: DateTimeSchema,
});

// §6.11
export const NodeEventSchema = z.object({
  cursor: CursorSchema,
  eventId: UuidSchema,
  runId: UuidSchema.optional(),
  taskId: UuidSchema.optional(),
  kind: z.string(),
  occurredAt: DateTimeSchema,
  data: z.record(z.string(), z.unknown()),
});
export const RunEventBatchSchema = z.object({
  batchId: UuidSchema,
  firstCursor: CursorSchema,
  lastCursor: CursorSchema,
  events: z.array(NodeEventSchema).min(1).max(256),
  truncatedPendingReconcile: z.boolean().default(false),
}).superRefine((batch, ctx) => {
  const expectedLast = batch.firstCursor + batch.events.length - 1;
  if (batch.lastCursor !== expectedLast) {
    ctx.addIssue({
      code: "custom",
      path: ["lastCursor"],
      message: "lastCursor must equal firstCursor plus event count minus one",
    });
  }
  batch.events.forEach((event, index) => {
    const expected = batch.firstCursor + index;
    if (event.cursor !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["events", index, "cursor"],
        message: `event cursor must be contiguous at ${expected}`,
      });
    }
  });
});

// §6.12
export const ArtifactDeclaredSchema = z.object({
  artifactId: UuidSchema,
  runId: UuidSchema,
  taskId: UuidSchema,
  kind: z.string(),
  mediaType: z.string(),
  sizeBytes: z.number().int().positive(),
  digest: Sha256HexSchema,
  partSizeBytes: z.literal(8388608),
  partCount: z.number().int().positive(),
  redactionState: z.enum(["none", "redacted"]),
  provenance: z.object({
    producer: z.string(),
    stepId: z.string().optional(),
  }),
});

// §6.13
export const ArtifactUploadGrantedSchema = z.object({
  artifactId: UuidSchema,
  uploadId: z.string(),
  parts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      url: z.string().url(),
      expiresAt: DateTimeSchema,
      maxBytes: z.number().int().positive(),
    }),
  ),
  committedParts: z.array(
    z.object({
      partNumber: z.number().int().positive(),
      digest: Sha256HexSchema,
    }),
  ),
});

// §6.14
export const ArtifactCommittedSchema = z.object({
  artifactId: UuidSchema,
  uploadId: z.string(),
  sizeBytes: z.number().int().positive(),
  digest: Sha256HexSchema,
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        sizeBytes: z.number().int().positive(),
        digest: Sha256HexSchema,
      }),
    )
    .min(1),
});

// §6.15
export const RunCompletionProposedSchema = z.object({
  runId: UuidSchema,
  taskId: UuidSchema,
  taskRevision: z.number().int().positive(),
  planRevisionDigest: Sha256HexSchema,
  outcome: z.enum(["succeeded", "failed", "stopped", "stale", "unknown"]),
  completionDigest: Sha256HexSchema,
  evidenceManifestDigest: Sha256HexSchema,
  finalCursor: CursorSchema,
  verification: z
    .object({
      status: z.enum(["passed", "failed", "error", "cancelled"]),
      artifactId: UuidSchema,
    })
    .optional(),
});

// §6.16
export const RunCompletionAcceptedSchema = z.object({
  runId: UuidSchema,
  completionDigest: Sha256HexSchema,
  taskStatus: z.enum(["needs-review", "done", "blocked", "queued"]),
});

// §6.17
export const ReviewDecisionSchema = z.object({
  reviewId: UuidSchema,
  taskId: UuidSchema,
  runId: UuidSchema,
  subjectDigest: Sha256HexSchema,
  decision: z.enum([
    "approved",
    "rework-requested",
    "rejected",
    "expired",
    "superseded",
  ]),
  decidedBy: z.string(),
  decidedAt: DateTimeSchema,
  feedback: z
    .object({
      note: z.string().max(16384),
      criterionIds: z.array(z.string()),
    })
    .optional(),
});

// §6.18
export const EffectGrantedSchema = z.object({
  grantId: UuidSchema,
  effectKey: z.string(),
  runId: UuidSchema,
  taskId: UuidSchema,
  kind: z.string(),
  parametersDigest: Sha256HexSchema,
  providerTarget: z.string(),
  riskClass: z.string(),
  expiresAt: DateTimeSchema,
  compensation: z
    .object({ kind: z.string(), parametersDigest: Sha256HexSchema })
    .optional(),
});

// §6.19
export const EffectRevokedSchema = z.object({
  grantId: UuidSchema,
  effectKey: z.string(),
  reason: z.string().max(2000),
});

// §6.20
export const EffectObservedSchema = z.object({
  grantId: UuidSchema,
  effectKey: z.string(),
  runId: UuidSchema,
  status: z.enum([
    "succeeded",
    "failed",
    "unknown",
    "compensating",
    "compensated",
  ]),
  receipt: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(2000).optional(),
  observedAt: DateTimeSchema,
});

// §6.21
export const MessageAckSchema = z.object({
  ackFor: UuidSchema,
  cursorAck: z
    .object({
      highestContiguousCursor: CursorSchema,
      gaps: z.array(
        z.object({ fromCursor: CursorSchema, toCursor: CursorSchema }),
      ),
    })
    .optional(),
});

// §6.22
export const NackCodeSchema = z.enum([
  "SIGNATURE_INVALID",
  "CLOCK_SKEW_EXCEEDED",
  "SCHEMA_VIOLATION",
  "VERSION_UNSUPPORTED",
  "SEQUENCE_REGRESSION",
  "IDEMPOTENCY_CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNKNOWN_TYPE",
  "EXPIRED",
  "RATE_LIMITED",
  "LEASE_UNKNOWN",
  "SUBJECT_STALE",
  "CAPABILITY_MISSING",
  "ARTIFACT_DIGEST_MISMATCH",
  "ARTIFACT_SIZE_MISMATCH",
]);
export const MessageNackSchema = z.object({
  nackFor: UuidSchema,
  code: NackCodeSchema,
  retryable: z.boolean(),
  detail: z.string().max(2000).optional(),
});

// §6.23
export const ReconcileSummarySchema = z.object({
  nodeCursor: CursorSchema,
  cloudCursorApplied: CursorSchema,
  activeLeases: z.array(
    z.object({
      leaseId: UuidSchema,
      runId: UuidSchema,
      expiresAt: DateTimeSchema,
    }),
  ),
  unknownRuns: z.array(z.object({ runId: UuidSchema, reason: z.string() })),
  artifactManifestDigests: z.array(Sha256HexSchema),
  truncations: z.array(
    z.object({
      runId: UuidSchema.optional(),
      fromCursor: CursorSchema,
      toCursor: CursorSchema,
      reason: z.enum(["BUFFER_BYTES", "BUFFER_AGE"]),
    }),
  ),
});

// §6.24
export const ReconcileRequestSchema = z.object({
  missingRanges: z.array(
    z.object({ fromCursor: CursorSchema, toCursor: CursorSchema }),
  ),
  quarantine: z.array(
    z.object({ runId: UuidSchema, reason: z.string().max(2000) }),
  ),
});

export const MESSAGE_SCHEMAS = {
  "node.hello": NodeHelloSchema,
  "node.welcome": NodeWelcomeSchema,
  "node.heartbeat": NodeHeartbeatSchema,
  "work.offer": WorkOfferSchema,
  "work.accepted": WorkAcceptedSchema,
  "work.declined": WorkDeclinedSchema,
  "lease.renewed": LeaseRenewedSchema,
  "lease.revoked": LeaseRevokedSchema,
  "run.cancel_requested": RunCancelRequestedSchema,
  "run.message_posted": RunMessagePostedSchema,
  "run.event_batch": RunEventBatchSchema,
  "artifact.declared": ArtifactDeclaredSchema,
  "artifact.upload_granted": ArtifactUploadGrantedSchema,
  "artifact.committed": ArtifactCommittedSchema,
  "run.completion_proposed": RunCompletionProposedSchema,
  "run.completion_accepted": RunCompletionAcceptedSchema,
  "review.decision": ReviewDecisionSchema,
  "effect.granted": EffectGrantedSchema,
  "effect.revoked": EffectRevokedSchema,
  "effect.observed": EffectObservedSchema,
  "message.ack": MessageAckSchema,
  "message.nack": MessageNackSchema,
  "reconcile.summary": ReconcileSummarySchema,
  "reconcile.request": ReconcileRequestSchema,
} as const;

export type AccpMessageType = keyof typeof MESSAGE_SCHEMAS;
export const MESSAGE_TYPES = Object.keys(MESSAGE_SCHEMAS) as AccpMessageType[];

export function isAccpMessageType(type: string): type is AccpMessageType {
  return Object.hasOwn(MESSAGE_SCHEMAS, type);
}

/** Validate a payload against its message type. Throws ZodError on failure. */
export function parsePayload<T extends AccpMessageType>(
  type: T,
  payload: unknown,
): z.infer<(typeof MESSAGE_SCHEMAS)[T]> {
  return MESSAGE_SCHEMAS[type].parse(payload) as z.infer<
    (typeof MESSAGE_SCHEMAS)[T]
  >;
}
