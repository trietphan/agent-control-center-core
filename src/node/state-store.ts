// NodeStateStore: the durable half of NodeSession — the NODE-001 "local
// journal/outbox". Everything a node must not lose across a process restart
// lives behind this interface: the outbound event journal and its two
// cursors (accp-v1.md §3), stored offer answers replayed verbatim on
// redelivery (§4.3), and buffer-overflow truncation records reported via
// reconcile.summary (§8.3).
//
// Two implementations:
// - InMemoryNodeStateStore: the pre-existing in-memory behavior, extracted
//   verbatim; used by tests and as the NodeSession default.
// - SqliteNodeStateStore: a single-file SQLite journal (WAL mode) built on
//   the node:sqlite DatabaseSync API. DatabaseSync is *synchronous*, which
//   is exactly why we do not reuse the async `sqlite`/`sqlite3` packages
//   already in package.json: NodeSession is a sans-IO synchronous state
//   machine, and its durable writes must be committed before the envelope
//   that references them is handed to the transport.
//
// Compatibility note: node:sqlite requires Node >= 22.5, while the repo's
// engines still allow Node 20. That is safe because node:sqlite is resolved
// lazily inside the SqliteNodeStateStore constructor (the import above is
// type-only and erased at compile time) and the store is only loaded by the
// federation runtime, never by the classic CLI path.
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import type { z } from "zod";
import { NodeEventSchema } from "../accp/messages.js";

export type NodeEvent = z.infer<typeof NodeEventSchema>;

export interface Truncation {
  fromCursor: number;
  toCursor: number;
  reason: "BUFFER_BYTES" | "BUFFER_AGE";
}

/**
 * Durable node-session state. All methods are synchronous: a write that has
 * returned is durable (for SQLite, committed to the database file), so the
 * session may reference it in outbound envelopes immediately.
 */
export interface NodeStateStore {
  /** Both cursor-space positions (accp-v1.md §3); 0 when never written. */
  loadCursors(): { nodeCursor: number; ackedCursor: number };
  setNodeCursor(n: number): void;
  setAckedCursor(n: number): void;
  /** Append one event to the journal. Cursors are unique and ascending. */
  appendEvent(event: NodeEvent): void;
  /** Append one event and advance node_cursor in the same durable commit. */
  appendEventAndAdvanceCursor(event: NodeEvent): void;
  /** Events with cursor strictly greater than `cursor`, ascending. */
  eventsAfter(cursor: number): NodeEvent[];
  /** Drop every event with cursor <= `cursor` (acked; §4.3). */
  pruneUpTo(cursor: number): void;
  /** Drop a single event (buffer-overflow victim; §8.3). */
  deleteEventAt(cursor: number): void;
  /** Record the answer to a work.offer so replays answer identically. */
  saveOfferAnswer(key: string, type: string, payload: unknown): void;
  loadOfferAnswers(): Map<string, { type: string; payload: unknown }>;
  appendTruncation(t: {
    fromCursor: number;
    toCursor: number;
    reason: string;
  }): void;
  loadTruncations(): Truncation[];
}

const TRUNCATION_REASONS: ReadonlySet<string> = new Set([
  "BUFFER_BYTES",
  "BUFFER_AGE",
]);

function asTruncationReason(reason: string): Truncation["reason"] {
  if (!TRUNCATION_REASONS.has(reason)) {
    throw new Error(`unknown truncation reason: ${reason}`);
  }
  return reason as Truncation["reason"];
}

/** The previous in-memory NodeSession state, behind the store interface. */
export class InMemoryNodeStateStore implements NodeStateStore {
  #nodeCursor = 0;
  #ackedCursor = 0;
  #events: NodeEvent[] = [];
  readonly #offerAnswers = new Map<string, { type: string; payload: unknown }>();
  readonly #truncations: Truncation[] = [];

  loadCursors(): { nodeCursor: number; ackedCursor: number } {
    return { nodeCursor: this.#nodeCursor, ackedCursor: this.#ackedCursor };
  }

  setNodeCursor(n: number): void {
    this.#nodeCursor = n;
  }

  setAckedCursor(n: number): void {
    this.#ackedCursor = n;
  }

  appendEvent(event: NodeEvent): void {
    this.#events.push(event);
  }

  appendEventAndAdvanceCursor(event: NodeEvent): void {
    if (event.cursor !== this.#nodeCursor + 1) {
      throw new Error(
        `node state store: expected cursor ${this.#nodeCursor + 1}, got ${event.cursor}`,
      );
    }
    if (this.#events.some((existing) => existing.cursor === event.cursor)) {
      throw new Error(`node state store: duplicate event cursor ${event.cursor}`);
    }
    this.#events = [...this.#events, event];
    this.#nodeCursor = event.cursor;
  }

  eventsAfter(cursor: number): NodeEvent[] {
    return this.#events
      .filter((e) => e.cursor > cursor)
      .sort((a, b) => a.cursor - b.cursor);
  }

  pruneUpTo(cursor: number): void {
    this.#events = this.#events.filter((e) => e.cursor > cursor);
  }

  deleteEventAt(cursor: number): void {
    this.#events = this.#events.filter((e) => e.cursor !== cursor);
  }

  saveOfferAnswer(key: string, type: string, payload: unknown): void {
    this.#offerAnswers.set(key, { type, payload });
  }

  loadOfferAnswers(): Map<string, { type: string; payload: unknown }> {
    return new Map(this.#offerAnswers);
  }

  appendTruncation(t: {
    fromCursor: number;
    toCursor: number;
    reason: string;
  }): void {
    this.#truncations.push({
      fromCursor: t.fromCursor,
      toCursor: t.toCursor,
      reason: asTruncationReason(t.reason),
    });
  }

  loadTruncations(): Truncation[] {
    return [...this.#truncations];
  }
}

type SqliteModule = typeof import("node:sqlite");

/** Resolve node:sqlite at construction time, failing with a clear message
 * on runtimes that predate it (see the file-header compatibility note). */
function loadNodeSqlite(): SqliteModule {
  const proc = process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
  };
  const mod =
    typeof proc.getBuiltinModule === "function"
      ? proc.getBuiltinModule.call(process, "node:sqlite")
      : undefined;
  if (mod === undefined || mod === null) {
    throw new Error(
      "SqliteNodeStateStore requires the node:sqlite built-in (Node.js >= 22.5); " +
        "this runtime does not provide it",
    );
  }
  return mod as SqliteModule;
}

function readNumber(
  row: Record<string, SQLOutputValue>,
  column: string,
): number {
  const value = row[column];
  if (typeof value !== "number") {
    throw new Error(`node state store: expected number in column ${column}`);
  }
  return value;
}

function readString(
  row: Record<string, SQLOutputValue>,
  column: string,
): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`node state store: expected string in column ${column}`);
  }
  return value;
}

const SCHEMA_VERSION = 1;

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS node_events (
  cursor INTEGER PRIMARY KEY,
  event_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_cursors (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS offer_answers (
  idem_key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS truncations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_cursor INTEGER,
  to_cursor INTEGER,
  reason TEXT
);
`;

/** SQLite-backed journal. One database file per node identity. */
export class SqliteNodeStateStore implements NodeStateStore {
  readonly #db: DatabaseSync;
  readonly #selectCursor: StatementSync;
  readonly #upsertCursor: StatementSync;
  readonly #insertEvent: StatementSync;
  readonly #selectEventsAfter: StatementSync;
  readonly #deleteUpTo: StatementSync;
  readonly #deleteAt: StatementSync;
  readonly #upsertOfferAnswer: StatementSync;
  readonly #selectOfferAnswers: StatementSync;
  readonly #insertTruncation: StatementSync;
  readonly #selectTruncations: StatementSync;

  constructor(path: string) {
    const sqlite = loadNodeSqlite();
    this.#db = new sqlite.DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
    this.#selectCursor = this.#db.prepare(
      "SELECT value FROM node_cursors WHERE key = ?",
    );
    this.#upsertCursor = this.#db.prepare(
      "INSERT INTO node_cursors (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.#insertEvent = this.#db.prepare(
      "INSERT INTO node_events (cursor, event_json) VALUES (?, ?)",
    );
    this.#selectEventsAfter = this.#db.prepare(
      "SELECT event_json FROM node_events WHERE cursor > ? ORDER BY cursor ASC",
    );
    this.#deleteUpTo = this.#db.prepare(
      "DELETE FROM node_events WHERE cursor <= ?",
    );
    this.#deleteAt = this.#db.prepare(
      "DELETE FROM node_events WHERE cursor = ?",
    );
    this.#upsertOfferAnswer = this.#db.prepare(
      "INSERT INTO offer_answers (idem_key, type, payload_json) VALUES (?, ?, ?) " +
        "ON CONFLICT(idem_key) DO UPDATE SET " +
        "type = excluded.type, payload_json = excluded.payload_json",
    );
    this.#selectOfferAnswers = this.#db.prepare(
      "SELECT idem_key, type, payload_json FROM offer_answers",
    );
    this.#insertTruncation = this.#db.prepare(
      "INSERT INTO truncations (from_cursor, to_cursor, reason) VALUES (?, ?, ?)",
    );
    this.#selectTruncations = this.#db.prepare(
      "SELECT from_cursor, to_cursor, reason FROM truncations ORDER BY id ASC",
    );
  }

  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get();
    const version = row === undefined ? 0 : readNumber(row, "user_version");
    if (version === 0) {
      this.#db.exec(
        `BEGIN;${SCHEMA_DDL}PRAGMA user_version = ${SCHEMA_VERSION};COMMIT;`,
      );
      return;
    }
    if (version !== SCHEMA_VERSION) {
      throw new Error(
        `node state store: unsupported schema version ${version} ` +
          `(this build supports ${SCHEMA_VERSION})`,
      );
    }
  }

  /** Release the underlying database handle (e.g. before a restart test
   * reopens the same file). Not part of NodeStateStore: the in-memory
   * implementation has nothing to close. */
  close(): void {
    this.#db.close();
  }

  #cursorValue(key: string): number {
    const row = this.#selectCursor.get(key);
    return row === undefined ? 0 : readNumber(row, "value");
  }

  loadCursors(): { nodeCursor: number; ackedCursor: number } {
    return {
      nodeCursor: this.#cursorValue("node_cursor"),
      ackedCursor: this.#cursorValue("acked_cursor"),
    };
  }

  setNodeCursor(n: number): void {
    this.#upsertCursor.run("node_cursor", n);
  }

  setAckedCursor(n: number): void {
    this.#upsertCursor.run("acked_cursor", n);
  }

  appendEvent(event: NodeEvent): void {
    this.#insertEvent.run(event.cursor, JSON.stringify(event));
  }

  appendEventAndAdvanceCursor(event: NodeEvent): void {
    const expected = this.#cursorValue("node_cursor") + 1;
    if (event.cursor !== expected) {
      throw new Error(
        `node state store: expected cursor ${expected}, got ${event.cursor}`,
      );
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertEvent.run(event.cursor, JSON.stringify(event));
      this.#upsertCursor.run("node_cursor", event.cursor);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(cursor: number): NodeEvent[] {
    return this.#selectEventsAfter
      .all(cursor)
      .map((row) =>
        NodeEventSchema.parse(JSON.parse(readString(row, "event_json"))),
      );
  }

  pruneUpTo(cursor: number): void {
    this.#deleteUpTo.run(cursor);
  }

  deleteEventAt(cursor: number): void {
    this.#deleteAt.run(cursor);
  }

  saveOfferAnswer(key: string, type: string, payload: unknown): void {
    this.#upsertOfferAnswer.run(key, type, JSON.stringify(payload ?? null));
  }

  loadOfferAnswers(): Map<string, { type: string; payload: unknown }> {
    const answers = new Map<string, { type: string; payload: unknown }>();
    for (const row of this.#selectOfferAnswers.all()) {
      answers.set(readString(row, "idem_key"), {
        type: readString(row, "type"),
        payload: JSON.parse(readString(row, "payload_json")) as unknown,
      });
    }
    return answers;
  }

  appendTruncation(t: {
    fromCursor: number;
    toCursor: number;
    reason: string;
  }): void {
    // Validate on the way in so garbage never enters the journal.
    this.#insertTruncation.run(
      t.fromCursor,
      t.toCursor,
      asTruncationReason(t.reason),
    );
  }

  loadTruncations(): Truncation[] {
    return this.#selectTruncations.all().map((row) => ({
      fromCursor: readNumber(row, "from_cursor"),
      toCursor: readNumber(row, "to_cursor"),
      reason: asTruncationReason(readString(row, "reason")),
    }));
  }
}
