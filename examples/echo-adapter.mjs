#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const protocol = "acc-adapter/1";
const handlesByKey = new Map();
const runs = new Map();

function respond(requestId, result) {
  process.stdout.write(`${JSON.stringify({ protocol, requestId, ok: true, result })}\n`);
}

function unsupported(requestId, method) {
  process.stdout.write(`${JSON.stringify({
    protocol,
    requestId,
    ok: false,
    error: { code: "UNSUPPORTED", message: `${method} is not supported`, retryable: false },
  })}\n`);
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stderr.write("invalid JSON request\n");
    continue;
  }
  if (request.protocol !== protocol) {
    unsupported(request.requestId ?? "unknown", "protocol");
    continue;
  }
  const { requestId, method, params = {} } = request;
  if (method === "probe") {
    respond(requestId, {
      manifest: {
        protocol,
        adapterId: "example.echo",
        displayName: "Deterministic echo adapter",
        adapterVersion: "0.1.0",
        capabilities: {
          workspaceAccess: "none",
          networkAccess: false,
          secretNames: [],
          sideEffects: "none",
          liveMessages: false,
          cancellation: false,
          reconciliation: true,
        },
      },
    });
    continue;
  }
  if (method === "start") {
    let handleId = handlesByKey.get(params.idempotencyKey);
    if (!handleId) {
      handleId = `echo_${createHash("sha256").update(params.idempotencyKey).digest("hex").slice(0, 16)}`;
      handlesByKey.set(params.idempotencyKey, handleId);
      await mkdir(params.artifactDirectory, { recursive: true });
      const artifact = join(params.artifactDirectory, "echo-result.txt");
      await writeFile(artifact, "deterministic adapter result\n", "utf8");
      runs.set(handleId, {
        handleId,
        status: "succeeded",
        summary: "Echo adapter completed without workspace or network access.",
        artifactPaths: [artifact],
      });
    }
    respond(requestId, { handleId, startedAt: "2026-01-01T00:00:00.000Z" });
    continue;
  }
  if (method === "collect" || method === "reconcile") {
    const result = runs.get(params.handleId);
    if (!result) {
      process.stdout.write(`${JSON.stringify({
        protocol,
        requestId,
        ok: false,
        error: { code: "NOT_FOUND", message: "unknown handle", retryable: false },
      })}\n`);
    } else {
      respond(requestId, result);
    }
    continue;
  }
  if (method === "cleanup") {
    runs.delete(params.handleId);
    respond(requestId, { cleaned: true });
    continue;
  }
  unsupported(requestId, method);
}
