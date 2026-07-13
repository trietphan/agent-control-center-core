import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import sqlite3 from "sqlite3";
import { open, type Database } from "sqlite";
import {
  AgentKindSchema,
  ArtifactKindSchema,
  RoutePlanSchema,
  RouteRoleSchema,
  RunStatusSchema,
  TaskPayloadSchema,
  TaskStatusSchema,
  assertRunTransition,
  assertTaskTransition,
  type AgentKind,
  type ArtifactKind,
  type RoutePlan,
  type RouteRole,
  type RunStatus,
  type TaskPayload,
  type TaskStatus,
} from "./protocol.js";
import {
  ArtifactConflictError,
  type ArtifactMetadata,
} from "./artifacts.js";
import {
  MigrationVersionError,
  runMigrations,
  type Migration,
} from "./migrations/runner.js";
import { migration001Baseline } from "./migrations/001-baseline.js";
import { migration002RunUsage } from "./migrations/002-run-usage.js";

type SqliteDb = Database<sqlite3.Database, sqlite3.Statement>;
const CONTROL_CENTER_MIGRATIONS: Migration[] = [
  migration001Baseline,
  migration002RunUsage,
];

export type RouteStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";
export type EventLevel = "debug" | "info" | "warn" | "error";
export type ReviewStatus =
  | "pending"
  | "approved"
  | "rework_requested"
  | "rejected";

export interface TaskRecord extends Omit<TaskPayload, "id"> {
  id: string;
  status: TaskStatus;
  routePlan: RoutePlan;
  latestUpdate: string;
  claimedBy: string | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouteStepRecord {
  id: string;
  taskId: string;
  sequence: number;
  agent: AgentKind;
  role: RouteRole;
  required: boolean;
  reason: string;
  status: RouteStepStatus;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  routeStepId: string;
  adapterRunId: string | null;
  agent: AgentKind;
  role: RouteRole;
  attempt: number;
  status: RunStatus;
  pid: number | null;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  resultPath: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string | null;
  error: string | null;
  usageJson: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: number;
  taskId: string;
  runId: string | null;
  type: string;
  level: EventLevel;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  runId: string | null;
  kind: ArtifactKind;
  path: string;
  relativePath: string | null;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  taskId: string;
  runId: string | null;
  direction: "user-to-agent" | "agent-to-user" | "system";
  role: string;
  body: string;
  deliveryStatus: "queued" | "delivered" | "unsupported" | "failed";
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  taskId: string;
  runId: string | null;
  reviewer: string | null;
  status: ReviewStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAggregate {
  task: TaskRecord;
  routeSteps: RouteStepRecord[];
  runs: RunRecord[];
  events: EventRecord[];
  artifacts: ArtifactRecord[];
  messages: MessageRecord[];
  reviews: ReviewRecord[];
}

export interface StaleRecoveryResult {
  taskIds: string[];
  staleRunIds: string[];
  failedRunIds: string[];
  processCandidates: Array<{
    taskId: string;
    runId: string;
    pid: number;
    agent: "codex" | "claude" | "verifier";
  }>;
  remoteCandidates: Array<{
    taskId: string;
    runId: string;
    remoteId: string;
    agent: "openclaw";
  }>;
}

export interface RunListFilter {
  status?: RunStatus;
  agent?: AgentKind;
  limit?: number;
}

export interface ReviewListFilter {
  status?: ReviewStatus;
  limit?: number;
}

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  state: "pending" | "completed";
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: string;
  updatedAt: string;
}

export type IdempotencyClaim =
  | { kind: "new"; createdAt: string }
  | { kind: "pending"; createdAt: string; updatedAt: string }
  | { kind: "conflict" }
  | {
      kind: "replay";
      responseStatus: number;
      responseBody: unknown;
      completedAt: string;
    };

interface TaskRow {
  id: string;
  goal: string;
  repo: string;
  base_ref: string;
  requested_agent: string;
  priority: string;
  context: string | null;
  success_criteria_json: string;
  verification_command: string | null;
  handoff_required: number;
  status: string;
  route_mode: string;
  route_risk: string;
  route_reasons_json: string;
  latest_update: string;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RouteStepRow {
  id: string;
  task_id: string;
  sequence_no: number;
  agent: string;
  role: string;
  required: number;
  reason: string;
  status: RouteStepStatus;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  route_step_id: string;
  adapter_run_id: string | null;
  agent: string;
  role: string;
  attempt: number;
  status: string;
  pid: number | null;
  worktree_path: string | null;
  branch: string | null;
  base_commit: string | null;
  stdout_path: string | null;
  stderr_path: string | null;
  result_path: string | null;
  exit_code: number | null;
  signal: string | null;
  summary: string | null;
  error: string | null;
  usage_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewRow {
  id: string;
  task_id: string;
  run_id: string | null;
  reviewer: string | null;
  status: ReviewStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  task_id: string;
  run_id: string | null;
  type: string;
  level: EventLevel;
  message: string;
  data_json: string | null;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: string;
  path: string;
  relative_path: string | null;
  sha256: string;
  size_bytes: number;
  metadata_json: string | null;
  created_at: string;
}

interface IdempotencyRow {
  key: string;
  request_hash: string;
  state: "pending" | "completed";
  response_status: number | null;
  response_body_json: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function assertLimit(limit: number, maximum = 1_000): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Limit must be an integer between 1 and ${maximum}`);
  }
  return limit;
}

function normalizeIdempotencyValue(
  value: string,
  label: "Idempotency key" | "Request hash",
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 512) {
    throw new Error(`${label} must not exceed 512 characters`);
  }
  return normalized;
}

async function assertKnownSchemaVersion(db: SqliteDb): Promise<void> {
  const newestKnown = CONTROL_CENTER_MIGRATIONS.at(-1)?.version ?? 0;
  const row = await db.get<{ user_version: number }>("PRAGMA user_version");
  const version = row?.user_version ?? 0;
  if (version > newestKnown) {
    throw new MigrationVersionError(version, newestKnown);
  }
}

function eventFromRow(row: EventRow): EventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    type: row.type,
    level: row.level,
    message: row.message,
    data: row.data_json
      ? parseJson<Record<string, unknown>>(row.data_json, {})
      : null,
    createdAt: row.created_at,
  };
}

function idempotencyFromRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    key: row.key,
    requestHash: row.request_hash,
    state: row.state,
    responseStatus: row.response_status,
    responseBody:
      row.response_body_json === null
        ? null
        : parseJson<unknown>(row.response_body_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskFromRow(row: TaskRow): TaskRecord {
  const payload = TaskPayloadSchema.parse({
    id: row.id,
    goal: row.goal,
    repo: row.repo,
    baseRef: row.base_ref,
    agent: row.requested_agent,
    priority: row.priority,
    ...(row.context ? { context: row.context } : {}),
    successCriteria: parseJson<string[]>(row.success_criteria_json, []),
    ...(row.verification_command
      ? { verificationCommand: row.verification_command }
      : {}),
    handoffRequired: row.handoff_required === 1,
  });
  const routePlan = RoutePlanSchema.parse({
    mode: row.route_mode,
    risk: row.route_risk,
    reasons: parseJson<string[]>(row.route_reasons_json, []),
    // The canonical steps are returned from route_steps. Keep this placeholder
    // valid, then getTask() replaces it with persisted steps.
    steps: [
      {
        id: "placeholder",
        sequence: 0,
        agent: "codex",
        role: "execute",
        required: true,
        reason: "Loaded separately",
      },
    ],
  });
  return {
    id: row.id,
    goal: payload.goal,
    repo: payload.repo,
    baseRef: payload.baseRef,
    agent: payload.agent,
    priority: payload.priority,
    ...(payload.context ? { context: payload.context } : {}),
    successCriteria: payload.successCriteria,
    ...(payload.verificationCommand
      ? { verificationCommand: payload.verificationCommand }
      : {}),
    handoffRequired: payload.handoffRequired,
    status: TaskStatusSchema.parse(row.status),
    routePlan,
    latestUpdate: row.latest_update,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function routeStepFromRow(row: RouteStepRow): RouteStepRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence_no,
    agent: AgentKindSchema.parse(row.agent),
    role: RouteRoleSchema.parse(row.role),
    required: row.required === 1,
    reason: row.reason,
    status: row.status,
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    routeStepId: row.route_step_id,
    adapterRunId: row.adapter_run_id,
    agent: AgentKindSchema.parse(row.agent),
    role: RouteRoleSchema.parse(row.role),
    attempt: row.attempt,
    status: RunStatusSchema.parse(row.status),
    pid: row.pid,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseCommit: row.base_commit,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    resultPath: row.result_path,
    exitCode: row.exit_code,
    signal: row.signal,
    summary: row.summary,
    error: row.error,
    usageJson: row.usage_json,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRunInput {
  taskId: string;
  routeStepId: string;
  agent: AgentKind;
  role: RouteRole;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
}

export interface UpdateRunPatch {
  status?: RunStatus;
  adapterRunId?: string | null;
  pid?: number | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseCommit?: string | null;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  resultPath?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  summary?: string | null;
  error?: string | null;
  usageJson?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export class ControlCenterDb {
  readonly filename: string;
  readonly #connectionFilename: string;
  readonly #openMode: number | undefined;
  #db: SqliteDb | null = null;
  #transactionDb: SqliteDb | null = null;
  #initPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #closing = false;
  #transactionTail: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    if (filename === ":memory:") {
      this.filename = filename;
      // Two connections are required to keep transactions isolated from
      // ordinary reads/writes. A unique shared-cache URI preserves :memory:
      // semantics while letting both connections see the same database.
      this.#connectionFilename = `file:acc-${randomUUID()}?mode=memory&cache=shared`;
      this.#openMode =
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_URI;
    } else {
      this.filename = resolve(filename);
      this.#connectionFilename = this.filename;
      this.#openMode = undefined;
    }
  }

  async init(): Promise<void> {
    if (this.#closing) throw new Error("Database is closing or closed");
    if (this.#initPromise) return await this.#initPromise;
    if (this.#db && this.#transactionDb) return;
    this.#initPromise ??= (async () => {
      if (this.filename !== ":memory:") {
        const parent = dirname(this.filename);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await chmod(parent, 0o700);
      }
      const db = await open<sqlite3.Database, sqlite3.Statement>({
        filename: this.#connectionFilename,
        driver: sqlite3.Database,
        ...(this.#openMode === undefined ? {} : { mode: this.#openMode }),
      });
      this.#db = db;
      try {
        await this.#secureDatabaseFiles();
        await db.exec("PRAGMA foreign_keys = ON;");
        await db.exec("PRAGMA journal_mode = WAL;");
        await db.exec("PRAGMA busy_timeout = 5000;");
        await assertKnownSchemaVersion(db);
        await db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        requested_agent TEXT NOT NULL,
        priority TEXT NOT NULL,
        context TEXT,
        success_criteria_json TEXT NOT NULL,
        verification_command TEXT,
        handoff_required INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','needs-review','blocked','done')),
        route_mode TEXT NOT NULL,
        route_risk TEXT NOT NULL,
        route_reasons_json TEXT NOT NULL,
        latest_update TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS route_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sequence_no INTEGER NOT NULL,
        agent TEXT NOT NULL,
        role TEXT NOT NULL,
        required INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped')),
        run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        route_step_id TEXT NOT NULL REFERENCES route_steps(id) ON DELETE CASCADE,
        adapter_run_id TEXT,
        agent TEXT NOT NULL,
        role TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','starting','running','succeeded','failed','stopped','stale')),
        pid INTEGER,
        worktree_path TEXT,
        branch TEXT,
        base_commit TEXT,
        stdout_path TEXT,
        stderr_path TEXT,
        result_path TEXT,
        exit_code INTEGER,
        signal TEXT,
        summary TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(route_step_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, path)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        reviewer TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rework_requested','rejected')),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','completed')),
        response_status INTEGER,
        response_body_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (state = 'pending' AND response_status IS NULL AND response_body_json IS NULL)
          OR
          (state = 'completed' AND response_status BETWEEN 100 AND 599
            AND response_body_json IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS tasks_by_status_priority
        ON tasks(status, priority, created_at);
      CREATE INDEX IF NOT EXISTS route_steps_by_task_sequence
        ON route_steps(task_id, sequence_no);
      CREATE INDEX IF NOT EXISTS runs_by_task_created
        ON runs(task_id, created_at);
      CREATE INDEX IF NOT EXISTS events_by_task_created
        ON events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS events_by_task_id
        ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS artifacts_by_task_created
        ON artifacts(task_id, created_at);
      CREATE INDEX IF NOT EXISTS reviews_by_task_status
        ON reviews(task_id, status);
      CREATE INDEX IF NOT EXISTS idempotency_keys_by_state_updated
        ON idempotency_keys(state, updated_at);
        `);
        // Forward-only user_version migrations (F12/A12); fails closed when
        // the file was written by a newer schema. Backups are skipped for
        // brand-new databases (no databasePath for :memory:, no user rows
        // otherwise). Precedent: Android SQLiteOpenHelper/Room migrations.
        await runMigrations(db, {
          accHome: dirname(this.filename),
          migrations: CONTROL_CENTER_MIGRATIONS,
          ...(this.filename === ":memory:"
            ? {}
            : { databasePath: this.filename }),
        });
        const transactionDb = await open<sqlite3.Database, sqlite3.Statement>({
          filename: this.#connectionFilename,
          driver: sqlite3.Database,
          ...(this.#openMode === undefined ? {} : { mode: this.#openMode }),
        });
        try {
          await transactionDb.exec("PRAGMA foreign_keys = ON;");
          await transactionDb.exec("PRAGMA busy_timeout = 5000;");
          this.#transactionDb = transactionDb;
        } catch (error) {
          await transactionDb.close().catch(() => undefined);
          throw error;
        }
        await this.#secureDatabaseFiles();
      } catch (error) {
        const transactionDb = this.#transactionDb;
        this.#transactionDb = null;
        await transactionDb?.close().catch(() => undefined);
        this.#db = null;
        await db.close().catch(() => undefined);
        throw error;
      }
    })();
    try {
      await this.#initPromise;
    } catch (error) {
      this.#initPromise = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#initPromise?.catch(() => undefined);
      // Write callers append their completion gate before their first await.
      // This drains every mutation admitted before close began.
      await this.#transactionTail;
      const transactionDb = this.#transactionDb;
      this.#transactionDb = null;
      await transactionDb?.close();
      const db = this.#db;
      if (!db) return;
      await this.#secureDatabaseFiles();
      await db.close();
      if (this.#db === db) this.#db = null;
    })();
    return await this.#closePromise;
  }

  async createTask(input: TaskPayload, planInput: RoutePlan): Promise<TaskAggregate> {
    const task = TaskPayloadSchema.parse(input);
    const plan = RoutePlanSchema.parse(planInput);
    const id = task.id ?? `task_${randomUUID()}`;
    const createdAt = now();
    await this.#withImmediateTransaction(async (db) => {
      await db.run(
        `INSERT INTO tasks (
          id, goal, repo, base_ref, requested_agent, priority, context,
          success_criteria_json, verification_command, handoff_required,
          status, route_mode, route_risk, route_reasons_json, latest_update,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        id,
        task.goal,
        task.repo,
        task.baseRef,
        task.agent,
        task.priority,
        task.context ?? null,
        JSON.stringify(task.successCriteria),
        task.verificationCommand ?? null,
        task.handoffRequired ? 1 : 0,
        plan.mode,
        plan.risk,
        JSON.stringify(plan.reasons),
        `Queued with ${plan.steps.length} route step${plan.steps.length === 1 ? "" : "s"}.`,
        createdAt,
        createdAt,
      );
      for (const routeStep of plan.steps) {
        await db.run(
          `INSERT INTO route_steps (
            id, task_id, sequence_no, agent, role, required, reason, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          routeStep.id,
          id,
          routeStep.sequence,
          routeStep.agent,
          routeStep.role,
          routeStep.required ? 1 : 0,
          routeStep.reason,
          createdAt,
          createdAt,
        );
      }
      await db.run(
        `INSERT INTO events (task_id, type, level, message, data_json, created_at)
         VALUES (?, 'task.created', 'info', ?, ?, ?)`,
        id,
        `Task queued via ${task.agent}.`,
        JSON.stringify({ routeMode: plan.mode, risk: plan.risk }),
        createdAt,
      );
    });
    const aggregate = await this.getTask(id);
    if (!aggregate) throw new Error(`Task disappeared after create: ${id}`);
    return aggregate;
  }

  async getTask(id: string): Promise<TaskAggregate | null> {
    const row = await this.#connection().get<TaskRow>(
      "SELECT * FROM tasks WHERE id = ?",
      id,
    );
    if (!row) return null;
    const [routeSteps, runs, events, artifacts, messages, reviews] = await Promise.all([
      this.listRouteSteps(id),
      this.listRuns(id),
      this.listEvents(id),
      this.listArtifacts(id),
      this.listMessages(id),
      this.listReviews(id),
    ]);
    const task = taskFromRow(row);
    task.routePlan = RoutePlanSchema.parse({
      ...task.routePlan,
      steps: routeSteps.map((step) => ({
        id: step.id,
        sequence: step.sequence,
        agent: step.agent,
        role: step.role,
        required: step.required,
        reason: step.reason,
      })),
    });
    return { task, routeSteps, runs, events, artifacts, messages, reviews };
  }

  async listTasks(status?: TaskStatus): Promise<TaskRecord[]> {
    const rows = status
      ? await this.#connection().all<TaskRow[]>(
          `SELECT * FROM tasks WHERE status = ?
           ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                    created_at`,
          status,
        )
      : await this.#connection().all<TaskRow[]>(
          `SELECT * FROM tasks
           ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 WHEN 'needs-review' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END,
                    updated_at DESC`,
        );
    const tasks = await Promise.all(
      rows.map(async (row) => {
        const record = taskFromRow(row);
        const steps = await this.listRouteSteps(row.id);
        record.routePlan = RoutePlanSchema.parse({
          ...record.routePlan,
          steps: steps.map((step) => ({
            id: step.id,
            sequence: step.sequence,
            agent: step.agent,
            role: step.role,
            required: step.required,
            reason: step.reason,
          })),
        });
        return record;
      }),
    );
    return tasks;
  }

  async claimNextTask(workerId = `worker:${process.pid}`): Promise<TaskAggregate | null> {
    const id = await this.#withImmediateTransaction(async (db) => {
      const candidate = await db.get<{ id: string }>(
        `SELECT id FROM tasks WHERE status = 'queued'
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                  created_at
         LIMIT 1`,
      );
      if (!candidate) return null;
      const claimedAt = now();
      const result = await db.run(
        `UPDATE tasks
         SET status = 'running', claimed_by = ?, claimed_at = ?,
             latest_update = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        workerId,
        claimedAt,
        `Claimed by ${workerId}.`,
        claimedAt,
        candidate.id,
      );
      if (result.changes !== 1) return null;
      await db.run(
        `INSERT INTO events (task_id, type, level, message, data_json, created_at)
         VALUES (?, 'task.claimed', 'info', ?, ?, ?)`,
        candidate.id,
        `Task claimed by ${workerId}.`,
        JSON.stringify({ workerId }),
        claimedAt,
      );
      return candidate.id;
    });
    return id ? await this.getTask(id) : null;
  }

  async heartbeatTask(taskId: string, workerId: string): Promise<string> {
    const normalizedWorkerId = workerId.trim();
    if (!normalizedWorkerId) throw new Error("Worker id is required for a heartbeat");
    const heartbeatAt = now();
    const result = await this.#withWriteConnection(async (db) =>
      await db.run(
        `UPDATE tasks
         SET claimed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND claimed_by = ?`,
        heartbeatAt,
        heartbeatAt,
        taskId,
        normalizedWorkerId,
      ),
    );
    if (result.changes !== 1) {
      throw new Error(
        `Task ${taskId} is not running or is not claimed by ${normalizedWorkerId}`,
      );
    }
    return heartbeatAt;
  }

  async recoverStaleTasks(
    cutoffIso: string,
    recoveredBy = `worker:${process.pid}`,
  ): Promise<StaleRecoveryResult> {
    const cutoffMs = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoffMs)) {
      throw new Error(`Invalid stale-task cutoff: ${cutoffIso}`);
    }
    const cutoff = new Date(cutoffMs).toISOString();
    return await this.#recoverRunningTasks({
      cutoff,
      claimedBy: null,
      recoveredBy,
    });
  }

  /**
   * Recover every running task claimed by a worker whose process is known dead.
   * Unlike heartbeat recovery this is intentionally immediate: the daemon lease
   * establishes that the previous owner cannot still be coordinating the run.
   */
  async recoverTasksOwnedBy(
    claimedByInput: string,
    recoveredBy = `worker:${process.pid}`,
  ): Promise<StaleRecoveryResult> {
    const claimedBy = claimedByInput.trim();
    if (!claimedBy) throw new Error("Claimed worker id is required for owner recovery");
    return await this.#recoverRunningTasks({
      cutoff: null,
      claimedBy,
      recoveredBy,
    });
  }

  async #recoverRunningTasks(input: {
    cutoff: string | null;
    claimedBy: string | null;
    recoveredBy: string;
  }): Promise<StaleRecoveryResult> {
    const normalizedRecoveredBy = input.recoveredBy.trim();
    if (!normalizedRecoveredBy) {
      throw new Error("Worker id is required for task recovery");
    }
    const recoveryDescription = input.claimedBy
      ? `Previous worker ${input.claimedBy} is no longer alive.`
      : `Worker heartbeat expired before ${input.cutoff}.`;
    const recoveredAt = now();
    const result: StaleRecoveryResult = {
      taskIds: [],
      staleRunIds: [],
      failedRunIds: [],
      processCandidates: [],
      remoteCandidates: [],
    };
    return await this.#withImmediateTransaction(async (db) => {
      const staleTasks = await db.all<
        Array<{
          id: string;
          claimed_by: string | null;
          claimed_at: string | null;
        }>
      >(
        input.claimedBy
          ? `SELECT id, claimed_by, claimed_at
             FROM tasks
             WHERE status = 'running' AND claimed_by = ?
             ORDER BY claimed_at, id`
          : `SELECT id, claimed_by, claimed_at
             FROM tasks
             WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?
             ORDER BY claimed_at, id`,
        input.claimedBy ?? input.cutoff,
      );

      for (const task of staleTasks) {
        const activeRuns = await db.all<
          Array<{
            id: string;
            status: RunStatus;
            pid: number | null;
            agent: string;
            adapter_run_id: string | null;
          }>
        >(
          `SELECT id, status, pid, agent, adapter_run_id
           FROM runs
           WHERE task_id = ? AND status IN ('starting', 'running')
           ORDER BY created_at, id`,
          task.id,
        );

        for (const run of activeRuns) {
          const verifierEvent = await db.get<{ data_json: string | null }>(
            `SELECT started.data_json
             FROM events AS started
             WHERE started.run_id = ?
               AND started.type = 'verification.process_started'
               AND NOT EXISTS (
                 SELECT 1 FROM events AS terminal
                 WHERE terminal.run_id = started.run_id
                   AND terminal.id > started.id
                   AND terminal.type IN ('verification.succeeded', 'verification.failed')
               )
             ORDER BY started.id DESC
             LIMIT 1`,
            run.id,
          );
          const verifierPid = verifierEvent?.data_json
            ? parseJson<{ pid?: unknown }>(verifierEvent.data_json, {}).pid
            : undefined;
          if (
            typeof verifierPid === "number" &&
            Number.isSafeInteger(verifierPid) &&
            verifierPid > 1
          ) {
            result.processCandidates.push({
              taskId: task.id,
              runId: run.id,
              pid: verifierPid,
              agent: "verifier",
            });
          } else if (
            run.pid !== null &&
            (run.agent === "codex" || run.agent === "claude")
          ) {
            result.processCandidates.push({
              taskId: task.id,
              runId: run.id,
              pid: run.pid,
              agent: run.agent,
            });
          }
          if (run.agent === "openclaw") {
            result.remoteCandidates.push({
              taskId: task.id,
              runId: run.id,
              remoteId: run.adapter_run_id ?? run.id,
              agent: "openclaw",
            });
          }
          const nextStatus: RunStatus = run.status === "running" ? "stale" : "failed";
          const error =
            run.status === "running"
              ? `${recoveryDescription} The run was active.`
              : `${recoveryDescription} The run had not become active.`;
          const updated = await db.run(
            `UPDATE runs
             SET status = ?,
                 error = CASE
                   WHEN error IS NULL OR error = '' THEN ?
                   ELSE error || char(10) || ?
                 END,
                 finished_at = COALESCE(finished_at, ?), updated_at = ?
             WHERE id = ? AND task_id = ? AND status = ?`,
            nextStatus,
            error,
            error,
            recoveredAt,
            recoveredAt,
            run.id,
            task.id,
            run.status,
          );
          if (updated.changes !== 1) {
            throw new Error(`Run status changed during stale recovery: ${run.id}`);
          }
          if (nextStatus === "stale") result.staleRunIds.push(run.id);
          else result.failedRunIds.push(run.id);
          await db.run(
            `INSERT INTO events (
               task_id, run_id, type, level, message, data_json, created_at
             ) VALUES (?, ?, ?, 'warn', ?, ?, ?)`,
            task.id,
            run.id,
            nextStatus === "stale" ? "run.stale" : "run.failed",
            error,
            JSON.stringify({
              previousStatus: run.status,
              recoveredBy: normalizedRecoveredBy,
              ...(input.cutoff ? { cutoff: input.cutoff } : {}),
              ...(input.claimedBy ? { deadOwner: input.claimedBy } : {}),
            }),
            recoveredAt,
          );
        }

        await db.run(
          `UPDATE route_steps
           SET status = 'failed', updated_at = ?
           WHERE task_id = ? AND status = 'running'`,
          recoveredAt,
          task.id,
        );
        const taskUpdate = await db.run(
          `UPDATE tasks
           SET status = 'blocked', claimed_by = NULL, claimed_at = NULL,
               latest_update = ?, updated_at = ?
           WHERE id = ? AND status = 'running'
             AND claimed_at IS ? AND claimed_by IS ?`,
          `${recoveryDescription} Task requires recovery.`,
          recoveredAt,
          task.id,
          task.claimed_at,
          task.claimed_by,
        );
        if (taskUpdate.changes !== 1) {
          throw new Error(`Task status changed during stale recovery: ${task.id}`);
        }
        result.taskIds.push(task.id);
        await db.run(
          `INSERT INTO events (
             task_id, type, level, message, data_json, created_at
           ) VALUES (?, ?, 'warn', ?, ?, ?)`,
          task.id,
          input.claimedBy ? "task.dead_owner_recovered" : "task.stale_recovered",
          input.claimedBy
            ? "Task owned by a dead daemon was blocked and its active execution state was closed."
            : "Stale task was blocked and its active execution state was closed.",
          JSON.stringify({
            claimedAt: task.claimed_at,
            claimedBy: task.claimed_by,
            recoveredBy: normalizedRecoveredBy,
            ...(input.cutoff ? { cutoff: input.cutoff } : {}),
            ...(input.claimedBy ? { deadOwner: input.claimedBy } : {}),
          }),
          recoveredAt,
        );
      }

      return result;
    });
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    latestUpdate: string,
  ): Promise<void> {
    await this.#withWriteConnection(async (db) => {
      const row = await db.get<{ status: string }>(
        "SELECT status FROM tasks WHERE id = ?",
        taskId,
      );
      if (!row) throw new Error(`Task not found: ${taskId}`);
      const current = TaskStatusSchema.parse(row.status);
      assertTaskTransition(current, status);
      const updatedAt = now();
      const result = await db.run(
        `UPDATE tasks
         SET status = ?, latest_update = ?,
             claimed_by = CASE WHEN ? = 'running' THEN claimed_by ELSE NULL END,
             claimed_at = CASE WHEN ? = 'running' THEN claimed_at ELSE NULL END,
             updated_at = ?
         WHERE id = ? AND status = ?`,
        status,
        latestUpdate,
        status,
        status,
        updatedAt,
        taskId,
        current,
      );
      if (result.changes !== 1) {
        throw new Error(`Task status changed concurrently: ${taskId}`);
      }
    });
  }

  async listRouteSteps(taskId: string): Promise<RouteStepRecord[]> {
    const rows = await this.#connection().all<RouteStepRow[]>(
      `SELECT * FROM route_steps WHERE task_id = ? ORDER BY sequence_no, created_at`,
      taskId,
    );
    return rows.map(routeStepFromRow);
  }

  async updateRouteStep(
    stepId: string,
    patch: { status?: RouteStepStatus; runId?: string | null },
  ): Promise<void> {
    await this.#withWriteConnection(async (db) => {
      const row = await db.get<RouteStepRow>(
        "SELECT * FROM route_steps WHERE id = ?",
        stepId,
      );
      if (!row) throw new Error(`Route step not found: ${stepId}`);
      const result = await db.run(
        `UPDATE route_steps
         SET status = ?, run_id = ?, updated_at = ?
         WHERE id = ? AND status = ? AND run_id IS ?`,
        patch.status ?? row.status,
        patch.runId === undefined ? row.run_id : patch.runId,
        now(),
        stepId,
        row.status,
        row.run_id,
      );
      if (result.changes !== 1) {
        throw new Error(`Route step changed concurrently: ${stepId}`);
      }
    });
  }

  async resetRouteSteps(taskId: string): Promise<void> {
    await this.#withWriteConnection(async (db) =>
      await db.run(
        `UPDATE route_steps
         SET status = 'pending', run_id = NULL, updated_at = ?
         WHERE task_id = ?`,
        now(),
        taskId,
      ),
    );
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const agent = AgentKindSchema.parse(input.agent);
    const role = RouteRoleSchema.parse(input.role);
    const id = `run_${randomUUID()}`;
    const createdAt = now();
    return await this.#withWriteConnection(async (db) => {
      const attemptRow = await db.get<{ next_attempt: number }>(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt FROM runs WHERE route_step_id = ?`,
        input.routeStepId,
      );
      await db.run(
        `INSERT INTO runs (
          id, task_id, route_step_id, agent, role, attempt, status,
          worktree_path, branch, base_commit, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        id,
        input.taskId,
        input.routeStepId,
        agent,
        role,
        attemptRow?.next_attempt ?? 1,
        input.worktreePath ?? null,
        input.branch ?? null,
        input.baseCommit ?? null,
        createdAt,
        createdAt,
      );
      const row = await db.get<RunRow>("SELECT * FROM runs WHERE id = ?", id);
      if (!row) throw new Error(`Run disappeared after create: ${id}`);
      return runFromRow(row);
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = await this.#connection().get<RunRow>(
      "SELECT * FROM runs WHERE id = ?",
      runId,
    );
    return row ? runFromRow(row) : null;
  }

  async listRuns(
    taskId?: string,
    filter: RunListFilter = {},
  ): Promise<RunRecord[]> {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (taskId) {
      clauses.push("task_id = ?");
      parameters.push(taskId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      parameters.push(RunStatusSchema.parse(filter.status));
    }
    if (filter.agent) {
      clauses.push("agent = ?");
      parameters.push(AgentKindSchema.parse(filter.agent));
    }
    const limit = filter.limit === undefined ? null : assertLimit(filter.limit);
    const sql = [
      "SELECT * FROM runs",
      clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      taskId ? "ORDER BY created_at, id" : "ORDER BY created_at DESC, id DESC",
      limit === null ? "" : "LIMIT ?",
    ]
      .filter(Boolean)
      .join(" ");
    if (limit !== null) parameters.push(limit);
    const rows = await this.#connection().all<RunRow[]>(sql, ...parameters);
    return rows.map(runFromRow);
  }

  async updateRun(runId: string, patch: UpdateRunPatch): Promise<RunRecord> {
    return await this.#withWriteConnection(async (db) => {
      const currentRow = await db.get<RunRow>(
        "SELECT * FROM runs WHERE id = ?",
        runId,
      );
      if (!currentRow) throw new Error(`Run not found: ${runId}`);
      const current = runFromRow(currentRow);
      if (patch.status) assertRunTransition(current.status, patch.status);
      const next = { ...current, ...patch, updatedAt: now() };
      const result = await db.run(
        `UPDATE runs SET
          adapter_run_id = ?, status = ?, pid = ?, worktree_path = ?, branch = ?,
          base_commit = ?, stdout_path = ?, stderr_path = ?, result_path = ?,
          exit_code = ?, signal = ?, summary = ?, error = ?, usage_json = ?,
          started_at = ?, finished_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
        next.adapterRunId,
        next.status,
        next.pid,
        next.worktreePath,
        next.branch,
        next.baseCommit,
        next.stdoutPath,
        next.stderrPath,
        next.resultPath,
        next.exitCode,
        next.signal,
        next.summary,
        next.error,
        next.usageJson,
        next.startedAt,
        next.finishedAt,
        next.updatedAt,
        runId,
        current.status,
      );
      if (result.changes !== 1) {
        throw new Error(`Run status changed concurrently: ${runId}`);
      }
      const updatedRow = await db.get<RunRow>(
        "SELECT * FROM runs WHERE id = ?",
        runId,
      );
      if (!updatedRow) throw new Error(`Run disappeared after update: ${runId}`);
      return runFromRow(updatedRow);
    });
  }

  async appendEvent(input: {
    taskId: string;
    runId?: string;
    type: string;
    level?: EventLevel;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<EventRecord> {
    const createdAt = now();
    return await this.#withWriteConnection(async (db) => {
      const result = await db.run(
        `INSERT INTO events (task_id, run_id, type, level, message, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.taskId,
        input.runId ?? null,
        input.type,
        input.level ?? "info",
        input.message,
        input.data ? JSON.stringify(input.data) : null,
        createdAt,
      );
      const row = await db.get<EventRow>(
        "SELECT * FROM events WHERE id = ?",
        result.lastID,
      );
      if (!row) throw new Error("Event disappeared after insert");
      return eventFromRow(row);
    });
  }

  async listEvents(taskId: string): Promise<EventRecord[]> {
    const rows = await this.#connection().all<EventRow[]>(
      "SELECT * FROM events WHERE task_id = ? ORDER BY id",
      taskId,
    );
    return rows.map(eventFromRow);
  }

  /**
   * Read the durable event log strictly after a global cursor. Event IDs are
   * monotonically increasing across tasks, so clients can persist one cursor
   * and optionally narrow replay to a single task without changing its meaning.
   */
  async listEventsAfter(
    afterId: number,
    taskId?: string,
    limit = 200,
  ): Promise<EventRecord[]> {
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new Error("Event cursor must be a non-negative safe integer");
    }
    const boundedLimit = assertLimit(limit);
    const rows = taskId
      ? await this.#connection().all<EventRow[]>(
          `SELECT * FROM events
           WHERE task_id = ? AND id > ?
           ORDER BY id
           LIMIT ?`,
          taskId,
          afterId,
          boundedLimit,
        )
      : await this.#connection().all<EventRow[]>(
          `SELECT * FROM events
           WHERE id > ?
           ORDER BY id
           LIMIT ?`,
          afterId,
          boundedLimit,
        );
    return rows.map(eventFromRow);
  }

  async addArtifact(
    input: ArtifactMetadata & { metadata?: Record<string, unknown> },
  ): Promise<ArtifactRecord> {
    const kind = ArtifactKindSchema.parse(input.kind);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new Error("Artifact sha256 must be a lowercase SHA-256 digest");
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error("Artifact size must be a non-negative safe integer");
    }
    let metadataJson: string | null = null;
    if (input.metadata !== undefined) {
      const serialized = JSON.stringify(input.metadata);
      if (serialized === undefined) {
        throw new Error("Artifact metadata must be JSON-serializable");
      }
      metadataJson = serialized;
    }
    // Compare the same JSON value that SQLite persists. This intentionally
    // removes non-JSON details such as undefined properties before the first
    // insert is checked against the row it just created.
    const metadataValue: unknown = metadataJson === null
      ? null
      : JSON.parse(metadataJson) as unknown;
    if (
      metadataValue !== null &&
      (typeof metadataValue !== "object" || Array.isArray(metadataValue))
    ) {
      throw new Error("Artifact metadata must be a JSON object");
    }
    const metadata = metadataValue as Record<string, unknown> | null;
    const id = `artifact_${randomUUID()}`;
    return await this.#withWriteConnection(async (db) => {
      await db.run(
        `INSERT INTO artifacts (
          id, task_id, run_id, kind, path, relative_path, sha256, size_bytes,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, path) DO NOTHING`,
        id,
        input.taskId,
        input.runId,
        kind,
        input.path,
        input.relativePath,
        input.sha256,
        input.sizeBytes,
        metadataJson,
        input.createdAt,
      );
      const row = await db.get<ArtifactRow>(
        "SELECT * FROM artifacts WHERE run_id = ? AND path = ?",
        input.runId,
        input.path,
      );
      if (!row) throw new Error("Artifact disappeared after insert");
      const persisted = this.#artifactFromRow(row);
      if (
        persisted.taskId !== input.taskId ||
        persisted.runId !== input.runId ||
        persisted.kind !== kind ||
        persisted.path !== input.path ||
        persisted.relativePath !== input.relativePath ||
        persisted.sha256 !== input.sha256 ||
        persisted.sizeBytes !== input.sizeBytes ||
        !isDeepStrictEqual(persisted.metadata, metadata)
      ) {
        throw new ArtifactConflictError(
          input.path,
          `Artifact database evidence must be identical for immutable path: ${input.path}`,
        );
      }
      return persisted;
    });
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const row = await this.#connection().get<ArtifactRow>(
      "SELECT * FROM artifacts WHERE id = ?",
      artifactId,
    );
    return row ? this.#artifactFromRow(row) : null;
  }

  async listArtifacts(taskId: string): Promise<ArtifactRecord[]> {
    const rows = await this.#connection().all<ArtifactRow[]>(
      "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at",
      taskId,
    );
    return rows.map((row) => this.#artifactFromRow(row));
  }

  async addMessage(input: {
    taskId: string;
    runId?: string;
    direction: MessageRecord["direction"];
    role: string;
    body: string;
    deliveryStatus?: MessageRecord["deliveryStatus"];
  }): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: `message_${randomUUID()}`,
      taskId: input.taskId,
      runId: input.runId ?? null,
      direction: input.direction,
      role: input.role,
      body: input.body,
      deliveryStatus: input.deliveryStatus ?? "queued",
      createdAt: now(),
    };
    await this.#withWriteConnection(async (db) =>
      await db.run(
        `INSERT INTO messages (
          id, task_id, run_id, direction, role, body, delivery_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.id,
        record.taskId,
        record.runId,
        record.direction,
        record.role,
        record.body,
        record.deliveryStatus,
        record.createdAt,
      ),
    );
    return record;
  }

  async listMessages(taskId: string): Promise<MessageRecord[]> {
    const rows = await this.#connection().all<
      Array<{
        id: string;
        task_id: string;
        run_id: string | null;
        direction: MessageRecord["direction"];
        role: string;
        body: string;
        delivery_status: MessageRecord["deliveryStatus"];
        created_at: string;
      }>
    >("SELECT * FROM messages WHERE task_id = ? ORDER BY created_at", taskId);
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      direction: row.direction,
      role: row.role,
      body: row.body,
      deliveryStatus: row.delivery_status,
      createdAt: row.created_at,
    }));
  }

  async updateMessageDelivery(
    messageId: string,
    deliveryStatus: MessageRecord["deliveryStatus"],
  ): Promise<void> {
    const result = await this.#withWriteConnection(async (db) =>
      await db.run(
        "UPDATE messages SET delivery_status = ? WHERE id = ?",
        deliveryStatus,
        messageId,
      ),
    );
    if (result.changes !== 1) throw new Error(`Message not found: ${messageId}`);
  }

  async createReview(input: {
    taskId: string;
    runId?: string;
    reviewer?: string;
  }): Promise<ReviewRecord> {
    const createdAt = now();
    const record: ReviewRecord = {
      id: `review_${randomUUID()}`,
      taskId: input.taskId,
      runId: input.runId ?? null,
      reviewer: input.reviewer ?? null,
      status: "pending",
      note: null,
      createdAt,
      updatedAt: createdAt,
    };
    await this.#withWriteConnection(async (db) =>
      await db.run(
        `INSERT INTO reviews (
          id, task_id, run_id, reviewer, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        record.id,
        record.taskId,
        record.runId,
        record.reviewer,
        record.createdAt,
        record.updatedAt,
      ),
    );
    return record;
  }

  async decideReview(
    reviewId: string,
    status: Exclude<ReviewStatus, "pending">,
    note?: string,
  ): Promise<ReviewRecord> {
    const updatedAt = now();
    return await this.#withWriteConnection(async (db) => {
      const result = await db.run(
        `UPDATE reviews SET status = ?, note = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        status,
        note?.trim() || null,
        updatedAt,
        reviewId,
      );
      if (result.changes !== 1) {
        throw new Error(`Review not found or already decided: ${reviewId}`);
      }
      const row = await db.get<ReviewRow>(
        "SELECT * FROM reviews WHERE id = ?",
        reviewId,
      );
      if (!row) throw new Error(`Review disappeared after decision: ${reviewId}`);
      return this.#reviewFromRow(row);
    });
  }

  async finalizeTaskExecution(input: {
    taskId: string;
    status: "done" | "needs-review";
    latestUpdate: string;
    runId?: string;
  }): Promise<ReviewRecord | null> {
    return await this.#withImmediateTransaction(async (db) => {
      const task = await db.get<{ status: string }>(
        "SELECT status FROM tasks WHERE id = ?",
        input.taskId,
      );
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      if (task.status !== "running") {
        throw new Error(
          `Task ${input.taskId} cannot finalize from ${task.status}`,
        );
      }
      const updatedAt = now();
      let review: ReviewRecord | null = null;
      if (input.status === "needs-review") {
        review = {
          id: `review_${randomUUID()}`,
          taskId: input.taskId,
          runId: input.runId ?? null,
          reviewer: null,
          status: "pending",
          note: null,
          createdAt: updatedAt,
          updatedAt,
        };
        await db.run(
          `INSERT INTO reviews (
             id, task_id, run_id, reviewer, status, note, created_at, updated_at
           ) VALUES (?, ?, ?, NULL, 'pending', NULL, ?, ?)`,
          review.id,
          review.taskId,
          review.runId,
          review.createdAt,
          review.updatedAt,
        );
      }
      const update = await db.run(
        `UPDATE tasks
         SET status = ?, latest_update = ?, claimed_by = NULL, claimed_at = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'running'`,
        input.status,
        input.latestUpdate,
        updatedAt,
        input.taskId,
      );
      if (update.changes !== 1) {
        throw new Error(`Task status changed concurrently: ${input.taskId}`);
      }
      return review;
    });
  }

  async approveTaskReview(
    taskId: string,
    note?: string,
    expected?: { reviewId: string; updatedAt: string },
  ): Promise<ReviewRecord> {
    return await this.#withImmediateTransaction(async (db) => {
      const task = await db.get<{ status: string }>(
        "SELECT status FROM tasks WHERE id = ?",
        taskId,
      );
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== "needs-review") {
        throw new Error(`Task ${taskId} is not waiting for review`);
      }
      const review = expected
        ? await db.get<ReviewRow>(
            `SELECT * FROM reviews WHERE id = ? AND task_id = ?`,
            expected.reviewId,
            taskId,
          )
        : await db.get<ReviewRow>(
            `SELECT * FROM reviews
             WHERE task_id = ? AND status = 'pending'
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`,
            taskId,
          );
      if (!review) throw new Error(`Task ${taskId} has no pending review`);
      if (
        review.status !== "pending" ||
        (expected && review.updated_at !== expected.updatedAt)
      ) {
        throw new Error(`Review changed concurrently: ${review.id}`);
      }

      const cleanNote = note?.trim() || null;
      const updatedAt = now();
      const reviewUpdate = await db.run(
        `UPDATE reviews
         SET status = 'approved', note = ?, updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'pending'
           ${expected ? "AND updated_at = ?" : ""}`,
        cleanNote,
        updatedAt,
        review.id,
        taskId,
        ...(expected ? [expected.updatedAt] : []),
      );
      if (reviewUpdate.changes !== 1) {
        throw new Error(`Review changed concurrently: ${review.id}`);
      }
      const taskUpdate = await db.run(
        `UPDATE tasks
         SET status = 'done', latest_update = ?, claimed_by = NULL,
             claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'needs-review'`,
        cleanNote ?? "Approved by human reviewer.",
        updatedAt,
        taskId,
      );
      if (taskUpdate.changes !== 1) {
        throw new Error(`Task status changed concurrently: ${taskId}`);
      }
      const decided = await db.get<ReviewRow>(
        "SELECT * FROM reviews WHERE id = ?",
        review.id,
      );
      if (!decided) {
        throw new Error(`Review disappeared after decision: ${review.id}`);
      }
      return this.#reviewFromRow(decided);
    });
  }

  async requestTaskRework(
    taskId: string,
    note: string,
    expected?: { reviewId: string; updatedAt: string },
  ): Promise<{ review: ReviewRecord; message: MessageRecord }> {
    const cleanNote = note.trim();
    if (!cleanNote) throw new Error("Rework note is required");
    return await this.#withImmediateTransaction(async (db) => {
      const task = await db.get<{ status: string }>(
        "SELECT status FROM tasks WHERE id = ?",
        taskId,
      );
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== "needs-review") {
        throw new Error(`Task ${taskId} is not waiting for review`);
      }
      const review = expected
        ? await db.get<ReviewRow>(
            `SELECT * FROM reviews WHERE id = ? AND task_id = ?`,
            expected.reviewId,
            taskId,
          )
        : await db.get<ReviewRow>(
            `SELECT * FROM reviews
             WHERE task_id = ? AND status = 'pending'
             ORDER BY created_at DESC, rowid DESC
             LIMIT 1`,
            taskId,
          );
      if (!review) throw new Error(`Task ${taskId} has no pending review`);
      if (
        review.status !== "pending" ||
        (expected && review.updated_at !== expected.updatedAt)
      ) {
        throw new Error(`Review changed concurrently: ${review.id}`);
      }

      const updatedAt = now();
      const reviewUpdate = await db.run(
        `UPDATE reviews
         SET status = 'rework_requested', note = ?, updated_at = ?
         WHERE id = ? AND task_id = ? AND status = 'pending'
           ${expected ? "AND updated_at = ?" : ""}`,
        cleanNote,
        updatedAt,
        review.id,
        taskId,
        ...(expected ? [expected.updatedAt] : []),
      );
      if (reviewUpdate.changes !== 1) {
        throw new Error(`Review changed concurrently: ${review.id}`);
      }
      const message: MessageRecord = {
        id: `message_${randomUUID()}`,
        taskId,
        runId: review.run_id,
        direction: "system",
        role: "reviewer",
        body: cleanNote,
        deliveryStatus: "queued",
        createdAt: updatedAt,
      };
      await db.run(
        `INSERT INTO messages (
           id, task_id, run_id, direction, role, body, delivery_status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.taskId,
        message.runId,
        message.direction,
        message.role,
        message.body,
        message.deliveryStatus,
        message.createdAt,
      );
      await db.run(
        `UPDATE route_steps
         SET status = 'pending', run_id = NULL, updated_at = ?
         WHERE task_id = ?`,
        updatedAt,
        taskId,
      );
      const taskUpdate = await db.run(
        `UPDATE tasks
         SET status = 'queued', latest_update = ?, claimed_by = NULL,
             claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'needs-review'`,
        cleanNote,
        updatedAt,
        taskId,
      );
      if (taskUpdate.changes !== 1) {
        throw new Error(`Task status changed concurrently: ${taskId}`);
      }
      const decided = await db.get<ReviewRow>(
        "SELECT * FROM reviews WHERE id = ?",
        review.id,
      );
      if (!decided) {
        throw new Error(`Review disappeared after decision: ${review.id}`);
      }
      return { review: this.#reviewFromRow(decided), message };
    });
  }

  async retryBlockedTask(
    taskId: string,
    note?: string,
    allowUnconfirmedRemote = false,
  ): Promise<MessageRecord> {
    const body = note?.trim() || "Operator requested another execution attempt.";
    return await this.#withImmediateTransaction(async (db) => {
      const task = await db.get<{ status: string }>(
        "SELECT status FROM tasks WHERE id = ?",
        taskId,
      );
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== "blocked") {
        throw new Error(`Task ${taskId} is not blocked`);
      }
      if (!allowUnconfirmedRemote) {
        const unresolvedRemote = await db.get<{ id: string }>(
          `SELECT runs.id
           FROM runs
           WHERE runs.task_id = ? AND runs.agent = 'openclaw'
             AND (
               runs.status = 'stale'
               OR runs.error LIKE '%Worker heartbeat expired%'
             )
             AND NOT EXISTS (
               SELECT 1 FROM events
               WHERE events.run_id = runs.id
                 AND events.type = 'run.remote_cancellation_confirmed'
             )
           LIMIT 1`,
          taskId,
        );
        if (unresolvedRemote) {
          throw new Error(
            `Task ${taskId} has unconfirmed remote OpenClaw work (${unresolvedRemote.id}); ` +
              "confirm cancellation or use the explicit allow-unconfirmed-remote override",
          );
        }
      }
      const updatedAt = now();
      const message: MessageRecord = {
        id: `message_${randomUUID()}`,
        taskId,
        runId: null,
        direction: "system",
        role: "operator",
        body,
        deliveryStatus: "queued",
        createdAt: updatedAt,
      };
      await db.run(
        `INSERT INTO messages (
           id, task_id, run_id, direction, role, body, delivery_status, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        message.id,
        message.taskId,
        message.direction,
        message.role,
        message.body,
        message.deliveryStatus,
        message.createdAt,
      );
      await db.run(
        `UPDATE route_steps
         SET status = 'pending', run_id = NULL, updated_at = ?
         WHERE task_id = ? AND status = 'failed'`,
        updatedAt,
        taskId,
      );
      const taskUpdate = await db.run(
        `UPDATE tasks
         SET status = 'queued', latest_update = ?, claimed_by = NULL,
             claimed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'blocked'`,
        body,
        updatedAt,
        taskId,
      );
      if (taskUpdate.changes !== 1) {
        throw new Error(`Task status changed concurrently: ${taskId}`);
      }
      return message;
    });
  }

  async claimIdempotencyKey(
    keyInput: string,
    requestHashInput: string,
  ): Promise<IdempotencyClaim> {
    const key = normalizeIdempotencyValue(keyInput, "Idempotency key");
    const requestHash = normalizeIdempotencyValue(requestHashInput, "Request hash");
    return await this.#withWriteConnection(async (db) => {
      // Each INSERT remains its own SQLite autocommit transaction. The write
      // lane prevents it from contending with this instance's explicit
      // transactions; the primary key still elects one owner across processes.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const createdAt = now();
        const inserted = await db.run(
          `INSERT INTO idempotency_keys (
             key, request_hash, state, response_status, response_body_json,
             created_at, updated_at
           ) VALUES (?, ?, 'pending', NULL, NULL, ?, ?)
           ON CONFLICT(key) DO NOTHING`,
          key,
          requestHash,
          createdAt,
          createdAt,
        );
        if (inserted.changes === 1) {
          return { kind: "new", createdAt };
        }

        const row = await db.get<IdempotencyRow>(
          "SELECT * FROM idempotency_keys WHERE key = ?",
          key,
        );
        // A known-safe release may race this duplicate claim. Retry once so the
        // duplicate can become the new owner after that release commits.
        if (!row) continue;

        if (row.request_hash !== requestHash) {
          return { kind: "conflict" };
        }
        if (row.state === "pending") {
          return {
            kind: "pending",
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }
        if (row.response_status === null || row.response_body_json === null) {
          throw new Error(`Completed idempotency key has no replay response: ${key}`);
        }
        return {
          kind: "replay",
          responseStatus: row.response_status,
          responseBody: parseJson<unknown>(row.response_body_json, null),
          completedAt: row.updated_at,
        };
      }
      throw new Error(`Idempotency key disappeared during claim: ${key}`);
    });
  }

  async completeIdempotencyKey(
    keyInput: string,
    requestHashInput: string,
    response: { statusCode: number; body: unknown },
  ): Promise<IdempotencyRecord> {
    const key = normalizeIdempotencyValue(keyInput, "Idempotency key");
    const requestHash = normalizeIdempotencyValue(requestHashInput, "Request hash");
    if (
      !Number.isSafeInteger(response.statusCode) ||
      response.statusCode < 100 ||
      response.statusCode > 599
    ) {
      throw new Error("Idempotent response status must be an integer from 100 to 599");
    }
    let responseJson: string;
    try {
      responseJson = JSON.stringify(response.body) ?? "null";
    } catch (error) {
      throw new Error(
        `Idempotent response body is not JSON-serializable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const updatedAt = now();
    return await this.#withWriteConnection(async (db) => {
      const updated = await db.run(
        `UPDATE idempotency_keys
         SET state = 'completed', response_status = ?, response_body_json = ?,
             updated_at = ?
         WHERE key = ? AND request_hash = ? AND state = 'pending'`,
        response.statusCode,
        responseJson,
        updatedAt,
        key,
        requestHash,
      );
      const current = await db.get<IdempotencyRow>(
        "SELECT * FROM idempotency_keys WHERE key = ?",
        key,
      );
      if (!current) throw new Error(`Idempotency key is not claimed: ${key}`);
      if (current.request_hash !== requestHash) {
        throw new Error(`Idempotency key request hash conflict: ${key}`);
      }
      if (
        current.state !== "completed" ||
        current.response_status !== response.statusCode ||
        current.response_body_json !== responseJson
      ) {
        throw new Error(
          updated.changes === 1
            ? `Idempotency key completion could not be verified: ${key}`
            : `Idempotency key already has a different response: ${key}`,
        );
      }
      return idempotencyFromRow(current);
    });
  }

  /**
   * Release only a matching pending claim. Callers must use this solely when
   * they know the protected operation did not begin or all effects rolled back.
   * Ambiguous failures intentionally leave the row pending to prevent replaying
   * a potentially duplicated external side effect.
   */
  async releaseIdempotencyKey(
    keyInput: string,
    requestHashInput: string,
  ): Promise<boolean> {
    const key = normalizeIdempotencyValue(keyInput, "Idempotency key");
    const requestHash = normalizeIdempotencyValue(requestHashInput, "Request hash");
    const result = await this.#withWriteConnection(async (db) =>
      await db.run(
        `DELETE FROM idempotency_keys
         WHERE key = ? AND request_hash = ? AND state = 'pending'`,
        key,
        requestHash,
      ),
    );
    return result.changes === 1;
  }

  async listReviews(
    taskId?: string,
    filter: ReviewListFilter = {},
  ): Promise<ReviewRecord[]> {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (taskId) {
      clauses.push("task_id = ?");
      parameters.push(taskId);
    }
    if (filter.status) {
      if (
        filter.status !== "pending" &&
        filter.status !== "approved" &&
        filter.status !== "rework_requested" &&
        filter.status !== "rejected"
      ) {
        throw new Error(`Invalid review status: ${String(filter.status)}`);
      }
      clauses.push("status = ?");
      parameters.push(filter.status);
    }
    const limit = filter.limit === undefined ? null : assertLimit(filter.limit);
    const sql = [
      "SELECT * FROM reviews",
      clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      taskId ? "ORDER BY created_at, id" : "ORDER BY created_at DESC, id DESC",
      limit === null ? "" : "LIMIT ?",
    ]
      .filter(Boolean)
      .join(" ");
    if (limit !== null) parameters.push(limit);
    const rows = await this.#connection().all<ReviewRow[]>(sql, ...parameters);
    return rows.map((row) => this.#reviewFromRow(row));
  }

  async getReview(reviewId: string): Promise<ReviewRecord | null> {
    const row = await this.#connection().get<ReviewRow>(
      "SELECT * FROM reviews WHERE id = ?",
      reviewId,
    );
    return row ? this.#reviewFromRow(row) : null;
  }

  /**
   * Serialize every mutation through the dedicated write connection. Keeping
   * the primary connection read-only after initialization prevents autocommit
   * writes from starving (or being starved by) a transaction on another
   * connection owned by this same daemon.
   */
  async #withWriteConnection<T>(
    operation: (db: SqliteDb) => Promise<T>,
  ): Promise<T> {
    if (this.#closing) throw new Error("Database is closing or closed");
    let release!: () => void;
    const turn = new Promise<void>((resolveTurn) => {
      release = resolveTurn;
    });
    const previous = this.#transactionTail;
    this.#transactionTail = previous.then(
      () => turn,
      () => turn,
    );
    await previous;

    const db = this.#transactionConnection();
    try {
      return await operation(db);
    } finally {
      release();
    }
  }

  /** Run one atomic state transition inside the shared serialized write lane. */
  async #withImmediateTransaction<T>(
    operation: (db: SqliteDb) => Promise<T>,
  ): Promise<T> {
    return await this.#withWriteConnection(async (db) => {
      let began = false;
      try {
        await db.exec("BEGIN IMMEDIATE");
        began = true;
        const result = await operation(db);
        await db.exec("COMMIT");
        began = false;
        return result;
      } catch (error) {
        if (began) await db.exec("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async #secureDatabaseFiles(): Promise<void> {
    if (this.filename === ":memory:") return;
    await Promise.all(
      [this.filename, `${this.filename}-wal`, `${this.filename}-shm`].map(
        async (path) => await chmod(path, 0o600).catch(() => undefined),
      ),
    );
  }

  #connection(): SqliteDb {
    if (!this.#db) throw new Error("Database is not initialized; call init() first");
    return this.#db;
  }

  #transactionConnection(): SqliteDb {
    if (!this.#transactionDb) {
      throw new Error("Database is not initialized; call init() first");
    }
    return this.#transactionDb;
  }

  #artifactFromRow(row: ArtifactRow): ArtifactRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      kind: ArtifactKindSchema.parse(row.kind),
      path: row.path,
      relativePath: row.relative_path,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      metadata: row.metadata_json
        ? parseJson<Record<string, unknown>>(row.metadata_json, {})
        : null,
      createdAt: row.created_at,
    };
  }

  #reviewFromRow(row: ReviewRow): ReviewRecord {
    return {
      id: row.id,
      taskId: row.task_id,
      runId: row.run_id,
      reviewer: row.reviewer,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
