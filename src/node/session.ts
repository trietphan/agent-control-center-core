// ACCP v1 node session state machine.
import type { KeyObject } from "node:crypto";
import {
  MessageDedupIndex,
  type Envelope,
} from "../accp/envelope.js";
import {
  isAccpMessageType,
  parsePayload,
  type AccpMessageType,
  type NodeWelcomeSchema,
} from "../accp/messages.js";
import { sealEnvelope, verifySealedEnvelope } from "../accp/seal.js";
import { uuidV7 } from "../accp/ids.js";
import type { z } from "zod";
import type { KernelBridge } from "../kernel/bridge.js";
import type { NodeCredentials } from "./enrollment.js";
import {
  InMemoryNodeStateStore,
  type NodeEvent,
  type NodeStateStore,
  type Truncation,
} from "./state-store.js";

export type { Truncation } from "./state-store.js";

type Welcome = z.infer<typeof NodeWelcomeSchema>;

const PROTOCOL = "accp/1.0";
// Event kinds in the terminal/evidence class are never dropped by the
// buffer overflow policy (accp-v1.md §8.3).
const PROTECTED_KIND_PREFIXES = ["run.completion", "effect.", "verification."];

export interface NodeSessionOptions {
  credentials: NodeCredentials;
  privateKey: KeyObject;
  kernel: KernelBridge;
  schemaBundleDigest: string;
  /** Overflow bound on buffered (unacked) events; §8.3. */
  maxBufferedEvents?: number;
  /** Durable journal/outbox (NODE-001). Defaults to in-memory; pass a
   * SqliteNodeStateStore so a node process restart resumes cursors, the
   * event log, offer answers, and truncations exactly. */
  store?: NodeStateStore;
}

export class NodeSession {
  readonly #creds: NodeCredentials;
  readonly #key: KeyObject;
  readonly #kernel: KernelBridge;
  readonly #schemaDigest: string;
  readonly #maxBufferedEvents: number;

  // Durable state (survives reconnects AND process restarts) is delegated
  // to the NodeStateStore journal; the cursors and offer answers are cached
  // here and written through on every change.
  readonly #store: NodeStateStore;
  #nodeCursor: number;
  #ackedCursor: number;
  readonly #offerAnswers: Map<string, { type: string; payload: unknown }>;

  // Per-connection state.
  #sessionId = "";
  #epoch: number | null = null;
  #outSeq = 0;
  #welcome: Welcome | null = null;
  #dedup = new MessageDedupIndex();
  #connected = false;

  constructor(options: NodeSessionOptions) {
    this.#creds = options.credentials;
    this.#key = options.privateKey;
    this.#kernel = options.kernel;
    this.#schemaDigest = options.schemaBundleDigest;
    this.#maxBufferedEvents = options.maxBufferedEvents ?? 10_000;
    this.#store = options.store ?? new InMemoryNodeStateStore();
    const cursors = this.#store.loadCursors();
    this.#nodeCursor = cursors.nodeCursor;
    this.#ackedCursor = cursors.ackedCursor;
    this.#offerAnswers = this.#store.loadOfferAnswers();
  }

  /** Truncation records (durable; reported via reconcile.summary §8.3). */
  get truncations(): Truncation[] {
    return this.#store.loadTruncations();
  }

  get connected(): boolean {
    return this.#connected;
  }

  get nodeCursor(): number {
    return this.#nodeCursor;
  }

  get ackedCursor(): number {
    return this.#ackedCursor;
  }

  #seal(
    type: AccpMessageType,
    payload: unknown,
    now: Date,
    extra: Partial<Pick<Envelope, "idempotencyKey" | "causationId" | "expiresAt">> = {},
  ): Envelope {
    this.#outSeq += 1;
    return sealEnvelope(
      {
        protocol: PROTOCOL,
        schemaDigest: this.#schemaDigest,
        type,
        messageId: uuidV7(now.getTime()),
        sessionId: this.#sessionId,
        workspaceId: this.#creds.workspaceId,
        senderId: `node:${this.#creds.nodeId}`,
        sequence: this.#outSeq,
        sentAt: now.toISOString(),
        payload,
        ...extra,
      },
      this.#key,
    );
  }

  /** Open a new connection attempt: fresh sessionId, hello at sequence 1. */
  startHandshake(now: Date): Envelope {
    this.#sessionId = uuidV7(now.getTime());
    this.#epoch = null;
    this.#outSeq = 0;
    this.#welcome = null;
    this.#connected = false;
    this.#dedup = new MessageDedupIndex();
    return this.#seal(
      "node.hello",
      {
        supportedProtocols: [PROTOCOL],
        schemaBundleDigest: this.#schemaDigest,
        nodeVersion: "0.1.0-skeleton",
        platform: `${process.platform}-${process.arch}`,
        adapterManifests: [],
        capabilities: ["worktree"],
        capacity: { maxConcurrentRuns: 1, availableRuns: 1 },
        // Commands are deduplicated by idempotencyKey (accp-v1.md §4.3);
        // command envelopes do not carry an outbox cursor in v1, so the
        // node reports 0 and relies on cloud replaying unacked commands.
        // Spec refinement candidate: stamp outbox cursors onto commands.
        resume: { cloudCursor: 0, nodeCursor: this.#nodeCursor },
      },
      now,
    );
  }

  /** Simulate a dropped connection (state that does not survive sockets). */
  disconnect(): void {
    this.#connected = false;
    this.#welcome = null;
    this.#epoch = null;
  }

  /** Append a local execution fact to the durable log; returns nothing —
   * call flush() to obtain batches for the wire. */
  emitEvent(
    kind: string,
    data: Record<string, unknown>,
    ids: { runId?: string; taskId?: string },
    now: Date,
  ): NodeEvent {
    const cursor = this.#nodeCursor + 1;
    const event: NodeEvent = {
      cursor,
      eventId: uuidV7(now.getTime()),
      kind,
      occurredAt: now.toISOString(),
      data,
      ...(ids.runId === undefined ? {} : { runId: ids.runId }),
      ...(ids.taskId === undefined ? {} : { taskId: ids.taskId }),
    };
    this.#store.appendEventAndAdvanceCursor(event);
    this.#nodeCursor = cursor;
    this.#enforceBufferBounds();
    return event;
  }

  #enforceBufferBounds(): void {
    let unacked = this.#store.eventsAfter(this.#ackedCursor);
    if (unacked.length <= this.#maxBufferedEvents) return;
    const dropped: number[] = [];
    while (unacked.length > this.#maxBufferedEvents) {
      const victim = unacked.find(
        (e) => !PROTECTED_KIND_PREFIXES.some((p) => e.kind.startsWith(p)),
      );
      if (!victim) break; // only protected events remain: never dropped
      this.#store.deleteEventAt(victim.cursor);
      dropped.push(victim.cursor);
      unacked = this.#store.eventsAfter(this.#ackedCursor);
    }
    for (const [fromCursor, toCursor] of contiguousRanges(dropped)) {
      this.#store.appendTruncation({
        fromCursor,
        toCursor,
        reason: "BUFFER_BYTES",
      });
    }
  }

  /** Batch all unacked events (from a given cursor) for the wire. */
  flush(now: Date, fromCursor?: number): Envelope[] {
    if (!this.#connected || !this.#welcome) return [];
    const floor = fromCursor ?? this.#ackedCursor;
    const pending = this.#store.eventsAfter(floor);
    const out: Envelope[] = [];
    const size = this.#welcome.limits.maxEventsPerBatch;
    for (const run of contiguousEventRuns(pending)) {
      for (let i = 0; i < run.length; i += size) {
        const events = run.slice(i, i + size);
        const first = events[0]!;
        const last = events[events.length - 1]!;
        out.push(
          this.#seal(
            "run.event_batch",
            {
              batchId: uuidV7(now.getTime()),
              firstCursor: first.cursor,
              lastCursor: last.cursor,
              events,
              truncatedPendingReconcile: this.truncations.length > 0,
            },
            now,
          ),
        );
        if (out.length >= this.#welcome.limits.maxUnackedBatches) return out;
      }
    }
    return out;
  }

  /** Propose the terminal completion of a run (accp-v1.md §6.15). */
  proposeCompletion(payload: unknown, now: Date): Envelope {
    const completion = parsePayload("run.completion_proposed", payload);
    return this.#seal("run.completion_proposed", completion, now, {
      idempotencyKey: `completion:${completion.runId}:${completion.completionDigest}`,
    });
  }

  reconcileSummary(now: Date): Envelope {
    return this.#seal(
      "reconcile.summary",
      {
        nodeCursor: this.#nodeCursor,
        cloudCursorApplied: 0,
        activeLeases: [],
        unknownRuns: [],
        artifactManifestDigests: [],
        truncations: this.truncations,
      },
      now,
    );
  }

  /** Handle one inbound envelope; returns envelopes to send back. */
  receive(raw: unknown, now: Date): Envelope[] {
    const result = verifySealedEnvelope(raw, this.#creds.cloudPublicKeyPem, now.getTime());
    if (!result.ok) {
      // A malformed or forged message is never processed (fail closed);
      // nack only when we can attribute a messageId to answer.
      const messageId =
        typeof raw === "object" && raw !== null && "messageId" in raw
          ? String((raw as { messageId: unknown }).messageId)
          : null;
      if (messageId === null || result.code === "SIGNATURE_INVALID") return [];
      return [
        this.#seal("message.nack", {
          nackFor: messageId,
          code: result.code === "UNKNOWN_TYPE" ? "UNKNOWN_TYPE" : result.code,
          retryable: result.code === "EXPIRED",
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        }, now),
      ];
    }
    const { envelope } = result;
    if (!this.#isExpectedCloudEnvelope(envelope)) {
      return [
        this.#seal("message.nack", {
          nackFor: envelope.messageId,
          code: "SCHEMA_VIOLATION",
          retryable: false,
          detail: "unexpected protocol, sender, workspace, or node session",
        }, now),
      ];
    }
    if (this.#dedup.check(envelope.messageId)) return [];

    switch (envelope.type) {
      case "node.welcome": {
        const welcome = parsePayload("node.welcome", envelope.payload);
        if (this.#epoch !== null && welcome.connectionEpoch < this.#epoch) {
          // Split-brain cloud: never silently accept (accp-v1.md §6.2).
          this.disconnect();
          return [];
        }
        this.#welcome = welcome;
        this.#epoch = welcome.connectionEpoch;
        this.#connected = true;
        // Replay everything cloud has not durably ingested, both ways.
        const replays = this.flush(now, welcome.nodeCursorAck);
        const summary =
          this.truncations.length > 0 ? [this.reconcileSummary(now)] : [];
        return [...summary, ...replays];
      }
      case "message.ack": {
        const ack = parsePayload("message.ack", envelope.payload);
        if (ack.cursorAck) {
          this.#ackedCursor = Math.max(
            this.#ackedCursor,
            ack.cursorAck.highestContiguousCursor,
          );
          this.#store.setAckedCursor(this.#ackedCursor);
          this.#store.pruneUpTo(this.#ackedCursor);
        }
        return [];
      }
      case "work.offer": {
        const offer = parsePayload("work.offer", envelope.payload);
        const idem = envelope.idempotencyKey!;
        const answered = this.#offerAnswers.get(idem);
        if (answered && isAccpMessageType(answered.type)) {
          // Replayed offer: replay the stored answer verbatim (§6.4).
          return [
            this.#seal(answered.type, answered.payload, now, {
              idempotencyKey: idem,
              causationId: envelope.messageId,
            }),
          ];
        }
        const decision = this.#kernel.decideOffer(offer);
        const base = {
          taskId: offer.taskId,
          runId: offer.runId,
          leaseId: offer.lease.leaseId,
        };
        const [type, payload]: [AccpMessageType, unknown] =
          decision.action === "accept"
            ? [
                "work.accepted",
                {
                  ...base,
                  persistedAt: now.toISOString(),
                  planRevisionDigest: offer.planRevision.digest,
                },
              ]
            : [
                "work.declined",
                {
                  ...base,
                  reason: decision.reason,
                  ...(decision.detail === undefined
                    ? {}
                    : { detail: decision.detail }),
                },
              ];
        this.#offerAnswers.set(idem, { type, payload });
        this.#store.saveOfferAnswer(idem, type, payload);
        return [
          this.#seal(type, payload, now, {
            idempotencyKey: idem,
            causationId: envelope.messageId,
          }),
        ];
      }
      case "review.decision": {
        const decision = parsePayload("review.decision", envelope.payload);
        this.#kernel.onReviewDecision?.(decision);
        return [this.#seal("message.ack", { ackFor: envelope.messageId }, now)];
      }
      case "run.completion_accepted":
      case "lease.renewed":
      case "lease.revoked":
      case "run.cancel_requested":
      case "reconcile.request": {
        // Skeleton: acknowledge durable receipt; kernel-side behavior for
        // these lands with the real coordinator binding.
        return [this.#seal("message.ack", { ackFor: envelope.messageId }, now)];
      }
      default:
        return [
          this.#seal("message.nack", {
            nackFor: envelope.messageId,
            code: "UNKNOWN_TYPE",
            retryable: false,
          }, now),
        ];
    }
  }

  #isExpectedCloudEnvelope(envelope: Envelope): boolean {
    if (envelope.protocol !== PROTOCOL) return false;
    if (envelope.senderId !== "cloud") return false;
    if (envelope.workspaceId !== this.#creds.workspaceId) return false;
    return envelope.sessionId === this.#sessionId;
  }
}

function contiguousRanges(cursors: number[]): Array<[number, number]> {
  const sorted = [...new Set(cursors)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const cursor of sorted) {
    const last = ranges.at(-1);
    if (last && cursor === last[1] + 1) {
      last[1] = cursor;
    } else {
      ranges.push([cursor, cursor]);
    }
  }
  return ranges;
}

function contiguousEventRuns<T extends { cursor: number }>(events: T[]): T[][] {
  const runs: T[][] = [];
  for (const event of events) {
    const last = runs.at(-1);
    const previous = last?.at(-1);
    if (last && previous && event.cursor === previous.cursor + 1) {
      last.push(event);
    } else {
      runs.push([event]);
    }
  }
  return runs;
}
