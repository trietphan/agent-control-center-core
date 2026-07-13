export type ApiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ApiQueryPrimitive = string | number | boolean;
export type ApiQueryValue =
  | ApiQueryPrimitive
  | readonly ApiQueryPrimitive[]
  | null
  | undefined;
export type TaskListQuery = Readonly<Record<string, ApiQueryValue>>;

export interface ScreenshotAttachment {
  name: string;
  contentType: string;
  dataBase64: string;
}

export interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  replayed: boolean;
  requestId: string | null;
}

export interface ArtifactContentResponse {
  data: Uint8Array;
  status: number;
  contentType: string;
  etag: string | null;
  sizeBytes: number;
  requestId: string | null;
}

export interface ApiClientOptions {
  baseUrl: string | URL;
  bearerToken: string;
  fetch?: ApiFetch;
}

export interface ApiErrorOptions {
  status: number | null;
  code: string;
  details: unknown;
  method: string;
  path: string;
  requestId: string | null;
  replayed: boolean;
}

/** A sanitized daemon error. It deliberately retains no request headers. */
export class ApiError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;
  readonly requestId: string | null;
  readonly replayed: boolean;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.method = options.method;
    this.path = options.path;
    this.requestId = options.requestId;
    this.replayed = options.replayed;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      details: this.details,
      method: this.method,
      path: this.path,
      requestId: this.requestId,
      replayed: this.replayed,
    };
  }
}

interface ParsedBody {
  value: unknown;
  isJson: boolean;
  isEmpty: boolean;
}

interface ErrorDescriptor {
  code: string;
  message: string;
  details: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactString(value: string, token: string): string {
  let redacted = value.includes(token)
    ? value.split(token).join("[REDACTED]")
    : value;
  const encodedToken = encodeURIComponent(token);
  if (encodedToken !== token && redacted.includes(encodedToken)) {
    redacted = redacted.split(encodedToken).join("[REDACTED]");
  }
  return redacted;
}

function sanitizeErrorValue(value: unknown, token: string, depth = 0): unknown {
  if (typeof value === "string") return redactString(value, token);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 20) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorValue(item, token, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactString(key, token),
      sanitizeErrorValue(item, token, depth + 1),
    ]),
  );
}

function parseBody(text: string): ParsedBody {
  if (text.length === 0) {
    return { value: undefined, isJson: false, isEmpty: true };
  }
  try {
    return { value: JSON.parse(text) as unknown, isJson: true, isEmpty: false };
  } catch {
    return { value: text, isJson: false, isEmpty: false };
  }
}

function errorDescriptor(body: unknown, status: number): ErrorDescriptor {
  if (typeof body === "string" && body.trim()) {
    return {
      code: `http_${status}`,
      message: body.trim().slice(0, 1_000),
      details: body,
    };
  }
  if (!isRecord(body)) {
    return {
      code: `http_${status}`,
      message: `Daemon request failed with HTTP ${status}`,
      details: body ?? null,
    };
  }

  const nested = isRecord(body.error) ? body.error : null;
  const codeValue = nested?.code ?? body.code;
  const messageValue =
    nested?.message ??
    body.message ??
    (typeof body.error === "string" ? body.error : undefined);
  const detailsValue = nested?.details ?? body.details ?? body;
  return {
    code:
      typeof codeValue === "string" && codeValue.trim()
        ? codeValue.trim()
        : `http_${status}`,
    message:
      typeof messageValue === "string" && messageValue.trim()
        ? messageValue.trim().slice(0, 1_000)
        : `Daemon request failed with HTTP ${status}`,
    details: detailsValue,
  };
}

function responseWasReplayed(headers: Headers): boolean {
  const value =
    headers.get("idempotency-replayed") ??
    headers.get("x-idempotency-replayed") ??
    headers.get("idempotency-status") ??
    headers.get("x-idempotency-status");
  if (!value) return false;
  return ["1", "true", "replay", "replayed", "hit"].includes(
    value.trim().toLowerCase(),
  );
}

function responseRequestId(headers: Headers): string | null {
  return headers.get("x-request-id") ?? headers.get("request-id");
}

function normalizeBearerToken(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._~+\/-]+={0,}$/.test(value)
  ) {
    throw new TypeError("Bearer token must be a nonempty token without whitespace");
  }
  return value;
}

function normalizeBaseUrl(value: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.toString());
  } catch {
    throw new TypeError("Daemon base URL must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(
      "Daemon base URL must be an HTTP(S) URL without credentials, query, or fragment",
    );
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Idempotency key must be nonempty");
  }
  if (value !== value.trim()) {
    throw new TypeError("Idempotency key must not have surrounding whitespace");
  }
  return value;
}

function routeSegment(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return encodeURIComponent(value.trim());
}

function appendQuery(url: URL, query: TaskListQuery): void {
  for (const [key, value] of Object.entries(query)) {
    if (!key.trim()) throw new TypeError("Query parameter name must be nonempty");
    if (value === null || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new TypeError(`Query parameter ${key} must be finite`);
      }
      url.searchParams.append(key, String(item));
    }
  }
}

export class ApiClient {
  readonly #baseUrl: URL;
  readonly #bearerToken: string;
  readonly #fetch: ApiFetch;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#bearerToken = normalizeBearerToken(options.bearerToken);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async health<T = unknown>(): Promise<ApiResponse<T>> {
    return this.#request<T>("GET", "v1/health");
  }

  async agents<T = unknown>(): Promise<ApiResponse<T>> {
    return this.#request<T>("GET", "v1/agents");
  }

  async listTasks<T = unknown>(
    query: TaskListQuery = {},
  ): Promise<ApiResponse<T>> {
    return this.#request<T>("GET", "v1/tasks", { query });
  }

  async getTask<T = unknown>(taskId: string): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "GET",
      `v1/tasks/${routeSegment(taskId, "Task ID")}`,
    );
  }

  async createTask<T = unknown>(
    payload: unknown,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>("POST", "v1/tasks", {
      body: payload,
      idempotencyKey,
    });
  }

  async retryTask<T = unknown>(
    taskId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "POST",
      `v1/tasks/${routeSegment(taskId, "Task ID")}/retry`,
      { body, idempotencyKey },
    );
  }

  async cancelTask<T = unknown>(
    taskId: string,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "POST",
      `v1/tasks/${routeSegment(taskId, "Task ID")}/cancel`,
      { idempotencyKey },
    );
  }

  async postRunMessage<T = unknown>(
    runId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "POST",
      `v1/runs/${routeSegment(runId, "Run ID")}/messages`,
      { body, idempotencyKey },
    );
  }

  async cancelRun<T = unknown>(
    runId: string,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "POST",
      `v1/runs/${routeSegment(runId, "Run ID")}/cancel`,
      { idempotencyKey },
    );
  }

  async decideReview<T = unknown>(
    reviewId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "POST",
      `v1/reviews/${routeSegment(reviewId, "Review ID")}/decision`,
      { body, idempotencyKey },
    );
  }

  async attachScreenshot<T = unknown>(
    taskId: string,
    runId: string,
    attachment: ScreenshotAttachment,
    idempotencyKey: string,
  ): Promise<ApiResponse<T>> {
    return this.#request<T>(
      "POST",
      `v1/tasks/${routeSegment(taskId, "Task ID")}/runs/${routeSegment(
        runId,
        "Run ID",
      )}/screenshots`,
      { body: attachment, idempotencyKey },
    );
  }

  async getArtifactContent(
    artifactId: string,
    maxBytes = 20 * 1024 * 1024,
  ): Promise<ArtifactContentResponse> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new TypeError("Artifact byte limit must be a positive safe integer");
    }
    const route = `v1/artifacts/${routeSegment(artifactId, "Artifact ID")}/content`;
    const url = new URL(route, this.#baseUrl);
    const encodedToken = encodeURIComponent(this.#bearerToken);
    if (
      url.toString().includes(this.#bearerToken) ||
      url.toString().includes(encodedToken)
    ) {
      throw new TypeError("Request URL must not contain bearer credentials");
    }
    const headers = new Headers({
      Accept: "*/*",
      Authorization: `Bearer ${this.#bearerToken}`,
    });
    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: "GET",
        headers,
        redirect: "error",
      });
    } catch {
      throw new ApiError("Unable to reach the Agent Control Center daemon", {
        status: null,
        code: "network_error",
        details: null,
        method: "GET",
        path: `/${route}`,
        requestId: null,
        replayed: false,
      });
    }

    const rawRequestId = responseRequestId(response.headers);
    const requestId = rawRequestId
      ? redactString(rawRequestId, this.#bearerToken)
      : null;
    if (!response.ok) {
      let responseText = "";
      try {
        responseText = await response.text();
      } catch {
        // Preserve the status even when the error body cannot be read.
      }
      const parsed = parseBody(responseText);
      const descriptor = errorDescriptor(parsed.value, response.status);
      throw new ApiError(
        redactString(descriptor.message, this.#bearerToken),
        {
          status: response.status,
          code: redactString(descriptor.code, this.#bearerToken),
          details: sanitizeErrorValue(descriptor.details, this.#bearerToken),
          method: "GET",
          path: `/${route}`,
          requestId,
          replayed: false,
        },
      );
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^[0-9]+$/u.test(declaredLength)) {
      const size = Number(declaredLength);
      if (!Number.isSafeInteger(size) || size > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ApiError(`Artifact exceeds the ${maxBytes} byte MCP limit`, {
          status: response.status,
          code: "artifact_too_large",
          details: { maxBytes },
          method: "GET",
          path: `/${route}`,
          requestId,
          replayed: false,
        });
      }
    }

    let data: Uint8Array;
    try {
      data = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new ApiError("Unable to read the artifact response", {
        status: response.status,
        code: "response_read_error",
        details: null,
        method: "GET",
        path: `/${route}`,
        requestId,
        replayed: false,
      });
    }
    if (data.byteLength > maxBytes) {
      throw new ApiError(`Artifact exceeds the ${maxBytes} byte MCP limit`, {
        status: response.status,
        code: "artifact_too_large",
        details: { maxBytes },
        method: "GET",
        path: `/${route}`,
        requestId,
        replayed: false,
      });
    }

    return {
      data,
      status: response.status,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      etag: response.headers.get("etag"),
      sizeBytes: data.byteLength,
      requestId,
    };
  }

  async #request<T>(
    method: "GET" | "POST",
    route: string,
    options: {
      body?: unknown;
      idempotencyKey?: string;
      query?: TaskListQuery;
    } = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(route, this.#baseUrl);
    if (options.query) appendQuery(url, options.query);
    const encodedToken = encodeURIComponent(this.#bearerToken);
    if (
      url.toString().includes(this.#bearerToken) ||
      url.toString().includes(encodedToken)
    ) {
      throw new TypeError("Request URL must not contain bearer credentials");
    }

    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.#bearerToken}`,
    });
    if (options.idempotencyKey !== undefined) {
      headers.set(
        "Idempotency-Key",
        normalizeIdempotencyKey(options.idempotencyKey),
      );
    }

    const init: RequestInit = { method, headers, redirect: "error" };
    if (options.body !== undefined) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(options.body);
      } catch {
        throw new TypeError("API request body must be JSON-serializable");
      }
      if (serialized === undefined) {
        throw new TypeError("API request body must be JSON-serializable");
      }
      headers.set("Content-Type", "application/json");
      init.body = serialized;
    }

    const safePath = `/${route.split("?")[0] ?? ""}`;
    let response: Response;
    try {
      response = await this.#fetch(url.toString(), init);
    } catch {
      throw new ApiError("Unable to reach the Agent Control Center daemon", {
        status: null,
        code: "network_error",
        details: null,
        method,
        path: safePath,
        requestId: null,
        replayed: false,
      });
    }

    const requestId = responseRequestId(response.headers);
    const safeRequestId = requestId
      ? redactString(requestId, this.#bearerToken)
      : null;
    const replayed = responseWasReplayed(response.headers);
    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      throw new ApiError("Unable to read the daemon response", {
        status: response.status,
        code: "response_read_error",
        details: null,
        method,
        path: safePath,
        requestId: safeRequestId,
        replayed,
      });
    }
    const parsed = parseBody(responseText);

    if (!response.ok) {
      const descriptor = errorDescriptor(parsed.value, response.status);
      throw new ApiError(
        redactString(descriptor.message, this.#bearerToken),
        {
          status: response.status,
          code: redactString(descriptor.code, this.#bearerToken),
          details: sanitizeErrorValue(
            descriptor.details,
            this.#bearerToken,
          ),
          method,
          path: safePath,
          requestId: safeRequestId,
          replayed,
        },
      );
    }

    if (
      !parsed.isEmpty &&
      !parsed.isJson &&
      response.headers.get("content-type")?.toLowerCase().includes("json")
    ) {
      throw new ApiError("Daemon returned malformed JSON", {
        status: response.status,
        code: "invalid_json_response",
        details: null,
        method,
        path: safePath,
        requestId: safeRequestId,
        replayed,
      });
    }

    return {
      data: (isRecord(parsed.value) &&
      Object.prototype.hasOwnProperty.call(parsed.value, "data")
        ? parsed.value.data
        : parsed.value) as T,
      status: response.status,
      replayed,
      requestId: safeRequestId,
    };
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

export { ApiClient as AgentControlCenterApiClient };
