import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  AdapterCapabilityError,
  CONTROL_RUN_TOKEN_ENV,
  ClaudeAdapter,
  CodexAdapter,
  OpenClawAdapter,
  ProcessSupervisor,
  terminateVerifiedProcessGroup,
} from "../src/adapters/index.js";
import type { TaskPayload } from "../src/protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

const fakeCliSource = String.raw`
const fs = require("node:fs");

const mode = process.argv[2];
const args = process.argv.slice(3);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("fake-" + mode + " 1.2.3\n");
  process.exit(0);
}
if (mode === "codex" && args.join(" ") === "login status") {
  process.stdout.write("Logged in using fake credentials\n");
  process.exit(0);
}
if (mode.startsWith("claude") && args.join(" ") === "auth status --json") {
  process.stdout.write(JSON.stringify(
    { loggedIn: mode !== "claude-logged-out" },
    null,
    mode === "claude-pretty" ? 2 : 0,
  ) + "\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (process.env.INVOCATION_PATH) {
    fs.writeFileSync(process.env.INVOCATION_PATH, JSON.stringify({
      args,
      cwd: process.cwd(),
      prompt,
    }));
  }

  if (prompt.includes("WAIT_FOREVER")) {
    process.on("SIGTERM", () => {
      if (process.env.IGNORE_TERM !== "1") process.exit(143);
    });
    process.stdout.write("READY\n");
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === "codex") {
    const outputIndex = args.indexOf("--output-last-message");
    fs.writeFileSync(args[outputIndex + 1], "Codex completed the task.\n");
    process.stdout.write(JSON.stringify({ type: "item.completed" }) + "\n");
    process.stderr.write("codex diagnostic\n");
  } else {
    process.stdout.write(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "intermediate" }] },
    }) + "\n");
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      result: "Claude review passed.",
    }) + "\n");
    process.stderr.write("claude diagnostic\n");
  }
});
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "acc-adapters-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const artifacts = join(root, "artifacts");
  const cli = join(root, "fake-cli.cjs");
  await Promise.all([
    mkdir(repo, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
    writeFile(cli, fakeCliSource, "utf8"),
  ]);
  return { root, repo, artifacts, cli };
}

function task(repo: string): TaskPayload {
  return {
    id: "task_123",
    goal: "Fix login bug",
    repo,
    baseRef: "HEAD",
    agent: "codex",
    priority: "high",
    context: "Keep the authentication contract stable.",
    successCriteria: ["tests pass", "no regression"],
    handoffRequired: true,
  };
}

async function waitForText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) return;
    } catch {
      // The stream may not have created/flushed the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} in ${path}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

test("Codex adapter uses the safe non-interactive argv and captures artifacts", async () => {
  const { root, repo, artifacts, cli } = await fixture();
  const invocationPath = join(root, "codex-invocation.json");
  const adapter = new CodexAdapter({
    command: process.execPath,
    commandArgs: [cli, "codex"],
  });

  const availability = await adapter.availability();
  assert.equal(availability.available, true);
  assert.equal(availability.version, "fake-codex 1.2.3");

  let startReturned = false;
  let durableStartPid: number | null = null;
  const run = await adapter.startTask({
    task: task(repo),
    role: "execute",
    workingDirectory: repo,
    artifactDir: artifacts,
    prompt: "Implement safely; literal $(touch SHOULD_NOT_EXIST)",
    env: { ...process.env, INVOCATION_PATH: invocationPath },
    onStarted: async (started) => {
      assert.equal(startReturned, false);
      durableStartPid = started.pid;
    },
  });
  startReturned = true;
  assert.equal(durableStartPid, run.pid);
  assert.ok(durableStartPid && durableStartPid > 1);
  const result = await adapter.collectResult(run.id);

  assert.equal(result.status, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, "Codex completed the task.");
  assert.equal(result.workingDirectory, repo);
  assert.match(await readFile(result.stdoutPath, "utf8"), /item\.completed/);
  assert.match(await readFile(result.stderrPath, "utf8"), /codex diagnostic/);
  assert.equal(await readFile(result.resultPath, "utf8"), "Codex completed the task.\n");

  const invocation = JSON.parse(
    await readFile(invocationPath, "utf8"),
  ) as { args: string[]; cwd: string; prompt: string };
  assert.deepEqual(invocation.args, [
    "exec",
    "--json",
    "--ephemeral",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--cd",
    repo,
    "--output-last-message",
    result.resultPath,
    "-",
  ]);
  assert.equal(await realpath(invocation.cwd), await realpath(repo));
  assert.equal(invocation.prompt, "Implement safely; literal $(touch SHOULD_NOT_EXIST)");
  await assert.rejects(
    adapter.postMessage(run.id, "follow-up"),
    AdapterCapabilityError,
  );
});

test("CLI adapter stops a spawned process when durable start persistence fails", async () => {
  const { repo, artifacts, cli } = await fixture();
  const adapter = new CodexAdapter({
    command: process.execPath,
    commandArgs: [cli, "codex"],
  });
  let pid: number | null = null;

  await assert.rejects(
    adapter.startTask({
      task: task(repo),
      role: "execute",
      workingDirectory: repo,
      artifactDir: artifacts,
      prompt: "WAIT_FOREVER",
      onStarted: async (started) => {
        pid = started.pid;
        throw new Error("durable start write failed");
      },
    }),
    /durable start write failed/,
  );
  assert.ok(pid && pid > 1);
  assert.equal(await waitForProcessExit(pid), true);
});

test("Codex review is read-only and Claude maps roles to permission modes", async () => {
  const { root, repo, cli } = await fixture();
  const codexInvocation = join(root, "codex-review.json");
  const codex = new CodexAdapter({
    command: process.execPath,
    commandArgs: [cli, "codex"],
  });
  const codexRun = await codex.startTask({
    task: task(repo),
    role: "review",
    workingDirectory: repo,
    artifactDir: join(root, "codex-artifacts"),
    env: { ...process.env, INVOCATION_PATH: codexInvocation },
  });
  await codex.collectResult(codexRun.id);
  const codexArgs = JSON.parse(
    await readFile(codexInvocation, "utf8"),
  ) as { args: string[] };
  assert.equal(codexArgs.args[codexArgs.args.indexOf("--sandbox") + 1], "read-only");

  const claudeInvocation = join(root, "claude-review.json");
  const claude = new ClaudeAdapter({
    command: process.execPath,
    commandArgs: [cli, "claude"],
  });
  const claudeRun = await claude.startTask({
    task: task(repo),
    role: "review",
    workingDirectory: repo,
    artifactDir: join(root, "claude-artifacts"),
    env: { ...process.env, INVOCATION_PATH: claudeInvocation },
  });
  const claudeResult = await claude.collectResult(claudeRun.id);
  const claudeArgs = JSON.parse(
    await readFile(claudeInvocation, "utf8"),
  ) as { args: string[] };

  assert.deepEqual(claudeArgs.args, [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
  ]);
  assert.equal(claudeResult.status, "succeeded");
  assert.equal(claudeResult.summary, "Claude review passed.");
  assert.equal(await readFile(claudeResult.resultPath, "utf8"), "Claude review passed.");
});

test("Claude readiness parses loggedIn instead of trusting exit zero", async () => {
  const { cli } = await fixture();
  const claude = new ClaudeAdapter({
    command: process.execPath,
    commandArgs: [cli, "claude-logged-out"],
  });
  const availability = await claude.availability();
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /not authenticated/);

  const pretty = new ClaudeAdapter({
    command: process.execPath,
    commandArgs: [cli, "claude-pretty"],
  });
  assert.equal((await pretty.availability()).available, true);
});

test("process supervisor escalates from SIGTERM to SIGKILL", async () => {
  const { root, repo, artifacts, cli } = await fixture();
  const adapter = new CodexAdapter({
    command: process.execPath,
    commandArgs: [cli, "codex"],
    supervisor: new ProcessSupervisor({ killGraceMs: 25 }),
  });
  const run = await adapter.startTask({
    task: task(repo),
    workingDirectory: repo,
    artifactDir: artifacts,
    prompt: "WAIT_FOREVER",
    env: { ...process.env, IGNORE_TERM: "1" },
  });
  await waitForText(run.stdoutPath, "READY");

  const result = await adapter.stop(run.id);
  assert.equal(result.status, "stopped");
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGKILL");
});

test("process supervisor fails and terminates a wall-clock timeout", async () => {
  const { root } = await fixture();
  const supervisor = new ProcessSupervisor({
    timeoutMs: 100,
    killGraceMs: 20,
  });
  const run = await supervisor.start({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    stdoutPath: join(root, "timeout.stdout.log"),
    stderrPath: join(root, "timeout.stderr.log"),
  });

  const result = await supervisor.collect(run.id);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /timed out after 100ms/);
  assert.ok(result.signal === "SIGTERM" || result.signal === "SIGKILL");
  assert.equal(processIsAlive(run.pid ?? -1), false);
});

test("process supervisor caps stdout and stderr before terminating the run", async () => {
  const { root } = await fixture();
  const supervisor = new ProcessSupervisor({
    timeoutMs: 2_000,
    killGraceMs: 20,
    maxStdoutBytes: 64,
    maxStderrBytes: 32,
  });
  const stdoutPath = join(root, "limited.stdout.log");
  const stderrPath = join(root, "limited.stderr.log");
  const run = await supervisor.start({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("x".repeat(4096)); process.stderr.write("y".repeat(4096)); setInterval(() => {}, 1000)',
    ],
    cwd: root,
    stdoutPath,
    stderrPath,
  });

  const result = await supervisor.collect(run.id);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /exceeded the maximum/);
  assert.ok((await stat(stdoutPath)).size <= 64);
  assert.ok((await stat(stderrPath)).size <= 32);
  assert.ok(
    (await stat(stdoutPath)).size === 64 || (await stat(stderrPath)).size === 32,
  );
});

test(
  "process supervisor stop terminates POSIX descendants",
  { skip: process.platform === "win32" },
  async () => {
    const { root } = await fixture();
    const supervisor = new ProcessSupervisor({
      timeoutMs: 2_000,
      killGraceMs: 25,
    });
    const stdoutPath = join(root, "tree.stdout.log");
    const parentCode = [
      'const { spawn } = require("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      "process.stdout.write(String(child.pid) + \"\\n\")",
      'process.on("SIGTERM", () => {})',
      "setInterval(() => {}, 1000)",
    ].join("; ");
    const run = await supervisor.start({
      command: process.execPath,
      args: ["-e", parentCode],
      cwd: root,
      stdoutPath,
      stderrPath: join(root, "tree.stderr.log"),
    });
    await waitForText(stdoutPath, "\n");
    const descendantPid = Number((await readFile(stdoutPath, "utf8")).trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

    try {
      const result = await supervisor.stop(run.id);
      assert.equal(result.status, "stopped");
      assert.equal(result.signal, "SIGKILL");
      assert.equal(await waitForProcessExit(descendantPid), true);
    } finally {
      if (processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  },
);

test(
  "process supervisor fails and cleans descendants left after a successful parent exit",
  { skip: process.platform === "win32" },
  async () => {
    const { root } = await fixture();
    const supervisor = new ProcessSupervisor({ killGraceMs: 25 });
    const stdoutPath = join(root, "orphan.stdout.log");
    const parentCode = [
      'const { spawn } = require("node:child_process")',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      "child.unref()",
      'process.stdout.write(String(child.pid) + "\\n")',
    ].join("; ");
    const run = await supervisor.start({
      command: process.execPath,
      args: ["-e", parentCode],
      cwd: root,
      stdoutPath,
      stderrPath: join(root, "orphan.stderr.log"),
    });
    const result = await supervisor.collect(run.id);
    const descendantPid = Number((await readFile(stdoutPath, "utf8")).trim());

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /descendant processes remained alive/);
    assert.equal(await waitForProcessExit(descendantPid), true);
  },
);

test(
  "stale recovery terminates only a process group with the persisted run token",
  { skip: process.platform === "win32" },
  async () => {
    const { root } = await fixture();
    const runId = "run_verified_recovery";
    const supervisor = new ProcessSupervisor();
    const run = await supervisor.start({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000)'],
      cwd: root,
      env: { ...process.env, [CONTROL_RUN_TOKEN_ENV]: runId },
      stdoutPath: join(root, "recovery.stdout.log"),
      stderrPath: join(root, "recovery.stderr.log"),
    });
    await waitForText(run.stdoutPath, "READY");
    const cleanup = await terminateVerifiedProcessGroup({
      runId,
      pid: run.pid!,
      graceMs: 100,
    });
    const result = await supervisor.collect(run.id);

    assert.equal(cleanup.status, "terminated");
    assert.equal(result.status, "failed");
    assert.equal(processIsAlive(run.pid!), false);
  },
);

test("process supervisor surfaces output stream failures", async () => {
  const { root } = await fixture();
  const supervisor = new ProcessSupervisor({
    timeoutMs: 2_000,
    killGraceMs: 20,
  });
  // Opening a directory as a WriteStream deterministically fails with EISDIR.
  const run = await supervisor.start({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
    stdoutPath: root,
    stderrPath: join(root, "stream-error.stderr.log"),
  });

  const result = await supervisor.collect(run.id);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Failed to write stdout artifact/);
});

test("OpenClaw HTTP adapter supports configurable lifecycle endpoints", async () => {
  const { repo, artifacts } = await fixture();
  const calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = [];
  let pollCount = 0;
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    calls.push({
      url,
      method,
      body,
      authorization: headers.get("authorization"),
    });

    let payload: unknown;
    if (url.endsWith("/ready")) payload = { version: "openclaw-test" };
    else if (url.endsWith("/runs") && method === "POST") {
      payload = { runId: "remote_7", status: "running" };
    } else if (url.endsWith("/say")) payload = { accepted: true };
    else if (url.endsWith("/result")) {
      pollCount += 1;
      payload = pollCount === 1
        ? { status: "running" }
        : { status: "done", result: "OpenClaw finished.", exitCode: 0 };
    } else if (url.endsWith("/halt")) payload = { status: "stopped" };
    else return new Response("not found", { status: 404 });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.test/api/",
    token: "secret-token",
    fetch: fakeFetch,
    pollIntervalMs: 0,
    pollTimeoutMs: 1_000,
    endpoints: {
      health: "/ready",
      start: "/runs",
      message: (id) => `/runs/${id}/say`,
      result: (id) => `/runs/${id}/result`,
      stop: (id) => `/runs/${id}/halt`,
    },
  });

  assert.deepEqual(await adapter.availability(), {
    available: true,
    target: "https://openclaw.test/api",
    version: "openclaw-test",
    reason: null,
  });
  const run = await adapter.startTask({
    task: task(repo),
    role: "approval",
    workingDirectory: repo,
    artifactDir: artifacts,
    env: { [CONTROL_RUN_TOKEN_ENV]: "run_db_7" },
  });
  assert.equal(run.id, "remote_7");
  assert.equal(
    (calls[1]?.body as { requestId?: string }).requestId,
    "run_db_7",
  );
  await adapter.postMessage(run.id, "Please summarize this run.");
  const result = await adapter.collectResult(run.id);

  assert.equal(result.status, "succeeded");
  assert.equal(result.summary, "OpenClaw finished.");
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(result.resultPath, "utf8"), "OpenClaw finished.");
  assert.ok(calls.every((call) => call.authorization === "Bearer secret-token"));
  assert.equal(calls[1]?.url, "https://openclaw.test/api/runs");
  assert.equal(calls[2]?.url, "https://openclaw.test/api/runs/remote_7/say");
  assert.deepEqual(calls[2]?.body, { message: "Please summarize this run." });
  assert.equal(pollCount, 2);

  const recoveredAdapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.test/api/",
    token: "secret-token",
    fetch: fakeFetch,
    pollIntervalMs: 0,
    endpoints: {
      health: "/ready",
      start: "/runs",
      message: (id) => `/runs/${id}/say`,
      result: (id) => `/runs/${id}/result`,
      stop: (id) => `/runs/${id}/halt`,
    },
  });
  const durableCancel = await recoveredAdapter.cancelDurable("remote_7");
  assert.equal(durableCancel.status, "stopped");
  assert.ok(calls.at(-1)?.url.endsWith("/runs/remote_7/halt"));
});

test("OpenClaw protects bearer credentials and retries transient polling errors", async () => {
  assert.throws(
    () => new OpenClawAdapter({ baseUrl: "http://remote.example" }),
    /requires HTTPS/,
  );

  const { repo, artifacts } = await fixture();
  let resultPolls = 0;
  const adapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.example",
    token: "secret",
    pollIntervalMs: 0,
    pollTimeoutMs: 1_000,
    maxConsecutivePollErrors: 3,
    endpoints: {
      health: "/health",
      start: "/tasks",
      result: () => "/result",
      message: () => "https://attacker.example/messages",
      stop: () => "/stop",
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/tasks")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.match(String(body.requestId), /^run_/);
        return Response.json({ id: "remote", status: "running" });
      }
      if (url.endsWith("/result")) {
        resultPolls += 1;
        if (resultPolls === 1) throw new Error("temporary network error");
        return Response.json({ status: "done", result: "recovered", exitCode: 0 });
      }
      return Response.json({ ok: true });
    },
  });

  const run = await adapter.startTask({
    task: task(repo),
    workingDirectory: repo,
    artifactDir: artifacts,
  });
  await assert.rejects(
    adapter.postMessage(run.id, "do not leak token"),
    /configured adapter origin/,
  );
  const result = await adapter.collectResult(run.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.summary, "recovered");
  assert.equal(resultPolls, 2);
});

test("OpenClaw polling exhaustion requests and confirms remote cancellation", async () => {
  const { repo, artifacts } = await fixture();
  let resultPolls = 0;
  let stopCalls = 0;
  const adapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.example",
    pollIntervalMs: 0,
    pollTimeoutMs: 1_000,
    stopTimeoutMs: 100,
    maxConsecutivePollErrors: 2,
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/tasks") && method === "POST") {
        return Response.json({ id: "remote-cancel", status: "running" });
      }
      if (url.endsWith("/stop")) {
        stopCalls += 1;
        return Response.json({ status: "running" });
      }
      if (url.endsWith("/tasks/remote-cancel")) {
        resultPolls += 1;
        if (resultPolls <= 2) throw new Error("temporary poll outage");
        return Response.json({ status: "stopped" });
      }
      return Response.json({ ok: true });
    },
  });
  const run = await adapter.startTask({
    task: task(repo),
    workingDirectory: repo,
    artifactDir: artifacts,
  });
  const result = await adapter.collectResult(run.id);

  assert.equal(result.status, "stopped");
  assert.match(result.error ?? "", /polling failed 2 consecutive times/);
  assert.equal(stopCalls, 1);
  assert.equal(resultPolls, 3);
});

test("OpenClaw reports stale when remote cancellation cannot be confirmed", async () => {
  const { repo, artifacts } = await fixture();
  const adapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.example",
    pollIntervalMs: 0,
    stopTimeoutMs: 20,
    maxConsecutivePollErrors: 1,
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/tasks") && method === "POST") {
        return Response.json({ id: "remote-uncertain", status: "running" });
      }
      if (url.endsWith("/stop")) return Response.json({ accepted: true });
      if (url.endsWith("/tasks/remote-uncertain")) {
        throw new Error("bridge unreachable");
      }
      return Response.json({ ok: true });
    },
  });
  const run = await adapter.startTask({
    task: task(repo),
    workingDirectory: repo,
    artifactDir: artifacts,
  });
  const result = await adapter.stop(run.id);

  assert.equal(result.status, "stale");
  assert.match(result.error ?? "", /could not be confirmed/);
});

test("OpenClaw rejects and cancels oversized streaming responses", async () => {
  let cancelled = false;
  const adapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.example",
    maxResponseBytes: 8,
    requestTimeoutMs: 1_000,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from({ length: 9 }, () => 0x61));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  });

  const availability = await adapter.availability();
  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /exceeds 8 bytes/);
  assert.equal(cancelled, true);
});

test("OpenClaw caps cumulative per-run HTTP logs without losing the result", async () => {
  const { repo, artifacts } = await fixture();
  let polls = 0;
  const adapter = new OpenClawAdapter({
    baseUrl: "https://openclaw.example",
    pollIntervalMs: 0,
    pollTimeoutMs: 1_000,
    maxResponseBytes: 256,
    maxRunLogBytes: 128,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/tasks") && init?.method === "POST") {
        return Response.json({ id: "remote-capped", status: "running" });
      }
      if (url.endsWith("/tasks/remote-capped")) {
        polls += 1;
        return polls < 8
          ? Response.json({ status: "running", update: `poll-${polls}` })
          : Response.json({
              status: "done",
              result: "finished despite log truncation",
              exitCode: 0,
            });
      }
      return Response.json({ ok: true });
    },
  });

  const run = await adapter.startTask({
    task: task(repo),
    workingDirectory: repo,
    artifactDir: artifacts,
  });
  const result = await adapter.collectResult(run.id);
  const log = await readFile(result.stdoutPath, "utf8");
  const logInfo = await stat(result.stdoutPath);

  assert.equal(result.status, "succeeded");
  assert.equal(result.summary, "finished despite log truncation");
  assert.equal(logInfo.size, 128);
  assert.match(log, /OpenClaw HTTP log truncated/);
});
