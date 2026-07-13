#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { createRuntime } from "./runtime.js";
import { startControlCenterDaemon } from "./daemon.js";
import { runAgentControlCenterMcpStdio } from "./mcp.js";
import { verifyArtifactEvidence } from "./artifacts.js";
import { loadConfig, parseExtraArgs } from "./config.js";
import {
  AgentSelectionSchema,
  PrioritySchema,
  TaskPayloadSchema,
  TaskStatusSchema,
  taskPayloadJsonSchema,
} from "./protocol.js";

const program = new Command();

program
  .name("acc")
  .description("Agent Control Center — route and audit agent work, not chat sessions")
  .version("0.1.0");

async function withRuntime<T>(
  fn: (runtime: Awaited<ReturnType<typeof createRuntime>>) => Promise<T>,
): Promise<T> {
  const runtime = await createRuntime();
  try {
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

function installShutdownHandlers(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
) {
  let stopping = false;
  let shutdown: Promise<void> | null = null;
  const stop = () => {
    stopping = true;
    shutdown ??= runtime.coordinator.requestShutdown();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    get stopping() {
      return stopping;
    },
    async wait(): Promise<void> {
      await shutdown;
    },
    dispose(): void {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

function print(value: unknown, json = false): void {
  if (json || typeof value !== "string") {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

function reportRecovery(runtime: Awaited<ReturnType<typeof createRuntime>>): void {
  if (runtime.recovery?.taskIds.length) {
    console.warn(
      `Recovered ${runtime.recovery.taskIds.length} stale task(s) to blocked for operator review.`,
    );
  }
  for (const cleanup of runtime.recovery?.processCleanup ?? []) {
    if (cleanup.status !== "terminated" && cleanup.status !== "not-found") {
      console.warn(
        `Run ${cleanup.runId} process cleanup ${cleanup.status}: ${cleanup.detail}`,
      );
    }
  }
  for (const cleanup of runtime.recovery?.remoteCleanup ?? []) {
    if (cleanup.status !== "stopped") {
      console.warn(
        `Run ${cleanup.runId} remote cancellation is not safely retryable (${cleanup.status}): ${cleanup.error ?? "reconciliation required"}`,
      );
    }
  }
}

program
  .command("init")
  .description("Initialize the local SQLite database and artifact directories")
  .action(async () => {
    await withRuntime(async ({ config }) => {
      console.log(`Initialized Agent Control Center at ${config.homeDir}`);
      console.log(`Database: ${config.databasePath}`);
    });
  });

program
  .command("doctor")
  .description("Check SQLite and agent adapter availability")
  .option("--json", "print machine-readable JSON")
  .action(async ({ json }: { json?: boolean }) => {
    await withRuntime(async ({ config, adapters }) => {
      const health = [];
      for (const kind of ["codex", "claude", "openclaw"] as const) {
        const adapter = adapters.get(kind);
        health.push(
          adapter
            ? { agent: kind, ...(await adapter.availability()) }
            : {
                agent: kind,
                available: false,
                target: "not configured",
                version: null,
                reason: "Set OPENCLAW_ADAPTER_URL to enable this adapter.",
              },
        );
      }
      if (json) {
        print({ database: config.databasePath, adapters: health }, true);
      } else {
        console.log(`Database: ${config.databasePath}`);
        console.table(
          health.map((item) => ({
            agent: item.agent,
            available: item.available ? "yes" : "no",
            version: item.version ?? "—",
            target: item.target,
            reason: item.reason ?? "—",
          })),
        );
      }
    });
  });

const protocol = program.command("protocol").description("Inspect the shared protocol");
protocol
  .command("schema")
  .description("Print the TaskPayload JSON Schema")
  .action(() => print(taskPayloadJsonSchema(), true));

const task = program.command("task").description("Create and manage durable agent tasks");

task
  .command("create")
  .description("Create a task from flags or a JSON payload file")
  .option("--file <path>", "read the shared task payload from JSON")
  .option("--id <id>", "stable caller-supplied task id")
  .option("--goal <goal>", "task goal")
  .option("--repo <path>", "absolute or relative path to a clean local Git repository")
  .option("--base-ref <ref>", "Git base ref", "HEAD")
  .addOption(
    new Option("--agent <agent>", "routing preference")
      .choices(AgentSelectionSchema.options)
      .default("auto"),
  )
  .addOption(
    new Option("--priority <priority>", "task priority")
      .choices(PrioritySchema.options)
      .default("normal"),
  )
  .option("--context <context>", "additional context")
  .option("--success <criterion...>", "one or more success criteria")
  .option("--verify <command>", "verification command recorded in the task")
  .option("--no-handoff", "allow success to finish without human review")
  .option("--json", "print the full task aggregate")
  .action(
    async (options: {
      file?: string;
      id?: string;
      goal?: string;
      repo?: string;
      baseRef: string;
      agent: string;
      priority: string;
      context?: string;
      success?: string[];
      verify?: string;
      handoff: boolean;
      json?: boolean;
    }) => {
      let input: unknown;
      if (options.file) {
        input = JSON.parse(await readFile(resolve(options.file), "utf8")) as unknown;
      } else {
        input = {
          ...(options.id ? { id: options.id } : {}),
          goal: options.goal,
          repo: options.repo,
          baseRef: options.baseRef,
          agent: options.agent,
          priority: options.priority,
          ...(options.context ? { context: options.context } : {}),
          successCriteria: options.success ?? [],
          ...(options.verify ? { verificationCommand: options.verify } : {}),
          handoffRequired: options.handoff,
        };
      }
      const payload = TaskPayloadSchema.parse(input);
      await withRuntime(async ({ coordinator }) => {
        const created = await coordinator.createTask(payload);
        if (options.json) print(created, true);
        else {
          console.log(`Created ${created.task.id} (${created.task.status})`);
          console.log(
            `Route: ${created.routeSteps.map((step) => `${step.agent}:${step.role}`).join(" -> ")}`,
          );
          for (const reason of created.task.routePlan.reasons) console.log(`- ${reason}`);
        }
      });
    },
  );

task
  .command("list")
  .description("List tasks ordered for operations attention")
  .addOption(new Option("--status <status>").choices(TaskStatusSchema.options))
  .option("--json", "print machine-readable JSON")
  .action(async ({ status, json }: { status?: string; json?: boolean }) => {
    await withRuntime(async ({ db }) => {
      const tasks = await db.listTasks(status ? TaskStatusSchema.parse(status) : undefined);
      if (json) print(tasks, true);
      else {
        console.table(
          tasks.map((item) => ({
            id: item.id,
            status: item.status,
            priority: item.priority,
            route: item.routePlan.steps.map((step) => step.agent).join(" -> "),
            goal: item.goal,
            latest: item.latestUpdate,
          })),
        );
      }
    });
  });

task
  .command("show <taskId>")
  .description("Show task, route, runs, artifacts, review, messages, and timeline")
  .action(async (taskId: string) => {
    await withRuntime(async ({ db }) => {
      const found = await db.getTask(taskId);
      if (!found) throw new Error(`Task not found: ${taskId}`);
      print(found, true);
    });
  });

task
  .command("approve <taskId>")
  .description("Approve review evidence and close the task")
  .option("--note <note>", "review note")
  .action(async (taskId: string, { note }: { note?: string }) => {
    await withRuntime(async ({ coordinator }) => {
      await coordinator.approveTask(taskId, note);
      console.log(`Approved ${taskId}`);
    });
  });

task
  .command("rework <taskId>")
  .description("Request rework and queue a new attempt")
  .requiredOption("--note <note>", "actionable rework note")
  .action(async (taskId: string, { note }: { note: string }) => {
    await withRuntime(async ({ coordinator }) => {
      await coordinator.requestRework(taskId, note);
      console.log(`Queued ${taskId} for rework`);
    });
  });

task
  .command("retry <taskId>")
  .description("Explicitly requeue the failed step(s) of a blocked task")
  .option("--note <note>", "operator context for the next attempt")
  .option(
    "--allow-unconfirmed-remote",
    "accept duplicate-side-effect risk when OpenClaw cancellation is unconfirmed",
  )
  .action(async (
    taskId: string,
    {
      note,
      allowUnconfirmedRemote,
    }: { note?: string; allowUnconfirmedRemote?: boolean },
  ) => {
    await withRuntime(async ({ coordinator }) => {
      await coordinator.retryBlockedTask(
        taskId,
        note,
        allowUnconfirmedRemote ?? false,
      );
      console.log(`Queued ${taskId} for another attempt`);
    });
  });

const review = program
  .command("review")
  .description("Decide an exact evidence review revision");

review
  .command("decide <reviewId>")
  .description("Approve or request rework with a compare-and-swap revision")
  .addOption(
    new Option("--decision <decision>").choices(["approve", "rework"]).makeOptionMandatory(),
  )
  .requiredOption("--if-revision <updatedAt>", "exact pending review updatedAt value")
  .option("--note <note>", "review note; required for rework")
  .action(async (
    reviewId: string,
    options: { decision: "approve" | "rework"; ifRevision: string; note?: string },
  ) => {
    await withRuntime(async ({ coordinator }) => {
      if (options.decision === "approve") {
        const taskId = await coordinator.approveReview(
          reviewId,
          options.ifRevision,
          options.note,
        );
        console.log(`Approved ${reviewId} for ${taskId}`);
        return;
      }
      if (!options.note?.trim()) throw new Error("--note is required for rework");
      const taskId = await coordinator.requestReviewRework(
        reviewId,
        options.ifRevision,
        options.note,
      );
      console.log(`Requested rework from ${reviewId} for ${taskId}`);
    });
  });

const evidence = program
  .command("evidence")
  .description("Inspect and verify immutable task evidence");

evidence
  .command("verify <taskId>")
  .description("Re-hash every artifact for a task and verify storage containment")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId: string, { json }: { json?: boolean }) => {
    await withRuntime(async ({ db, config }) => {
      const artifacts = await db.listArtifacts(taskId);
      if (artifacts.length === 0) throw new Error(`No evidence found for ${taskId}`);
      const verified = [];
      for (const artifact of artifacts) {
        const integrity = await verifyArtifactEvidence(config.artifactsDir, artifact);
        verified.push({ id: artifact.id, kind: artifact.kind, ...integrity });
      }
      if (json) print({ taskId, verified }, true);
      else console.log(`Verified ${verified.length} immutable artifact(s) for ${taskId}`);
    });
  });

const run = program.command("run").description("Execute queued work");

run
  .command("next")
  .description("Claim and execute the next queued task")
  .option("--json", "print machine-readable JSON")
  .action(async ({ json }: { json?: boolean }) => {
    const runtime = await createRuntime({
      workerId: `next:${process.pid}`,
      recoverStale: true,
    });
    const signals = installShutdownHandlers(runtime);
    reportRecovery(runtime);
    try {
      const result = await runtime.coordinator.runNext();
      if (!result) {
        console.log("Queue is empty.");
        return;
      }
      if (json) print(result, true);
      else {
        console.log(`${result.taskId}: ${result.status}`);
        if (result.handoffPath) console.log(`Handoff: ${result.handoffPath}`);
      }
    } finally {
      await signals.wait();
      signals.dispose();
      await runtime.close();
    }
  });

program
  .command("serve")
  .description("Run the authenticated local daemon, worker, HTTP API, and SSE stream")
  .option("--host <host>", "loopback host", "127.0.0.1")
  .option("--port <port>", "TCP port", "4317")
  .option("--poll <milliseconds>", "empty-queue poll interval", "1000")
  .option("--no-worker", "serve the control API without claiming queued work")
  .action(async ({ host, port, poll, worker }: { host: string; port: string; poll: string; worker: boolean }) => {
    const parsedPort = Number(port);
    const pollMs = Number(poll);
    if (!Number.isSafeInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
      throw new Error("--port must be an integer from 0 to 65535");
    }
    if (!Number.isSafeInteger(pollMs) || pollMs < 100) {
      throw new Error("--poll must be at least 100ms");
    }
    const runtime = await createRuntime({
      workerId: `daemon:${process.pid}`,
      recoverStale: true,
    });
    reportRecovery(runtime);
    let daemon: Awaited<ReturnType<typeof startControlCenterDaemon>> | null = null;
    try {
      daemon = await startControlCenterDaemon({
        runtime,
        host,
        port: parsedPort,
        pollMs,
        enableWorker: worker,
        allowedOrigins: parseExtraArgs("ACC_ALLOWED_ORIGINS"),
      });
    } catch (error) {
      await runtime.close();
      throw error;
    }
    console.log(`Agent Control Center daemon: ${daemon.url}`);
    console.log(`Bearer token: ${daemon.tokenPath ?? "provided by caller"}`);
    console.log(`Database: ${runtime.config.databasePath}`);
    console.log(`Worker: ${worker ? "enabled" : "disabled"}`);
    await new Promise<void>((resolveStopped, rejectStopped) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void daemon!
          .stop()
          .then(resolveStopped)
          .catch(rejectStopped);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });

const nodeCmd = program
  .command("node")
  .description("Enroll and run this machine as a trusted execution node");

nodeCmd
  .command("enroll")
  .description("Exchange a single-use code for node credentials (key stays local)")
  .requiredOption("--url <url>", "cloud HTTP base, e.g. https://cloud.example")
  .requiredOption("--code <code>", "single-use code from an ACCP-compatible operator")
  .option("--name <name>", "node display name", "node")
  .action(async ({ url, code, name }: { url: string; code: string; name: string }) => {
    const { enrollNode } = await import("./node/node-runtime.js");
    const config = loadConfig();
    const credentials = await enrollNode({
      home: config.homeDir,
      cloudHttpUrl: url,
      enrollmentCode: code,
      nodeName: name,
    });
    console.log(`enrolled node ${credentials.nodeId} in workspace ${credentials.workspaceId}`);
    console.log(`identity stored under ${config.homeDir}/node (0600)`);
  });

nodeCmd
  .command("connect")
  .description("Connect outbound to the cloud and execute offered work via the local kernel")
  .requiredOption("--ws <url>", "cloud WebSocket URL, e.g. wss://cloud.example")
  .option("--http <url>", "cloud HTTP base for plan fetch (defaults from --ws)")
  .action(async ({ ws, http }: { ws: string; http?: string }) => {
    const { NodeConnection } = await import("./node/node-runtime.js");
    const config = loadConfig();
    const connection = await NodeConnection.start({
      home: config.homeDir,
      wsUrl: ws,
      ...(http ? { httpUrl: http } : {}),
    });
    console.log(`node connected to ${ws}; executing offers via the local kernel`);
    const shutdown = async () => {
      await connection.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    await new Promise(() => undefined);
  });

program
  .command("mcp")
  .description("Expose the authenticated daemon as a stdio MCP control-plane bridge")
  .action(async () => {
    // stdout belongs exclusively to MCP protocol frames for this command.
    await runAgentControlCenterMcpStdio();
  });

run
  .command("worker")
  .description("Continuously claim queued tasks in one supervisor process")
  .option("--poll <milliseconds>", "empty-queue poll interval", "2000")
  .action(async ({ poll }: { poll: string }) => {
    const pollMs = Number(poll);
    if (!Number.isFinite(pollMs) || pollMs < 100) {
      throw new Error("--poll must be at least 100ms");
    }
    const runtime = await createRuntime({
      workerId: `daemon:${process.pid}`,
      recoverStale: true,
    });
    const signals = installShutdownHandlers(runtime);
    console.log(`Worker ${process.pid} watching ${runtime.config.databasePath}`);
    reportRecovery(runtime);
    try {
      while (!signals.stopping) {
        const result = await runtime.coordinator.runNext();
        if (!result) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
        } else {
          console.log(`${result.taskId}: ${result.status}`);
        }
      }
    } finally {
      await signals.wait();
      signals.dispose();
      await runtime.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`acc: ${message}`);
  process.exitCode = 1;
});
