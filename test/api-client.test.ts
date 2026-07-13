import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiClient,
  ApiError,
  type ApiFetch,
} from "../src/api-client.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

test("GET methods build encoded /v1 URLs without putting the token in them", async () => {
  const token = "daemon-top-secret";
  const captured: CapturedRequest[] = [];
  const fetch: ApiFetch = async (input, init = {}) => {
    captured.push({ url: input.toString(), init });
    return jsonResponse({ call: captured.length });
  };
  const client = new ApiClient({
    baseUrl: "http://127.0.0.1:47821/control/",
    bearerToken: token,
    fetch,
  });

  const health = await client.health<{ call: number }>();
  await client.agents();
  await client.listTasks({
    status: ["queued", "running"],
    limit: 25,
    includeDone: false,
    omitted: undefined,
    alsoOmitted: null,
  });
  await client.getTask("task/with spaces");

  assert.equal(health.data.call, 1);
  assert.equal(health.status, 200);
  assert.deepEqual(
    captured.map(({ url }) => new URL(url).pathname),
    [
      "/control/v1/health",
      "/control/v1/agents",
      "/control/v1/tasks",
      "/control/v1/tasks/task%2Fwith%20spaces",
    ],
  );
  const listUrl = new URL(captured[2]!.url);
  assert.deepEqual(listUrl.searchParams.getAll("status"), ["queued", "running"]);
  assert.equal(listUrl.searchParams.get("limit"), "25");
  assert.equal(listUrl.searchParams.get("includeDone"), "false");
  assert.equal(listUrl.searchParams.has("omitted"), false);

  for (const request of captured) {
    const headers = new Headers(request.init.headers);
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.redirect, "error");
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.has("idempotency-key"), false);
    assert.equal(headers.has("content-type"), false);
    assert.equal(request.url.includes(token), false);
  }
});

test("mutating methods send JSON and idempotency headers and expose replay metadata", async () => {
  const token = "local-daemon-token";
  const captured: CapturedRequest[] = [];
  const fetch: ApiFetch = async (input, init = {}) => {
    captured.push({ url: input.toString(), init });
    const sequence = captured.length;
    const responseInit: ResponseInit = {
      status: sequence === 1 ? 201 : 200,
    };
    if (sequence === 1) {
      responseInit.headers = {
        "Idempotency-Replayed": "true",
        "X-Request-Id": "request_create_1",
      };
    }
    return jsonResponse({ sequence }, responseInit);
  };
  const client = new ApiClient({
    baseUrl: "http://localhost:47821",
    bearerToken: token,
    fetch,
  });

  const created = await client.createTask({ goal: "Fix login" }, "create-1");
  await client.retryTask("task/a", { reason: "review feedback" }, "retry-1");
  await client.cancelTask("task/a", "cancel-task-1");
  await client.postRunMessage("run/a", { body: "Please continue" }, "message-1");
  await client.cancelRun("run/a", "cancel-run-1");
  await client.decideReview("review/a", { decision: "approve" }, "review-1");
  await client.attachScreenshot(
    "task/a",
    "run/a",
    {
      name: "login.png",
      contentType: "image/png",
      dataBase64: "iVBORw0KGgo=",
    },
    "screenshot-1",
  );

  assert.equal(created.status, 201);
  assert.equal(created.replayed, true);
  assert.equal(created.requestId, "request_create_1");
  assert.deepEqual(
    captured.map(({ url }) => new URL(url).pathname),
    [
      "/v1/tasks",
      "/v1/tasks/task%2Fa/retry",
      "/v1/tasks/task%2Fa/cancel",
      "/v1/runs/run%2Fa/messages",
      "/v1/runs/run%2Fa/cancel",
      "/v1/reviews/review%2Fa/decision",
      "/v1/tasks/task%2Fa/runs/run%2Fa/screenshots",
    ],
  );
  assert.deepEqual(
    captured.map(({ init }) => new Headers(init.headers).get("idempotency-key")),
    [
      "create-1",
      "retry-1",
      "cancel-task-1",
      "message-1",
      "cancel-run-1",
      "review-1",
      "screenshot-1",
    ],
  );
  assert.deepEqual(JSON.parse(String(captured[0]!.init.body)), {
    goal: "Fix login",
  });
  assert.equal(captured[2]!.init.body, undefined);
  assert.deepEqual(JSON.parse(String(captured[6]!.init.body)), {
    name: "login.png",
    contentType: "image/png",
    dataBase64: "iVBORw0KGgo=",
  });
  for (const { url, init } of captured) {
    const headers = new Headers(init.headers);
    assert.equal(init.method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(url.includes(token), false);
    if (init.body !== undefined) {
      assert.equal(headers.get("content-type"), "application/json");
    }
  }
});

test("mutating methods reject empty idempotency keys before fetching", async () => {
  let fetchCount = 0;
  const client = new ApiClient({
    baseUrl: "http://localhost:47821",
    bearerToken: "private-token",
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse({ ok: true });
    },
  });

  await assert.rejects(
    client.createTask({}, "   "),
    /Idempotency key must be nonempty/,
  );
  await assert.rejects(
    client.cancelTask("task_1", " key-with-padding "),
    /must not have surrounding whitespace/,
  );
  await assert.rejects(
    client.attachScreenshot(
      "task_1",
      "run_1",
      { name: "a.png", contentType: "image/png", dataBase64: "AA==" },
      "",
    ),
    /Idempotency key must be nonempty/,
  );
  assert.equal(fetchCount, 0);
});

test("ApiError parses structured replay errors and redacts the bearer token", async () => {
  const token = "never-leak-this-token";
  const client = new ApiClient({
    baseUrl: "http://localhost:47821",
    bearerToken: token,
    fetch: async () =>
      jsonResponse(
        {
          error: {
            code: "idempotency_conflict",
            message: `Conflict involving ${token}`,
            details: {
              authorization: `Bearer ${token}`,
              nested: [`value:${token}`],
            },
          },
        },
        {
          status: 409,
          headers: {
            "X-Idempotency-Replayed": "replayed",
            "X-Request-Id": `request-${token}`,
          },
        },
      ),
  });

  await assert.rejects(client.createTask({}, "create-1"), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "idempotency_conflict");
    assert.equal(error.replayed, true);
    assert.equal(error.requestId, "request-[REDACTED]");
    assert.match(error.message, /\[REDACTED\]/);
    assert.deepEqual(error.details, {
      authorization: "Bearer [REDACTED]",
      nested: ["value:[REDACTED]"],
    });
    assert.equal(error.method, "POST");
    assert.equal(error.path, "/v1/tasks");
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
});

test("network failures are wrapped without retaining the original secret-bearing error", async () => {
  const token = "network-secret-token";
  const client = new ApiClient({
    baseUrl: "http://localhost:47821",
    bearerToken: token,
    fetch: async () => {
      throw new Error(`socket error; Authorization: Bearer ${token}`);
    },
  });

  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, null);
    assert.equal(error.code, "network_error");
    assert.equal(error.path, "/v1/health");
    assert.equal(JSON.stringify(error).includes(token), false);
    return true;
  });
});

test("successful responses unwrap daemon data and redact secret-bearing request IDs", async () => {
  const token = "success-secret-token";
  const client = new ApiClient({
    baseUrl: "http://localhost:47821",
    bearerToken: token,
    fetch: async () =>
      jsonResponse(
        { data: { status: "ready" }, requestId: "body-request" },
        { headers: { "X-Request-Id": `request-${token}` } },
      ),
  });

  const response = await client.health<{ status: string }>();
  assert.deepEqual(response.data, { status: "ready" });
  assert.equal(response.requestId, "request-[REDACTED]");
  assert.equal(JSON.stringify(response).includes(token), false);
});

test("artifact content is authenticated, size-limited, and returned as bytes", async () => {
  const token = "artifact-secret-token";
  const captured: CapturedRequest[] = [];
  const client = new ApiClient({
    baseUrl: "http://localhost:47821/control/",
    bearerToken: token,
    fetch: async (input, init = {}) => {
      captured.push({ url: input.toString(), init });
      return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "4",
          ETag: '"sha256-value"',
          "X-Request-Id": "artifact-request",
        },
      });
    },
  });

  const content = await client.getArtifactContent("artifact/one", 4);
  assert.deepEqual([...content.data], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(content.contentType, "image/png");
  assert.equal(content.sizeBytes, 4);
  assert.equal(content.etag, '"sha256-value"');
  assert.equal(content.requestId, "artifact-request");
  assert.equal(
    new URL(captured[0]!.url).pathname,
    "/control/v1/artifacts/artifact%2Fone/content",
  );
  const headers = new Headers(captured[0]!.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.equal(headers.get("accept"), "*/*");

  const oversized = new ApiClient({
    baseUrl: "http://localhost:47821",
    bearerToken: token,
    fetch: async () =>
      new Response("not read", {
        headers: { "Content-Length": "8", "Content-Type": "text/plain" },
      }),
  });
  await assert.rejects(
    oversized.getArtifactContent("artifact_big", 4),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "artifact_too_large");
      assert.equal(JSON.stringify(error).includes(token), false);
      return true;
    },
  );
});
