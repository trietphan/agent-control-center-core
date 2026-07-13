import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { z, ZodError } from "zod";
import {
  projectTaskBoardRow,
  projectTaskDetail,
  type TaskBoardRowDto,
} from "./api-projections.js";
import {
  acquireDaemonLease,
  bearerTokenMatches,
  loadOrCreateBearerToken,
  type DaemonLease,
} from "./daemon-lease.js";
import { RunControlError } from "./coordinator.js";
import type { EventRecord, TaskAggregate } from "./db.js";
import {
  AgentKindSchema,
  TaskIdSchema,
  TaskPayloadSchema,
  TaskStatusSchema,
} from "./protocol.js";
import type { ControlCenterRuntime } from "./runtime.js";

const API_VERSION = "v1";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const SCREENSHOT_MAX_JSON_BYTES = 24 * 1024 * 1024;
const SSE_MAX_BUFFER_BYTES = 1024 * 1024;

const EntityIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const MessageBodySchema = z.object({ body: z.string().trim().min(1).max(100_000) }).strict();
const RetryBodySchema = z
  .object({
    note: z.string().trim().min(1).max(20_000).optional(),
    allowUnconfirmedRemote: z.boolean().default(false),
  })
  .strict();
const ReviewDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rework_requested"]),
    note: z.string().trim().max(20_000).optional(),
    expectedUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "rework_requested" && !value.note) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "A rework decision requires an actionable note",
      });
    }
  });
const ScreenshotSchema = z
  .object({
    name: z.string().min(1).max(160),
    contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    dataBase64: z.string().min(1).max(22 * 1024 * 1024),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ApiErrorCode =
  | "validation_failed"
  | "not_found"
  | "state_conflict"
  | "adapter_unavailable"
  | "capability_unsupported"
  | "idempotency_required"
  | "idempotency_conflict"
  | "idempotency_pending"
  | "unauthorized"
  | "forbidden"
  | "payload_too_large"
  | "internal_error";

interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

interface StoredApiBody {
  data?: unknown;
  error?: ApiErrorBody;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface DaemonLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface StartDaemonOptions {
  runtime: ControlCenterRuntime;
  host?: string;
  port?: number;
  token?: string;
  allowedOrigins?: readonly string[];
  enableWorker?: boolean;
  pollMs?: number;
  acquireLease?: boolean;
  closeRuntimeOnStop?: boolean;
  maxJsonBytes?: number;
  logger?: DaemonLogger;
}

export interface DaemonHandle {
  readonly instanceId: string;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly tokenPath: string | null;
  readonly startedAt: string;
  stop(): Promise<void>;
}

interface DaemonState {
  worker: "disabled" | "idle" | "running" | "stopping";
  stopping: boolean;
  lastWorkerError: string | null;
}

interface RequestContext {
  runtime: ControlCenterRuntime;
  token: string;
  allowedOrigins: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  maxJsonBytes: number;
  instanceId: string;
  startedAt: string;
  state: DaemonState;
  logger: DaemonLogger;
  agentCache: { expiresAt: number; value: unknown[] } | null;
  wakeWorker(): void;
}

const defaultLogger: DaemonLogger = {
  info: (message) => console.log(message),
  error: (message, error) => console.error(message, error),
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) {
    return new HttpError(400, "validation_failed", "Request validation failed", false, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (error instanceof RunControlError) {
    if (error.code === "run_not_found") {
      return new HttpError(404, "not_found", error.message);
    }
    return new HttpError(409, "state_conflict", error.message, error.code === "run_starting");
  }
  if (error instanceof Error && error.name === "AdapterCapabilityError") {
    return new HttpError(409, "capability_unsupported", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|Task disappeared|Run disappeared/iu.test(message)) {
    return new HttpError(404, "not_found", message);
  }
  if (
    /must be|requires|status|transition|concurrent|claimed|does not own|not running|not pending|belongs to/iu.test(
      message,
    )
  ) {
    return new HttpError(409, "state_conflict", message);
  }
  return new HttpError(500, "internal_error", "Internal control-plane error", true);
}

function errorBody(error: HttpError): StoredApiBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function setCommonHeaders(
  response: ServerResponse,
  requestId: string,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): void {
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: StoredApiBody,
  requestId: string,
  context: RequestContext,
  options: { replayed?: boolean; origin?: string } = {},
): void {
  if (response.headersSent || response.destroyed) return;
  setCommonHeaders(response, requestId, options.origin, context.allowedOrigins);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (options.replayed) response.setHeader("Idempotency-Replayed", "true");
  response.end(`${JSON.stringify({ ...body, requestId })}\n`);
}

async function readBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<{ raw: string; value: unknown }> {
  const declaredLength = Number(headerValue(request.headers["content-length"]));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    request.resume();
    throw new HttpError(413, "payload_too_large", `Request exceeds ${maximumBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      request.resume();
      throw new HttpError(413, "payload_too_large", `Request exceeds ${maximumBytes} bytes`);
    }
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return { raw: "", value: {} };
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new HttpError(400, "validation_failed", "Request body must be valid JSON");
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "validation_failed", "URL contains invalid percent encoding");
  }
}

function requestFingerprint(request: IncomingMessage, rawBody: string): string {
  return createHash("sha256")
    .update(request.method ?? "")
    .update("\0")
    .update(request.url ?? "")
    .update("\0")
    .update(rawBody)
    .digest("hex");
}

async function runIdempotentMutation(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  rawBody: string,
  context: RequestContext,
  origin: string | undefined,
  handler: () => Promise<{ status: number; data: unknown }>,
): Promise<void> {
  const keyHeader = headerValue(request.headers["idempotency-key"]);
  if (!keyHeader) {
    throw new HttpError(
      428,
      "idempotency_required",
      "Idempotency-Key is required for mutations",
    );
  }
  const key = IdempotencyKeySchema.parse(keyHeader);
  const hash = requestFingerprint(request, rawBody);
  const claim = await context.runtime.db.claimIdempotencyKey(key, hash);
  if (claim.kind === "conflict") {
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used for a different request",
    );
  }
  if (claim.kind === "pending") {
    throw new HttpError(
      409,
      "idempotency_pending",
      "The original request is still pending or requires reconciliation",
      true,
    );
  }
  if (claim.kind === "replay") {
    const stored = claim.responseBody as StoredApiBody;
    sendJson(response, claim.responseStatus, stored, requestId, context, {
      replayed: true,
      ...(origin ? { origin } : {}),
    });
    return;
  }

  let status: number;
  let stored: StoredApiBody;
  try {
    const result = await handler();
    status = result.status;
    stored = { data: result.data };
  } catch (error) {
    const normalized = normalizeError(error);
    status = normalized.status;
    stored = errorBody(normalized);
  }
  // Completing after the side effect makes an ambiguous persistence failure
  // fail closed: the durable key remains pending and retries cannot duplicate it.
  await context.runtime.db.completeIdempotencyKey(key, hash, {
    statusCode: status,
    body: stored,
  });
  sendJson(response, status, stored, requestId, context, {
    ...(origin ? { origin } : {}),
  });
}

async function loadAggregates(
  context: RequestContext,
  status?: z.infer<typeof TaskStatusSchema>,
): Promise<TaskAggregate[]> {
  const tasks = await context.runtime.db.listTasks(status);
  const aggregates = await Promise.all(
    tasks.map((task) => context.runtime.db.getTask(task.id)),
  );
  return aggregates.filter((item): item is TaskAggregate => item !== null);
}

async function agentSnapshot(context: RequestContext): Promise<unknown[]> {
  if (context.agentCache && context.agentCache.expiresAt > Date.now()) {
    return context.agentCache.value;
  }
  const checkedAt = new Date().toISOString();
  const value = await Promise.all(
    AgentKindSchema.options.map(async (agent) => {
      const adapter = context.runtime.adapters.get(agent);
      const availability = adapter
        ? await adapter.availability()
        : { available: false, target: "not registered", version: null, reason: "Adapter is not registered." };
      return {
        agent,
        ...availability,
        capabilities: {
          liveMessage: agent === "openclaw",
          cancel: true,
          remote: agent === "openclaw",
        },
        checkedAt,
      };
    }),
  );
  context.agentCache = { expiresAt: Date.now() + 15_000, value };
  return value;
}

function parseBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new HttpError(400, "validation_failed", "dataBase64 is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new HttpError(400, "validation_failed", "dataBase64 is not canonical base64");
  }
  return bytes;
}

function artifactContentType(
  path: string,
  metadata: Record<string, unknown> | null,
): string {
  if (typeof metadata?.contentType === "string" && metadata.contentType.startsWith("image/")) {
    return metadata.contentType;
  }
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "application/json; charset=utf-8";
  if ([".txt", ".log", ".md", ".patch"].includes(extension)) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

async function sendArtifact(
  artifactId: string,
  response: ServerResponse,
  requestId: string,
  context: RequestContext,
  origin: string | undefined,
): Promise<void> {
  const artifact = await context.runtime.db.getArtifact(artifactId);
  if (!artifact) throw new HttpError(404, "not_found", `Artifact not found: ${artifactId}`);
  const root = await realpath(context.runtime.config.artifactsDir);
  const info = await lstat(artifact.path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new HttpError(409, "state_conflict", "Artifact is not a regular file");
  }
  const path = await realpath(artifact.path);
  const child = relative(root, path);
  if (
    child === "" ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new HttpError(409, "state_conflict", "Artifact path escaped storage root");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== artifact.sizeBytes) {
    throw new HttpError(409, "state_conflict", "Artifact size no longer matches metadata");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new HttpError(409, "state_conflict", "Artifact hash no longer matches metadata");
  }
  setCommonHeaders(response, requestId, origin, context.allowedOrigins);
  response.statusCode = 200;
  response.setHeader("Content-Type", artifactContentType(path, artifact.metadata));
  response.setHeader("Content-Length", String(bytes.byteLength));
  response.setHeader("ETag", `"${artifact.sha256}"`);
  response.setHeader(
    "Content-Disposition",
    `inline; filename="${basename(path).replaceAll('"', "")}"`,
  );
  response.end(bytes);
}

function formatSseEvent(event: EventRecord): string {
  return [
    `id: ${event.id}`,
    `event: ${event.type.replace(/[^A-Za-z0-9_.-]/gu, "_")}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

class SseSink {
  readonly #response: ServerResponse;
  readonly #queue: string[] = [];
  #queuedBytes = 0;
  #backpressured = false;
  #closed = false;

  constructor(response: ServerResponse) {
    this.#response = response;
    response.on("drain", () => this.#flush());
    response.on("close", () => {
      this.#closed = true;
      this.#queue.length = 0;
      this.#queuedBytes = 0;
    });
  }

  get closed(): boolean {
    return this.#closed || this.#response.destroyed;
  }

  write(value: string): void {
    if (this.closed) return;
    if (!this.#backpressured && this.#queue.length === 0) {
      this.#backpressured = !this.#response.write(value);
      return;
    }
    const bytes = Buffer.byteLength(value);
    if (this.#queuedBytes + bytes > SSE_MAX_BUFFER_BYTES) {
      this.#response.destroy();
      return;
    }
    this.#queue.push(value);
    this.#queuedBytes += bytes;
  }

  #flush(): void {
    if (this.closed) return;
    this.#backpressured = false;
    while (!this.#backpressured && this.#queue.length > 0) {
      const value = this.#queue.shift()!;
      this.#queuedBytes -= Buffer.byteLength(value);
      this.#backpressured = !this.#response.write(value);
    }
  }
}

function parseEventCursor(value: string | null | undefined): number {
  if (!value) return 0;
  if (!/^[0-9]+$/u.test(value)) {
    throw new HttpError(400, "validation_failed", "Event cursor must be an integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(400, "validation_failed", "Event cursor is too large");
  }
  return parsed;
}

async function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestId: string,
  context: RequestContext,
  origin: string | undefined,
): Promise<void> {
  const queryCursor = parseEventCursor(url.searchParams.get("after"));
  const headerCursor = parseEventCursor(headerValue(request.headers["last-event-id"]));
  let cursor = Math.max(queryCursor, headerCursor);
  const rawTaskId = url.searchParams.get("taskId");
  const taskId = rawTaskId ? TaskIdSchema.parse(rawTaskId) : undefined;

  setCommonHeaders(response, requestId, origin, context.allowedOrigins);
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  const sink = new SseSink(response);
  let draining: Promise<void> | null = null;
  let drainAgain = false;

  const drain = async (): Promise<void> => {
    if (sink.closed) return;
    if (draining) {
      drainAgain = true;
      return await draining;
    }
    draining = (async () => {
      do {
        drainAgain = false;
        while (!sink.closed) {
          const events = await context.runtime.db.listEventsAfter(cursor, taskId, 500);
          if (events.length === 0) break;
          for (const event of events) {
            if (event.id <= cursor) continue;
            sink.write(formatSseEvent(event));
            cursor = event.id;
          }
          if (events.length < 500) break;
        }
      } while (drainAgain && !sink.closed);
    })().finally(() => {
      draining = null;
    });
    return await draining;
  };

  // Subscribe before the first durable read. Bus notifications only wake a DB
  // drain; SQLite IDs are the source of truth, which closes replay/live gaps.
  const unsubscribe = context.runtime.bus.subscribe(() => void drain());
  const poll = setInterval(() => void drain(), 1_000);
  const heartbeat = setInterval(() => sink.write(": keepalive\n\n"), 15_000);
  poll.unref();
  heartbeat.unref();
  const cleanup = () => {
    unsubscribe();
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  response.once("close", cleanup);
  await drain();
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  context: RequestContext,
  origin: string | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://acc.local");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments[0] !== API_VERSION) {
    throw new HttpError(404, "not_found", "API route not found");
  }
  const method = request.method ?? "GET";

  if (method === "GET" && segments.length === 2 && segments[1] === "health") {
    sendJson(
      response,
      200,
      {
        data: {
          status: context.state.lastWorkerError ? "degraded" : "ready",
          apiVersion: API_VERSION,
          version: "0.1.0",
          pid: process.pid,
          instanceId: context.instanceId,
          startedAt: context.startedAt,
          worker: context.state.worker,
          recovery: context.runtime.recovery,
        },
      },
      requestId,
      context,
      { ...(origin ? { origin } : {}) },
    );
    return;
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "agents") {
    sendJson(response, 200, { data: { agents: await agentSnapshot(context) } }, requestId, context, {
      ...(origin ? { origin } : {}),
    });
    return;
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "control-center") {
    const aggregates = await loadAggregates(context);
    const rows = aggregates.map(projectTaskBoardRow);
    const counts = Object.fromEntries(
      TaskStatusSchema.options.map((status) => [
        status,
        rows.filter((row) => row.status === status).length,
      ]),
    );
    const attention = rows.filter((row) =>
      ["running", "blocked", "needs-review"].includes(row.status),
    );
    sendJson(
      response,
      200,
      {
        data: {
          daemon: {
            status: context.state.lastWorkerError ? "degraded" : "ready",
            apiVersion: API_VERSION,
            version: "0.1.0",
            pid: process.pid,
            instanceId: context.instanceId,
            startedAt: context.startedAt,
            worker: context.state.worker,
          },
          counts,
          attention,
          agents: await agentSnapshot(context),
        },
      },
      requestId,
      context,
      { ...(origin ? { origin } : {}) },
    );
    return;
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "tasks") {
    const status = url.searchParams.get("status");
    const aggregates = await loadAggregates(
      context,
      status ? TaskStatusSchema.parse(status) : undefined,
    );
    sendJson(
      response,
      200,
      { data: { tasks: aggregates.map(projectTaskBoardRow) } },
      requestId,
      context,
      { ...(origin ? { origin } : {}) },
    );
    return;
  }

  if (method === "POST" && segments.length === 2 && segments[1] === "tasks") {
    const body = await readBody(request, context.maxJsonBytes);
    await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
      const created = await context.runtime.coordinator.createTask(TaskPayloadSchema.parse(body.value));
      context.wakeWorker();
      return { status: 201, data: projectTaskDetail(created) };
    });
    return;
  }

  if (segments.length >= 3 && segments[1] === "tasks") {
    const taskId = TaskIdSchema.parse(segments[2]);
    if (method === "GET" && segments.length === 3) {
      const aggregate = await context.runtime.db.getTask(taskId);
      if (!aggregate) throw new HttpError(404, "not_found", `Task not found: ${taskId}`);
      sendJson(response, 200, { data: projectTaskDetail(aggregate) }, requestId, context, {
        ...(origin ? { origin } : {}),
      });
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "retry") {
      const body = await readBody(request, context.maxJsonBytes);
      await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
        const parsed = RetryBodySchema.parse(body.value);
        await context.runtime.coordinator.retryBlockedTask(
          taskId,
          parsed.note,
          parsed.allowUnconfirmedRemote,
        );
        context.wakeWorker();
        const aggregate = await context.runtime.db.getTask(taskId);
        if (!aggregate) throw new Error(`Task disappeared: ${taskId}`);
        return { status: 202, data: projectTaskDetail(aggregate) };
      });
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "cancel") {
      const body = await readBody(request, context.maxJsonBytes);
      await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
        await context.runtime.coordinator.stopTask(taskId);
        return {
          status: 202,
          data: {
            operationId: `op_${randomUUID()}`,
            state: "accepted",
            taskId,
            createdAt: new Date().toISOString(),
          },
        };
      });
      return;
    }
    if (
      method === "POST" &&
      segments.length === 6 &&
      segments[3] === "runs" &&
      segments[5] === "screenshots"
    ) {
      const runId = EntityIdSchema.parse(segments[4]);
      const body = await readBody(request, SCREENSHOT_MAX_JSON_BYTES);
      await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
        const parsed = ScreenshotSchema.parse(body.value);
        const artifact = await context.runtime.coordinator.attachScreenshot({
          taskId,
          runId,
          name: parsed.name,
          contentType: parsed.contentType,
          data: parseBase64(parsed.dataBase64),
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        });
        return {
          status: 201,
          data: {
            id: artifact.id,
            kind: artifact.kind,
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
            contentUrl: `/v1/artifacts/${encodeURIComponent(artifact.id)}/content`,
          },
        };
      });
      return;
    }
  }

  if (segments.length >= 3 && segments[1] === "runs") {
    const runId = EntityIdSchema.parse(segments[2]);
    if (method === "POST" && segments.length === 4 && segments[3] === "messages") {
      const body = await readBody(request, context.maxJsonBytes);
      await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
        const parsed = MessageBodySchema.parse(body.value);
        const message = await context.runtime.coordinator.postMessageToRun(runId, parsed.body);
        return { status: 202, data: message };
      });
      return;
    }
    if (method === "POST" && segments.length === 4 && segments[3] === "cancel") {
      const body = await readBody(request, context.maxJsonBytes);
      await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
        const state = await context.runtime.coordinator.stopRun(runId);
        const run = await context.runtime.db.getRun(runId);
        return {
          status: 202,
          data: {
            operationId: `op_${randomUUID()}`,
            state,
            runId,
            taskId: run?.taskId ?? null,
            createdAt: new Date().toISOString(),
          },
        };
      });
      return;
    }
  }

  if (
    method === "POST" &&
    segments.length === 4 &&
    segments[1] === "reviews" &&
    segments[3] === "decision"
  ) {
    const reviewId = EntityIdSchema.parse(segments[2]);
    const body = await readBody(request, context.maxJsonBytes);
    await runIdempotentMutation(request, response, requestId, body.raw, context, origin, async () => {
      const parsed = ReviewDecisionSchema.parse(body.value);
      let taskId: string;
      if (parsed.decision === "approved") {
        taskId = await context.runtime.coordinator.approveReview(
          reviewId,
          parsed.expectedUpdatedAt,
          parsed.note,
        );
      } else {
        taskId = await context.runtime.coordinator.requestReviewRework(
          reviewId,
          parsed.expectedUpdatedAt,
          parsed.note!,
        );
        context.wakeWorker();
      }
      const aggregate = await context.runtime.db.getTask(taskId);
      if (!aggregate) throw new Error(`Task disappeared: ${taskId}`);
      return { status: 200, data: projectTaskDetail(aggregate) };
    });
    return;
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "reviews") {
    const status = url.searchParams.get("status");
    const reviews = await context.runtime.db.listReviews(undefined, {
      ...(status ? { status: status as "pending" | "approved" | "rework_requested" | "rejected" } : {}),
      limit: 500,
    });
    sendJson(response, 200, { data: { reviews } }, requestId, context, {
      ...(origin ? { origin } : {}),
    });
    return;
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "runs") {
    const status = url.searchParams.get("status");
    const agent = url.searchParams.get("agent");
    const records = await context.runtime.db.listRuns(undefined, {
      ...(status ? { status: z.enum(["queued", "starting", "running", "succeeded", "failed", "stopped", "stale"]).parse(status) } : {}),
      ...(agent ? { agent: AgentKindSchema.parse(agent) } : {}),
      limit: 500,
    });
    const runs = records.map((run) => ({
      id: run.id,
      taskId: run.taskId,
      routeStepId: run.routeStepId,
      agent: run.agent,
      role: run.role,
      attempt: run.attempt,
      status: run.status,
      branch: run.branch,
      baseCommit: run.baseCommit,
      exitCode: run.exitCode,
      signal: run.signal,
      summary: run.summary,
      error: run.error,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    }));
    sendJson(response, 200, { data: { runs } }, requestId, context, {
      ...(origin ? { origin } : {}),
    });
    return;
  }

  if (
    method === "GET" &&
    segments.length === 4 &&
    segments[1] === "artifacts" &&
    segments[3] === "content"
  ) {
    await sendArtifact(EntityIdSchema.parse(segments[2]), response, requestId, context, origin);
    return;
  }

  if (method === "GET" && segments.length === 2 && segments[1] === "events") {
    await openEventStream(request, response, url, requestId, context, origin);
    return;
  }

  throw new HttpError(404, "not_found", "API route not found");
}

function validateLoopbackHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!["127.0.0.1", "::1", "localhost"].includes(normalized)) {
    throw new Error("Daemon TCP host must be loopback (127.0.0.1, ::1, or localhost)");
  }
  return normalized;
}

export async function startControlCenterDaemon(
  options: StartDaemonOptions,
): Promise<DaemonHandle> {
  const runtime = options.runtime;
  const host = validateLoopbackHost(options.host ?? DEFAULT_HOST);
  const requestedPort = options.port ?? DEFAULT_PORT;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("Daemon port must be an integer from 0 to 65535");
  }
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs < 100) {
    throw new Error("Daemon poll interval must be an integer of at least 100ms");
  }
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1024) {
    throw new Error("Daemon JSON limit must be an integer of at least 1024 bytes");
  }
  const logger = options.logger ?? defaultLogger;
  let lease: DaemonLease | null = null;
  let tokenRecord: { token: string; path: string | null };
  try {
    if (options.acquireLease ?? true) {
      lease = await acquireDaemonLease(runtime.config.homeDir);
      if (lease.reclaimed) {
        await runtime.recoverDeadWorker(
          `daemon:${lease.reclaimed.pid}`,
          `daemon:${process.pid}`,
        );
      }
    }
    tokenRecord = options.token
      ? { token: options.token, path: null }
      : await loadOrCreateBearerToken(runtime.config.homeDir);
  } catch (error) {
    await lease?.release().catch(() => undefined);
    throw error;
  }
  if (!/^[A-Za-z0-9_-]{16,}$/u.test(tokenRecord.token)) {
    await lease?.release();
    throw new Error("Daemon bearer token must be at least 128 bits of base64url data");
  }

  const instanceId = `daemon_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const state: DaemonState = {
    worker: options.enableWorker === false ? "disabled" : "idle",
    stopping: false,
    lastWorkerError: null,
  };
  let wakeResolver: (() => void) | null = null;
  const wakeWorker = () => {
    wakeResolver?.();
    wakeResolver = null;
  };
  const waitForWork = async (): Promise<void> => {
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(() => {
        wakeResolver = null;
        resolveWait();
      }, pollMs);
      timer.unref();
      wakeResolver = () => {
        clearTimeout(timer);
        resolveWait();
      };
    });
  };

  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const allowedHosts = new Set<string>();
  const context: RequestContext = {
    runtime,
    token: tokenRecord.token,
    allowedOrigins,
    allowedHosts,
    maxJsonBytes,
    instanceId,
    startedAt,
    state,
    logger,
    agentCache: null,
    wakeWorker,
  };

  const server = createServer((request, response) => {
    const requestId = `req_${randomUUID()}`;
    const origin = headerValue(request.headers.origin);
    void (async () => {
      const hostHeader = headerValue(request.headers.host)?.toLowerCase();
      if (!hostHeader || !allowedHosts.has(hostHeader)) {
        throw new HttpError(403, "forbidden", "Host header is not allowed");
      }
      if (origin && !allowedOrigins.has(origin)) {
        throw new HttpError(403, "forbidden", "Origin is not allowed");
      }
      if (request.method === "OPTIONS") {
        if (!origin) throw new HttpError(403, "forbidden", "CORS preflight requires Origin");
        setCommonHeaders(response, requestId, origin, allowedOrigins);
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Idempotency-Key, Last-Event-ID",
        );
        response.end();
        return;
      }
      if (!bearerTokenMatches(context.token, headerValue(request.headers.authorization))) {
        response.setHeader("WWW-Authenticate", 'Bearer realm="Agent Control Center"');
        throw new HttpError(401, "unauthorized", "A valid bearer token is required");
      }
      await routeRequest(request, response, requestId, context, origin);
    })().catch((error: unknown) => {
      const normalized = normalizeError(error);
      if (normalized.status >= 500) logger.error("Daemon request failed", error);
      sendJson(response, normalized.status, errorBody(normalized), requestId, context, {
        ...(origin ? { origin } : {}),
      });
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once("error", onError);
      server.listen(requestedPort, host, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (error) {
    await lease?.release().catch(() => undefined);
    throw error;
  }
  const address = server.address() as AddressInfo;
  const port = address.port;
  allowedHosts.add(`127.0.0.1:${port}`);
  allowedHosts.add(`localhost:${port}`);
  allowedHosts.add(`[::1]:${port}`);

  let workerPromise: Promise<void> | null = null;
  if (options.enableWorker !== false) {
    workerPromise = (async () => {
      while (!state.stopping) {
        try {
          state.worker = "running";
          const result = await runtime.coordinator.runNext();
          state.lastWorkerError = null;
          if (!result) {
            state.worker = "idle";
            await waitForWork();
          }
        } catch (error) {
          state.lastWorkerError = error instanceof Error ? error.message : String(error);
          logger.error("Daemon worker iteration failed", error);
          state.worker = "idle";
          await waitForWork();
        }
      }
      state.worker = "stopping";
    })();
  }

  let stopPromise: Promise<void> | null = null;
  return {
    instanceId,
    host,
    port,
    url: `http://${host === "::1" ? "[::1]" : host}:${port}`,
    token: tokenRecord.token,
    tokenPath: tokenRecord.path,
    startedAt,
    async stop(): Promise<void> {
      stopPromise ??= (async () => {
        state.stopping = true;
        state.worker = options.enableWorker === false ? "disabled" : "stopping";
        wakeWorker();
        await runtime.coordinator.requestShutdown();
        await workerPromise;
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
          server.closeAllConnections();
        });
        if (options.closeRuntimeOnStop ?? true) await runtime.close();
        await lease?.release();
      })();
      return await stopPromise;
    },
  };
}
