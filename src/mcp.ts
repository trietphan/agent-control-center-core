import { createHash, randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolResult,
  ReadResourceResult,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ApiClient,
  ApiError,
  type ApiResponse,
  type ArtifactContentResponse,
} from "./api-client.js";
import { loadConfig } from "./config.js";
import {
  loadBearerTokenFile,
  loadOrCreateBearerToken,
} from "./daemon-lease.js";
import {
  TaskPayloadSchema,
  TaskStatusSchema,
} from "./protocol.js";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:4317";
const DEFAULT_MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

const EntityIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const OptionalIdempotencySchema = z.object({
  idempotencyKey: IdempotencyKeySchema.optional(),
});
const EmptyInputSchema = z.object({}).strict();
const CreateTaskInputSchema = TaskPayloadSchema.extend({
  idempotencyKey: IdempotencyKeySchema.optional(),
}).strict();
const ListTasksInputSchema = z
  .object({ status: TaskStatusSchema.optional() })
  .strict();
const GetTaskInputSchema = z.object({ taskId: EntityIdSchema }).strict();
const PostRunMessageInputSchema = OptionalIdempotencySchema.extend({
  runId: EntityIdSchema,
  body: z.string().trim().min(1).max(100_000),
}).strict();
const CancelInputSchema = OptionalIdempotencySchema.extend({
  taskId: EntityIdSchema.optional(),
  runId: EntityIdSchema.optional(),
})
  .strict()
  .superRefine((value, context) => {
    if (Number(Boolean(value.taskId)) + Number(Boolean(value.runId)) !== 1) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of taskId or runId",
      });
    }
  });
const ReviewDecisionInputSchema = OptionalIdempotencySchema.extend({
  reviewId: EntityIdSchema,
  decision: z.enum(["approved", "rework_requested"]),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(20_000).optional(),
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
const RetryTaskInputSchema = OptionalIdempotencySchema.extend({
  taskId: EntityIdSchema,
  note: z.string().trim().min(1).max(20_000).optional(),
  allowUnconfirmedRemote: z.boolean().default(false),
}).strict();

export interface CreateAccMcpServerOptions {
  client: ControlApiClient;
  idempotencyKeyFactory?: (toolName: string, requestId: RequestId) => string;
  maxArtifactBytes?: number;
}

/** Structural client boundary for local, hosted, or test control APIs. */
export interface ControlApiClient {
  agents<T = unknown>(): Promise<ApiResponse<T>>;
  listTasks<T = unknown>(query?: Record<string, string | number | boolean | readonly (string | number | boolean)[] | null | undefined>): Promise<ApiResponse<T>>;
  getTask<T = unknown>(taskId: string): Promise<ApiResponse<T>>;
  createTask<T = unknown>(payload: unknown, idempotencyKey: string): Promise<ApiResponse<T>>;
  retryTask<T = unknown>(taskId: string, body: unknown, idempotencyKey: string): Promise<ApiResponse<T>>;
  cancelTask<T = unknown>(taskId: string, idempotencyKey: string): Promise<ApiResponse<T>>;
  postRunMessage<T = unknown>(runId: string, body: unknown, idempotencyKey: string): Promise<ApiResponse<T>>;
  cancelRun<T = unknown>(runId: string, idempotencyKey: string): Promise<ApiResponse<T>>;
  decideReview<T = unknown>(reviewId: string, body: unknown, idempotencyKey: string): Promise<ApiResponse<T>>;
  getArtifactContent(artifactId: string, maxBytes?: number): Promise<ArtifactContentResponse>;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function successResult(response: ApiResponse<unknown>): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: jsonText({
          ok: true,
          status: response.status,
          replayed: response.replayed,
          requestId: response.requestId,
          data: response.data,
        }),
      },
    ],
  };
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError) return error.toJSON();
  if (error instanceof Error) {
    return {
      name: error.name,
      code: "mcp_bridge_error",
      message: error.message,
    };
  }
  return {
    name: "Error",
    code: "mcp_bridge_error",
    message: "Unknown MCP bridge error",
  };
}

async function callDaemon(
  operation: () => Promise<ApiResponse<unknown>>,
): Promise<CallToolResult> {
  try {
    return successResult(await operation());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: jsonText({ ok: false, error: safeError(error) }),
        },
      ],
    };
  }
}

function defaultIdempotencyKeyFactory(): (
  toolName: string,
  requestId: RequestId,
) => string {
  const instance = randomUUID().replaceAll("-", "").slice(0, 16);
  return (toolName, requestId) => {
    const requestHash = createHash("sha256")
      .update(String(requestId), "utf8")
      .digest("hex")
      .slice(0, 24);
    return `mcp:${toolName}:${instance}:${requestHash}`;
  };
}

function asTextArtifact(contentType: string, bytes: Uint8Array): string | null {
  const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    !mimeType.startsWith("text/") &&
    mimeType !== "application/json" &&
    !mimeType.endsWith("+json") &&
    mimeType !== "application/xml" &&
    !mimeType.endsWith("+xml")
  ) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function artifactResource(
  uri: URL,
  response: ArtifactContentResponse,
): ReadResourceResult {
  const metadata = {
    etag: response.etag,
    sizeBytes: response.sizeBytes,
    requestId: response.requestId,
  };
  const text = asTextArtifact(response.contentType, response.data);
  return {
    contents: [
      text === null
        ? {
            uri: uri.href,
            blob: Buffer.from(response.data).toString("base64"),
            mimeType: response.contentType,
            _meta: metadata,
          }
        : {
            uri: uri.href,
            text,
            mimeType: response.contentType,
            _meta: metadata,
          },
    ],
  };
}

/**
 * Expose the control plane over MCP without bypassing daemon authentication,
 * validation, idempotency, or its single worker/DB ownership model.
 */
export function createAgentControlCenterMcpServer(
  options: CreateAccMcpServerOptions,
): McpServer {
  const client = options.client;
  const idempotencyKey =
    options.idempotencyKeyFactory ?? defaultIdempotencyKeyFactory();
  const maxArtifactBytes =
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
    throw new TypeError("MCP artifact byte limit must be a positive safe integer");
  }

  const server = new McpServer(
    { name: "agent-control-center", version: "0.1.0" },
    {
      instructions:
        "Use Agent Control Center tools to create, inspect, message, cancel, retry, and review durable agent tasks. These are control-plane operations, not a chat interface.",
    },
  );
  const mutationKey = (
    toolName: string,
    supplied: string | undefined,
    requestId: RequestId,
  ): string => supplied ?? idempotencyKey(toolName, requestId);

  server.registerTool(
    "acc_create_task",
    {
      title: "Create Agent Task",
      description:
        "Create a durable task and let the Agent Control Center router choose or honor the requested agent route.",
      inputSchema: CreateTaskInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ idempotencyKey: supplied, ...payload }, extra) =>
      await callDaemon(() =>
        client.createTask(
          payload,
          mutationKey("acc_create_task", supplied, extra.requestId),
        ),
      ),
  );

  server.registerTool(
    "acc_list_tasks",
    {
      title: "List Agent Tasks",
      description:
        "List task-board rows, optionally filtered by durable task status.",
      inputSchema: ListTasksInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status }) =>
      await callDaemon(() =>
        client.listTasks(status ? { status } : {}),
      ),
  );

  server.registerTool(
    "acc_get_task",
    {
      title: "Inspect Agent Task",
      description:
        "Read one task's route, runs, timeline, evidence metadata, messages, and reviews.",
      inputSchema: GetTaskInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId }) => await callDaemon(() => client.getTask(taskId)),
  );

  server.registerTool(
    "acc_get_agents",
    {
      title: "Inspect Agent Adapters",
      description:
        "Read live availability and capabilities for Codex, Claude, and OpenClaw adapters.",
      inputSchema: EmptyInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => await callDaemon(() => client.agents()),
  );

  server.registerTool(
    "acc_post_run_message",
    {
      title: "Message Active Run",
      description:
        "Post an operator message to a specific active run when its adapter supports live messages.",
      inputSchema: PostRunMessageInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ runId, body, idempotencyKey: supplied }, extra) =>
      await callDaemon(() =>
        client.postRunMessage(
          runId,
          { body },
          mutationKey("acc_post_run_message", supplied, extra.requestId),
        ),
      ),
  );

  server.registerTool(
    "acc_request_cancel",
    {
      title: "Cancel Task or Run",
      description:
        "Request cancellation of exactly one task or run through the coordinator.",
      inputSchema: CancelInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, runId, idempotencyKey: supplied }, extra) =>
      await callDaemon(() => {
        const key = mutationKey(
          "acc_request_cancel",
          supplied,
          extra.requestId,
        );
        return taskId
          ? client.cancelTask(taskId, key)
          : client.cancelRun(runId!, key);
      }),
  );

  server.registerTool(
    "acc_decide_review",
    {
      title: "Decide Exact Review",
      description:
        "Approve or request rework for an exact pending review using its updatedAt value as a compare-and-swap guard.",
      inputSchema: ReviewDecisionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (
      {
        reviewId,
        decision,
        expectedUpdatedAt,
        note,
        idempotencyKey: supplied,
      },
      extra,
    ) =>
      await callDaemon(() =>
        client.decideReview(
          reviewId,
          {
            decision,
            expectedUpdatedAt,
            ...(note ? { note } : {}),
          },
          mutationKey("acc_decide_review", supplied, extra.requestId),
        ),
      ),
  );

  server.registerTool(
    "acc_retry_task",
    {
      title: "Retry Agent Task",
      description:
        "Requeue a blocked or review task after an operator has addressed its blocker.",
      inputSchema: RetryTaskInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (
      { taskId, note, allowUnconfirmedRemote, idempotencyKey: supplied },
      extra,
    ) =>
      await callDaemon(() =>
        client.retryTask(
          taskId,
          {
            allowUnconfirmedRemote,
            ...(note ? { note } : {}),
          },
          mutationKey("acc_retry_task", supplied, extra.requestId),
        ),
      ),
  );

  server.registerResource(
    "acc-artifact",
    new ResourceTemplate("acc://artifacts/{artifactId}", { list: undefined }),
    {
      title: "Agent Control Center artifact",
      description:
        "Integrity-checked task evidence served by the authenticated control-plane API.",
      mimeType: "application/octet-stream",
    },
    async (uri, variables) => {
      const variable = variables.artifactId;
      if (Array.isArray(variable)) {
        throw new Error("Artifact ID must be a single value");
      }
      const artifactId = EntityIdSchema.parse(variable);
      try {
        return artifactResource(
          uri,
          await client.getArtifactContent(artifactId, maxArtifactBytes),
        );
      } catch (error) {
        const safe = safeError(error);
        throw new Error(
          typeof safe.message === "string"
            ? safe.message
            : "Unable to read Agent Control Center artifact",
        );
      }
    },
  );

  return server;
}

export async function createMcpApiClientFromEnvironment(
  cwd = process.cwd(),
): Promise<ApiClient> {
  const config = loadConfig(cwd);
  const daemonUrl = new URL(
    process.env.ACC_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL,
  );
  if (
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      daemonUrl.hostname.toLowerCase(),
    )
  ) {
    throw new Error(
      "ACC_DAEMON_URL must target loopback before the local daemon token can be used",
    );
  }
  const explicitToken = process.env.ACC_DAEMON_TOKEN?.trim();
  const tokenFile = process.env.ACC_DAEMON_TOKEN_FILE?.trim();
  const bearerToken = explicitToken
    ? explicitToken
    : tokenFile
      ? (await loadBearerTokenFile(tokenFile)).token
      : (await loadOrCreateBearerToken(config.homeDir)).token;
  return new ApiClient({
    baseUrl: daemonUrl,
    bearerToken,
  });
}

/** Run a stdio MCP server without ever writing diagnostics to stdout. */
export async function runAgentControlCenterMcpStdio(
  client?: ControlApiClient,
): Promise<void> {
  const resolvedClient = client ?? (await createMcpApiClientFromEnvironment());
  const server = createAgentControlCenterMcpServer({ client: resolvedClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdin.off("end", stop);
      process.stdin.off("error", fail);
    };
    const finish = (error?: unknown) => {
      if (closing) return;
      closing = true;
      void server.close().then(
        () => {
          cleanup();
          if (error) reject(error);
          else resolve();
        },
        (closeError) => {
          cleanup();
          reject(error ?? closeError);
        },
      );
    };
    const stop = () => finish();
    const fail = (error: Error) => finish(error);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stdin.once("end", stop);
    process.stdin.once("error", fail);
  });
}
