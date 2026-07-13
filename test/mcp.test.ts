import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ApiClient, type ApiFetch } from "../src/api-client.js";
import { startControlCenterDaemon } from "../src/daemon.js";
import { createAgentControlCenterMcpServer } from "../src/mcp.js";
import { createRuntime } from "../src/runtime.js";

const TOKEN = "mcp-daemon-secret";

interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

function daemonJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-Request-Id", "daemon_request_1");
  return new Response(JSON.stringify({ data }), { ...init, headers });
}

type ClientToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textFromTool(result: ClientToolResult): string {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected immediate MCP tool result");
  }
  const block: unknown = result.content[0];
  if (
    !block ||
    typeof block !== "object" ||
    !("type" in block) ||
    block.type !== "text" ||
    !("text" in block) ||
    typeof block.text !== "string"
  ) {
    throw new Error("Expected text MCP content");
  }
  return block.text;
}

function parsedTool(result: ClientToolResult): Record<string, unknown> {
  return JSON.parse(textFromTool(result)) as Record<string, unknown>;
}

async function connectMcp(fetch: ApiFetch, maxArtifactBytes?: number) {
  const apiClient = new ApiClient({
    baseUrl: "http://127.0.0.1:4317",
    bearerToken: TOKEN,
    fetch,
  });
  const server = createAgentControlCenterMcpServer({
    client: apiClient,
    idempotencyKeyFactory: (toolName) => `mcp:${toolName}:generated`,
    ...(maxArtifactBytes ? { maxArtifactBytes } : {}),
  });
  const client = new Client({ name: "acc-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    async close() {
      await client.close();
      if (server.isConnected()) await server.close();
    },
  };
}

test("MCP exposes the focused control-plane tool surface and read operations", async () => {
  const captured: CapturedRequest[] = [];
  const fetch: ApiFetch = async (input, init = {}) => {
    const url = new URL(input.toString());
    captured.push({ url, init });
    if (url.pathname === "/v1/agents") {
      return daemonJson({ agents: [{ agent: "codex", available: true }] });
    }
    if (url.pathname === "/v1/tasks" && url.searchParams.has("status")) {
      return daemonJson({ tasks: [{ id: "task_1", status: "queued" }] });
    }
    if (url.pathname === "/v1/tasks/task_1") {
      return daemonJson({ task: { id: "task_1" }, artifacts: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const harness = await connectMcp(fetch);
  try {
    const tools = await harness.client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "acc_create_task",
        "acc_decide_review",
        "acc_get_agents",
        "acc_get_task",
        "acc_list_tasks",
        "acc_post_run_message",
        "acc_request_cancel",
        "acc_retry_task",
      ],
    );
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("acc_get_task")?.annotations?.readOnlyHint, true);
    assert.equal(
      byName.get("acc_request_cancel")?.annotations?.destructiveHint,
      true,
    );

    const agents = await harness.client.callTool({
      name: "acc_get_agents",
      arguments: {},
    });
    const listed = await harness.client.callTool({
      name: "acc_list_tasks",
      arguments: { status: "queued" },
    });
    const task = await harness.client.callTool({
      name: "acc_get_task",
      arguments: { taskId: "task_1" },
    });
    assert.deepEqual(parsedTool(agents).data, {
      agents: [{ agent: "codex", available: true }],
    });
    assert.deepEqual(parsedTool(listed).data, {
      tasks: [{ id: "task_1", status: "queued" }],
    });
    assert.deepEqual(parsedTool(task).data, {
      task: { id: "task_1" },
      artifacts: [],
    });
    assert.deepEqual(
      captured.map(({ url }) => `${url.pathname}${url.search}`),
      ["/v1/agents", "/v1/tasks?status=queued", "/v1/tasks/task_1"],
    );
    for (const request of captured) {
      assert.equal(
        new Headers(request.init.headers).get("authorization"),
        `Bearer ${TOKEN}`,
      );
      assert.equal(request.url.href.includes(TOKEN), false);
    }
  } finally {
    await harness.close();
  }
});

test("MCP mutations preserve supplied keys, generate missing keys, and use exact control routes", async () => {
  const captured: CapturedRequest[] = [];
  const fetch: ApiFetch = async (input, init = {}) => {
    captured.push({ url: new URL(input.toString()), init });
    return daemonJson(
      { accepted: true, sequence: captured.length },
      { status: captured.length === 1 ? 201 : 200 },
    );
  };
  const harness = await connectMcp(fetch);
  try {
    await harness.client.callTool({
      name: "acc_create_task",
      arguments: {
        id: "task_1",
        goal: "Fix login",
        repo: "/tmp/repo",
        successCriteria: ["tests pass"],
        handoffRequired: true,
      },
    });
    await harness.client.callTool({
      name: "acc_post_run_message",
      arguments: {
        runId: "run_1",
        body: "Continue with the verifier",
        idempotencyKey: "operator:message:1",
      },
    });
    await harness.client.callTool({
      name: "acc_request_cancel",
      arguments: { taskId: "task_1" },
    });
    await harness.client.callTool({
      name: "acc_request_cancel",
      arguments: { runId: "run_1" },
    });
    await harness.client.callTool({
      name: "acc_decide_review",
      arguments: {
        reviewId: "review_1",
        decision: "rework_requested",
        expectedUpdatedAt: "2026-07-09T10:00:00.000Z",
        note: "Add a regression test",
      },
    });
    await harness.client.callTool({
      name: "acc_retry_task",
      arguments: {
        taskId: "task_1",
        note: "Regression test added",
        allowUnconfirmedRemote: false,
      },
    });

    assert.deepEqual(
      captured.map(({ url }) => url.pathname),
      [
        "/v1/tasks",
        "/v1/runs/run_1/messages",
        "/v1/tasks/task_1/cancel",
        "/v1/runs/run_1/cancel",
        "/v1/reviews/review_1/decision",
        "/v1/tasks/task_1/retry",
      ],
    );
    assert.deepEqual(
      captured.map(({ init }) =>
        new Headers(init.headers).get("idempotency-key"),
      ),
      [
        "mcp:acc_create_task:generated",
        "operator:message:1",
        "mcp:acc_request_cancel:generated",
        "mcp:acc_request_cancel:generated",
        "mcp:acc_decide_review:generated",
        "mcp:acc_retry_task:generated",
      ],
    );
    assert.deepEqual(JSON.parse(String(captured[0]!.init.body)), {
      id: "task_1",
      goal: "Fix login",
      repo: "/tmp/repo",
      baseRef: "HEAD",
      agent: "auto",
      priority: "normal",
      successCriteria: ["tests pass"],
      handoffRequired: true,
    });
    assert.deepEqual(JSON.parse(String(captured[4]!.init.body)), {
      decision: "rework_requested",
      expectedUpdatedAt: "2026-07-09T10:00:00.000Z",
      note: "Add a regression test",
    });

    const requestCount = captured.length;
    const invalidCancel = await harness.client.callTool({
      name: "acc_request_cancel",
      arguments: { taskId: "task_1", runId: "run_1" },
    });
    assert.equal("isError" in invalidCancel && invalidCancel.isError, true);
    assert.match(textFromTool(invalidCancel), /exactly one/u);
    const invalidRework = await harness.client.callTool({
      name: "acc_decide_review",
      arguments: {
        reviewId: "review_1",
        decision: "rework_requested",
        expectedUpdatedAt: "2026-07-09T10:00:00.000Z",
      },
    });
    assert.equal("isError" in invalidRework && invalidRework.isError, true);
    assert.equal(captured.length, requestCount);
  } finally {
    await harness.close();
  }
});

test("MCP daemon errors are structured and never leak the bearer token", async () => {
  const fetch: ApiFetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "state_conflict",
          message: `Conflict involving ${TOKEN}`,
          details: { authorization: `Bearer ${TOKEN}` },
        },
      }),
      {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": `request-${TOKEN}`,
        },
      },
    );
  const harness = await connectMcp(fetch);
  try {
    const result = await harness.client.callTool({
      name: "acc_create_task",
      arguments: { goal: "Fix login", repo: "/tmp/repo" },
    });
    assert.equal("isError" in result && result.isError, true);
    const text = textFromTool(result);
    assert.equal(text.includes(TOKEN), false);
    assert.match(text, /state_conflict/u);
    assert.match(text, /\[REDACTED\]/u);
  } finally {
    await harness.close();
  }
});

test("MCP artifact resource serves verified text and binary content through the API", async () => {
  const captured: CapturedRequest[] = [];
  const fetch: ApiFetch = async (input, init = {}) => {
    const url = new URL(input.toString());
    captured.push({ url, init });
    if (url.pathname.endsWith("/artifact_text/content")) {
      return new Response("test log passed\n", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": "16",
          ETag: '"text-sha"',
        },
      });
    }
    if (url.pathname.endsWith("/artifact_image/content")) {
      return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "4",
          ETag: '"image-sha"',
        },
      });
    }
    throw new Error(`Unexpected artifact: ${url}`);
  };
  const harness = await connectMcp(fetch);
  try {
    const templates = await harness.client.listResourceTemplates();
    assert.equal(templates.resourceTemplates.length, 1);
    assert.equal(
      templates.resourceTemplates[0]?.uriTemplate,
      "acc://artifacts/{artifactId}",
    );

    const textResource = await harness.client.readResource({
      uri: "acc://artifacts/artifact_text",
    });
    assert.deepEqual(textResource.contents[0], {
      uri: "acc://artifacts/artifact_text",
      text: "test log passed\n",
      mimeType: "text/plain; charset=utf-8",
      _meta: {
        etag: '"text-sha"',
        sizeBytes: 16,
        requestId: null,
      },
    });

    const binaryResource = await harness.client.readResource({
      uri: "acc://artifacts/artifact_image",
    });
    assert.deepEqual(binaryResource.contents[0], {
      uri: "acc://artifacts/artifact_image",
      blob: "iVBORw==",
      mimeType: "image/png",
      _meta: {
        etag: '"image-sha"',
        sizeBytes: 4,
        requestId: null,
      },
    });
    assert.equal(captured.length, 2);
    assert.ok(
      captured.every(
        ({ init }) =>
          new Headers(init.headers).get("authorization") ===
          `Bearer ${TOKEN}`,
      ),
    );
  } finally {
    await harness.close();
  }
});

test("MCP artifact resource enforces its response byte limit", async () => {
  const fetch: ApiFetch = async () =>
    new Response("0123456789", {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "10",
      },
    });
  const harness = await connectMcp(fetch, 4);
  try {
    await assert.rejects(
      harness.client.readResource({ uri: "acc://artifacts/artifact_big" }),
      /exceeds the 4 byte MCP limit/u,
    );
  } finally {
    await harness.close();
  }
});

test("acc mcp speaks clean stdio protocol with no startup output", async () => {
  const home = await mkdtemp(join(tmpdir(), "acc-mcp-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "mcp"],
    cwd: process.cwd(),
    env: {
      ACC_HOME: home,
      ACC_DAEMON_URL: "http://127.0.0.1:4317",
      ACC_DAEMON_TOKEN: "s".repeat(43),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "acc-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.equal(stderr, "");
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP creates and reads a task through a real authenticated daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "acc-mcp-daemon-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--initial-branch=main", repo], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repo, "config", "user.name", "ACC MCP Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "mcp@example.com"]);
  execFileSync(
    "git",
    ["-C", repo, "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "initial"],
    { stdio: "ignore" },
  );

  const runtime = await createRuntime({ cwd: root, workerId: "mcp-test" });
  const daemon = await startControlCenterDaemon({
    runtime,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    enableWorker: false,
    logger: { info: () => undefined, error: () => undefined },
  });
  const apiClient = new ApiClient({
    baseUrl: daemon.url,
    bearerToken: daemon.token,
  });
  const server = createAgentControlCenterMcpServer({ client: apiClient });
  const mcpClient = new Client({ name: "acc-real-daemon-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    const created = parsedTool(
      await mcpClient.callTool({
        name: "acc_create_task",
        arguments: {
          id: "task_mcp_real",
          goal: "Prove the MCP control path",
          repo,
          agent: "codex",
          handoffRequired: false,
          idempotencyKey: "mcp:real:create:1",
        },
      }),
    );
    const createdData = created.data as {
      task: { id: string; status: string };
    };
    assert.equal(createdData.task.id, "task_mcp_real");
    assert.equal(createdData.task.status, "queued");

    const listed = parsedTool(
      await mcpClient.callTool({ name: "acc_list_tasks", arguments: {} }),
    );
    const listedData = listed.data as { tasks: Array<{ id: string }> };
    assert.deepEqual(listedData.tasks.map((task) => task.id), ["task_mcp_real"]);

    const detail = parsedTool(
      await mcpClient.callTool({
        name: "acc_get_task",
        arguments: { taskId: "task_mcp_real" },
      }),
    );
    assert.equal(
      (detail.data as { task: { id: string } }).task.id,
      "task_mcp_real",
    );
  } finally {
    await mcpClient.close().catch(() => undefined);
    if (server.isConnected()) await server.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
