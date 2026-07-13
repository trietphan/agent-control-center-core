import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RouteRole } from "../protocol.js";
import { buildTaskPrompt } from "./prompt.js";
import type {
  AdapterAvailability,
  AdapterResult,
  AdapterRun,
  AdapterTaskRequest,
  AdapterTerminalStatus,
  AgentAdapter,
} from "./types.js";
import { CONTROL_RUN_TOKEN_ENV } from "./types.js";
import { AdapterRunNotFoundError } from "./types.js";

export interface OpenClawEndpoints {
  health: string;
  start: string;
  result: (remoteId: string) => string;
  message: (remoteId: string) => string;
  stop: (remoteId: string) => string;
}

export type OpenClawFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenClawAdapterOptions {
  baseUrl: string;
  token?: string;
  headers?: Readonly<Record<string, string>>;
  endpoints?: Partial<OpenClawEndpoints>;
  fetch?: OpenClawFetch;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxConsecutivePollErrors?: number;
  maxResponseBytes?: number;
  maxRunLogBytes?: number;
}

interface OpenClawRunState {
  id: string;
  remoteId: string;
  taskId: string;
  role: RouteRole;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | AdapterTerminalStatus;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  exitCode: number | null;
  summary: string;
  error: string | null;
}

export interface OpenClawDurableCancellation {
  remoteId: string;
  status: AdapterTerminalStatus;
  error: string | null;
}

const DEFAULT_ENDPOINTS: OpenClawEndpoints = {
  health: "/health",
  start: "/tasks",
  result: (remoteId) => `/tasks/${encodeURIComponent(remoteId)}`,
  message: (remoteId) => `/tasks/${encodeURIComponent(remoteId)}/messages`,
  stop: (remoteId) => `/tasks/${encodeURIComponent(remoteId)}/stop`,
};

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_RUN_LOG_BYTES = 16 * 1024 * 1024;

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    if (typeof value[name] === "string" && value[name]) return value[name];
  }
  return null;
}

function extractRemoteId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return stringField(payload, ["id", "runId", "taskId", "sessionId"]);
}

function extractSummary(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const direct = stringField(payload, ["result", "summary", "output"]);
  if (direct) return direct;

  if (isRecord(payload.result)) {
    return stringField(payload.result, ["summary", "output", "content", "text"]) ?? "";
  }
  return "";
}

function extractStatus(payload: unknown): "running" | AdapterTerminalStatus {
  if (!isRecord(payload)) return "running";
  const raw = stringField(payload, ["status", "state"])?.toLowerCase();
  if (["done", "completed", "complete", "success", "succeeded"].includes(raw ?? "")) {
    return "succeeded";
  }
  if (["failed", "failure", "error", "blocked"].includes(raw ?? "")) {
    return "failed";
  }
  if (["stopped", "cancelled", "canceled"].includes(raw ?? "")) {
    return "stopped";
  }
  if (["stale", "unknown", "lost"].includes(raw ?? "")) {
    return "stale";
  }
  if (["queued", "starting", "running", "pending", "in-progress", "in_progress"].includes(raw ?? "")) {
    return "running";
  }
  if (payload.error) return "failed";
  if (!raw && extractSummary(payload)) return "succeeded";
  return "running";
}

function extractError(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.error === "string") return payload.error;
  if (isRecord(payload.error)) {
    return stringField(payload.error, ["message", "detail"]);
  }
  return null;
}

function extractExitCode(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return typeof payload.exitCode === "number" ? payload.exitCode : null;
}

function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class OpenClawAdapter implements AgentAdapter {
  readonly kind = "openclaw" as const;

  readonly #baseUrl: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #endpoints: OpenClawEndpoints;
  readonly #fetch: OpenClawFetch;
  readonly #pollIntervalMs: number;
  readonly #pollTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #maxConsecutivePollErrors: number;
  readonly #maxResponseBytes: number;
  readonly #maxRunLogBytes: number;
  readonly #runs = new Map<string, OpenClawRunState>();
  readonly #logBytes = new Map<string, number>();

  constructor(options: OpenClawAdapterOptions) {
    const base = new URL(options.baseUrl);
    const localHttp =
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
    if (base.protocol !== "https:" && !localHttp) {
      throw new Error(
        "OpenClaw adapter requires HTTPS (plain HTTP is allowed only for localhost)",
      );
    }
    this.#baseUrl = base.toString().replace(/\/+$/, "");
    this.#headers = {
      accept: "application/json",
      "content-type": "application/json",
      ...options.headers,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    };
    this.#endpoints = {
      ...DEFAULT_ENDPOINTS,
      ...options.endpoints,
    };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? 10 * 60_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    this.#maxConsecutivePollErrors = options.maxConsecutivePollErrors ?? 3;
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "OpenClaw maxResponseBytes",
    );
    this.#maxRunLogBytes = positiveInteger(
      options.maxRunLogBytes,
      DEFAULT_MAX_RUN_LOG_BYTES,
      "OpenClaw maxRunLogBytes",
    );
  }

  async availability(): Promise<AdapterAvailability> {
    try {
      const { response, payload } = await this.#request("GET", this.#endpoints.health);
      return {
        available: response.ok,
        target: this.#baseUrl,
        version: isRecord(payload)
          ? stringField(payload, ["version", "name"])
          : null,
        reason: response.ok
          ? null
          : `Health check returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        available: false,
        target: this.#baseUrl,
        version: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async startTask(request: AdapterTaskRequest): Promise<AdapterRun> {
    const localId = `run_${randomUUID()}`;
    const requestId = request.env?.[CONTROL_RUN_TOKEN_ENV]?.trim() || localId;
    const role = request.role ?? "execute";
    const stdoutPath = join(request.artifactDir, `${this.kind}.stdout.log`);
    const stderrPath = join(request.artifactDir, `${this.kind}.stderr.log`);
    const resultPath = join(request.artifactDir, `${this.kind}.result.txt`);
    await mkdir(request.artifactDir, { recursive: true });
    await Promise.all([
      writeFile(stdoutPath, "", "utf8"),
      writeFile(stderrPath, "", "utf8"),
      writeFile(resultPath, "", "utf8"),
    ]);
    this.#logBytes.set(stdoutPath, 0);

    let payload: unknown;
    try {
      const response = await this.#request("POST", this.#endpoints.start, {
        requestId,
        task: request.task,
        role,
        prompt: request.prompt ?? buildTaskPrompt(request),
        workingDirectory: request.workingDirectory,
      });
      payload = response.payload;
      await this.#recordHttp(stdoutPath, response.response.status, payload);
      if (!response.response.ok) {
        throw new Error(`OpenClaw start returned HTTP ${response.response.status}`);
      }
    } catch (error) {
      await appendFile(
        stderrPath,
        `${error instanceof Error ? error.message : String(error)}\n`,
        "utf8",
      );
      throw error;
    }

    const summary = extractSummary(payload);
    if (summary) await writeFile(resultPath, summary, "utf8");
    const status = extractStatus(payload);
    const remoteId = extractRemoteId(payload) ?? requestId;
    const state: OpenClawRunState = {
      id: remoteId,
      remoteId,
      taskId: request.task.id ?? requestId,
      role,
      startedAt: new Date().toISOString(),
      finishedAt: status === "running" ? null : new Date().toISOString(),
      status,
      workingDirectory: request.workingDirectory,
      stdoutPath,
      stderrPath,
      resultPath,
      exitCode: extractExitCode(payload),
      summary,
      error: extractError(payload),
    };
    this.#runs.set(state.id, state);

    return this.#runSnapshot(state);
  }

  async postMessage(runId: string, message: string): Promise<void> {
    const state = this.#get(runId);
    if (state.status !== "running") {
      throw new Error(`OpenClaw run ${runId} is already ${state.status}`);
    }

    const response = await this.#request(
      "POST",
      this.#endpoints.message(state.remoteId),
      { message },
    );
    await this.#recordHttp(state.stdoutPath, response.response.status, response.payload);
    if (!response.response.ok) {
      throw new Error(`OpenClaw message returned HTTP ${response.response.status}`);
    }
  }

  async collectResult(runId: string): Promise<AdapterResult> {
    const state = this.#get(runId);
    const deadline = Date.now() + this.#pollTimeoutMs;
    let consecutiveErrors = 0;

    while (state.status === "running") {
      if (Date.now() > deadline) {
        await this.#cancelAfterPollingFailure(
          state,
          `Timed out waiting ${this.#pollTimeoutMs}ms for OpenClaw run ${runId}`,
        );
        break;
      }

      try {
        const response = await this.#request(
          "GET",
          this.#endpoints.result(state.remoteId),
        );
        await this.#recordHttp(
          state.stdoutPath,
          response.response.status,
          response.payload,
        );
        if (!response.response.ok) {
          throw new Error(`OpenClaw result returned HTTP ${response.response.status}`);
        }
        await this.#updateState(state, response.payload);
        consecutiveErrors = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendFile(state.stderrPath, `${message}\n`, "utf8");
        consecutiveErrors += 1;
        if (consecutiveErrors >= this.#maxConsecutivePollErrors) {
          await this.#cancelAfterPollingFailure(
            state,
            `OpenClaw polling failed ${consecutiveErrors} consecutive times: ${message}`,
          );
        }
      }

      if (state.status === "running") {
        const backoff = Math.min(
          this.#pollIntervalMs * Math.max(1, 2 ** consecutiveErrors),
          30_000,
        );
        await sleep(backoff);
      }
    }

    return this.#resultSnapshot(state);
  }

  async stop(runId: string): Promise<AdapterResult> {
    const state = this.#get(runId);
    if (state.status !== "running") return this.#resultSnapshot(state);
    try {
      await this.#stopRemote(state);
    } catch (error) {
      state.status = "stale";
      state.finishedAt = new Date().toISOString();
      state.error = `Remote cancellation could not be confirmed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await appendFile(state.stderrPath, `${state.error}\n`, "utf8");
    }
    return this.#resultSnapshot(state);
  }

  /** Cancel a persisted remote handle after the original worker has restarted. */
  async cancelDurable(remoteId: string): Promise<OpenClawDurableCancellation> {
    const handle = remoteId.trim();
    if (!handle) {
      return { remoteId, status: "stale", error: "Remote cancellation handle is empty." };
    }
    try {
      const stopped = await this.#request("POST", this.#endpoints.stop(handle));
      if (!stopped.response.ok) {
        throw new Error(`OpenClaw stop returned HTTP ${stopped.response.status}`);
      }
      let status = extractStatus(stopped.payload);
      let error = extractError(stopped.payload);
      const deadline = Date.now() + this.#stopTimeoutMs;
      let consecutiveErrors = 0;
      while (status === "running") {
        if (Date.now() > deadline) {
          throw new Error(
            `OpenClaw did not confirm cancellation within ${this.#stopTimeoutMs}ms`,
          );
        }
        await sleep(this.#pollIntervalMs);
        try {
          const poll = await this.#request("GET", this.#endpoints.result(handle));
          if (!poll.response.ok) {
            throw new Error(`OpenClaw result returned HTTP ${poll.response.status}`);
          }
          status = extractStatus(poll.payload);
          error = extractError(poll.payload);
          consecutiveErrors = 0;
        } catch (pollError) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= this.#maxConsecutivePollErrors) throw pollError;
        }
      }
      return { remoteId: handle, status, error };
    } catch (error) {
      return {
        remoteId: handle,
        status: "stale",
        error: `Remote cancellation could not be confirmed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async #cancelAfterPollingFailure(
    state: OpenClawRunState,
    reason: string,
  ): Promise<void> {
    await appendFile(state.stderrPath, `${reason}\n`, "utf8");
    try {
      await this.#stopRemote(state);
      if (state.status !== "succeeded") {
        state.error = state.error ?? reason;
      }
    } catch (error) {
      state.status = "stale";
      state.finishedAt = new Date().toISOString();
      state.error = `${reason}; remote cancellation could not be confirmed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await appendFile(state.stderrPath, `${state.error}\n`, "utf8");
    }
  }

  async #stopRemote(state: OpenClawRunState): Promise<void> {
    const response = await this.#request(
      "POST",
      this.#endpoints.stop(state.remoteId),
    );
    await this.#recordHttp(state.stdoutPath, response.response.status, response.payload);
    if (!response.response.ok) {
      throw new Error(`OpenClaw stop returned HTTP ${response.response.status}`);
    }
    await this.#updateState(state, response.payload);
    const deadline = Date.now() + this.#stopTimeoutMs;
    let consecutiveErrors = 0;
    while (state.status === "running") {
      if (Date.now() > deadline) {
        throw new Error(`OpenClaw did not confirm cancellation within ${this.#stopTimeoutMs}ms`);
      }
      await sleep(this.#pollIntervalMs);
      try {
        const poll = await this.#request(
          "GET",
          this.#endpoints.result(state.remoteId),
        );
        await this.#recordHttp(state.stdoutPath, poll.response.status, poll.payload);
        if (!poll.response.ok) {
          throw new Error(`OpenClaw result returned HTTP ${poll.response.status}`);
        }
        await this.#updateState(state, poll.payload);
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        await appendFile(state.stderrPath, `${message}\n`, "utf8");
        if (consecutiveErrors >= this.#maxConsecutivePollErrors) throw error;
      }
    }
  }

  async #request(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
  ): Promise<{ response: Response; payload: unknown }> {
    const init: RequestInit = {
      method,
      headers: this.#headers,
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const base = new URL(`${this.#baseUrl}/`);
    const url = /^https?:\/\//i.test(endpoint)
      ? new URL(endpoint)
      : new URL(`${this.#baseUrl}/${endpoint.replace(/^\/+/, "")}`);
    if (url.origin !== base.origin) {
      throw new Error("OpenClaw endpoint must remain on the configured adapter origin");
    }
    const response = await this.#fetch(url.toString(), init);
    const text = await this.#readResponseText(response, init.signal);
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }
    return { response, payload };
  }

  async #recordHttp(path: string, status: number, payload: unknown): Promise<void> {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
    const line = Buffer.from(`${status} ${serialized}\n`, "utf8");
    const used = this.#logBytes.get(path) ?? 0;
    const remaining = Math.max(0, this.#maxRunLogBytes - used);
    if (remaining === 0) return;
    if (line.byteLength <= remaining) {
      await appendFile(path, line);
      this.#logBytes.set(path, used + line.byteLength);
      return;
    }
    const marker = Buffer.from("\n[OpenClaw HTTP log truncated]\n", "utf8");
    const contentBytes = Math.max(0, remaining - marker.byteLength);
    const tail = marker.subarray(0, Math.max(0, remaining - contentBytes));
    await appendFile(
      path,
      Buffer.concat([line.subarray(0, contentBytes), tail], remaining),
    );
    this.#logBytes.set(path, this.#maxRunLogBytes);
  }

  async #readResponseText(
    response: Response,
    signal: AbortSignal | null | undefined,
  ): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared && /^[0-9]+$/u.test(declared)) {
      const size = Number(declared);
      if (!Number.isSafeInteger(size) || size > this.#maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `OpenClaw response exceeds ${this.#maxResponseBytes} bytes`,
        );
      }
    }
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let rejectAbort: ((reason?: unknown) => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      void reader.cancel(signal?.reason).catch(() => undefined);
      rejectAbort?.(signal?.reason ?? new Error("OpenClaw request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.#maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(
            `OpenClaw response exceeds ${this.#maxResponseBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ).toString("utf8");
  }

  async #updateState(state: OpenClawRunState, payload: unknown): Promise<void> {
    const summary = extractSummary(payload);
    if (summary) {
      state.summary = summary;
      await writeFile(state.resultPath, summary, "utf8");
    }
    state.exitCode = extractExitCode(payload);
    state.error = extractError(payload);
    state.status = extractStatus(payload);
    if (state.status !== "running") state.finishedAt = new Date().toISOString();
  }

  #runSnapshot(state: OpenClawRunState): AdapterRun {
    return {
      id: state.id,
      taskId: state.taskId,
      agent: this.kind,
      role: state.role,
      status: "running",
      startedAt: state.startedAt,
      pid: null,
      workingDirectory: state.workingDirectory,
      stdoutPath: state.stdoutPath,
      stderrPath: state.stderrPath,
      resultPath: state.resultPath,
    };
  }

  #resultSnapshot(state: OpenClawRunState): AdapterResult {
    if (state.status === "running" || !state.finishedAt) {
      throw new Error(`OpenClaw run ${state.id} is still running`);
    }
    return {
      id: state.id,
      taskId: state.taskId,
      agent: this.kind,
      role: state.role,
      status: state.status,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      pid: null,
      workingDirectory: state.workingDirectory,
      stdoutPath: state.stdoutPath,
      stderrPath: state.stderrPath,
      resultPath: state.resultPath,
      exitCode: state.exitCode,
      signal: null,
      summary: state.summary,
      error: state.error,
    };
  }

  #get(runId: string): OpenClawRunState {
    const state = this.#runs.get(runId);
    if (!state) throw new AdapterRunNotFoundError(runId);
    return state;
  }
}
