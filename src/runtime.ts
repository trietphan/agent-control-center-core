import {
  ClaudeAdapter,
  CodexAdapter,
  OpenClawAdapter,
  UnavailableAdapter,
  terminateVerifiedProcessGroup,
  type AgentAdapter,
  type AdapterTerminalStatus,
  type RecoveredProcessTermination,
} from "./adapters/index.js";
import { ArtifactStore } from "./artifacts.js";
import { loadConfig, parseExtraArgs, type ControlCenterConfig } from "./config.js";
import { Coordinator } from "./coordinator.js";
import { ControlCenterDb, type StaleRecoveryResult } from "./db.js";
import type { AgentKind } from "./protocol.js";
import { WorktreeManager } from "./worktrees.js";
import { InProcessMessageBus, type MessageBus } from "./message-bus.js";

export interface ControlCenterRuntime {
  config: ControlCenterConfig;
  db: ControlCenterDb;
  adapters: Map<AgentKind, AgentAdapter>;
  coordinator: Coordinator;
  bus: MessageBus;
  recovery: RuntimeRecoveryResult | null;
  recoverDeadWorker(
    workerId: string,
    recoveredBy?: string,
  ): Promise<RuntimeRecoveryResult>;
  close(): Promise<void>;
}

export interface RuntimeRecoveryResult extends StaleRecoveryResult {
  processCleanup: Array<RecoveredProcessTermination & { taskId: string }>;
  remoteCleanup: Array<{
    taskId: string;
    runId: string;
    remoteId: string;
    status: AdapterTerminalStatus;
    error: string | null;
  }>;
}

export function isRemoteCancellationConfirmed(
  status: AdapterTerminalStatus,
): boolean {
  return status === "stopped";
}

async function reconcileRecoveredRuns(
  db: ControlCenterDb,
  adapters: ReadonlyMap<AgentKind, AgentAdapter>,
  recovered: StaleRecoveryResult,
): Promise<RuntimeRecoveryResult> {
  const processCleanup = await Promise.all(
    recovered.processCandidates.map(async ({ taskId, runId, pid }) => {
      const cleanup = await terminateVerifiedProcessGroup({ runId, pid });
      await db.appendEvent({
        taskId,
        runId,
        type: "run.recovery_process_cleanup",
        level:
          cleanup.status === "terminated" || cleanup.status === "not-found"
            ? "info"
            : "warn",
        message: `${cleanup.status}: ${cleanup.detail}`,
      });
      return { taskId, ...cleanup };
    }),
  );
  const openclaw = adapters.get("openclaw");
  const remoteCleanup = await Promise.all(
    recovered.remoteCandidates.map(async ({ taskId, runId, remoteId }) => {
      let result: {
        remoteId: string;
        status: AdapterTerminalStatus;
        error: string | null;
      };
      if (openclaw instanceof OpenClawAdapter) {
        result = await openclaw.cancelDurable(remoteId);
      } else {
        const availability = openclaw
          ? await openclaw.availability()
          : { reason: "OpenClaw adapter is not registered." };
        result = {
          remoteId,
          status: "stale",
          error:
            availability.reason ??
            "OpenClaw adapter is unavailable for durable cancellation.",
        };
      }
      // Only an explicit stopped/cancelled state proves the external action
      // cannot be duplicated. succeeded/failed may already have side effects.
      const confirmed = isRemoteCancellationConfirmed(result.status);
      await db.appendEvent({
        taskId,
        runId,
        type: confirmed
          ? "run.remote_cancellation_confirmed"
          : "run.remote_cancellation_unconfirmed",
        level: confirmed ? "info" : "warn",
        message: confirmed
          ? `Remote handle ${remoteId} reached ${result.status}.`
          : result.error ??
            `Remote handle ${remoteId} reached ${result.status}; external side effects require reconciliation.`,
        data: { remoteId, status: result.status },
      });
      return { taskId, runId, ...result };
    }),
  );
  return { ...recovered, processCleanup, remoteCleanup };
}

function mergeRecovery(
  current: RuntimeRecoveryResult | null,
  next: RuntimeRecoveryResult,
): RuntimeRecoveryResult {
  if (!current) return next;
  return {
    taskIds: [...new Set([...current.taskIds, ...next.taskIds])],
    staleRunIds: [...new Set([...current.staleRunIds, ...next.staleRunIds])],
    failedRunIds: [...new Set([...current.failedRunIds, ...next.failedRunIds])],
    processCandidates: [...current.processCandidates, ...next.processCandidates],
    remoteCandidates: [...current.remoteCandidates, ...next.remoteCandidates],
    processCleanup: [...current.processCleanup, ...next.processCleanup],
    remoteCleanup: [...current.remoteCleanup, ...next.remoteCleanup],
  };
}

export async function createRuntime(options: {
  cwd?: string;
  workerId?: string;
  recoverStale?: boolean;
} = {}): Promise<ControlCenterRuntime> {
  const config = loadConfig(options.cwd);
  const db = new ControlCenterDb(config.databasePath);
  await db.init();
  let recovered: StaleRecoveryResult | null = null;
  if (options.recoverStale) {
    recovered = await db.recoverStaleTasks(
      new Date(Date.now() - config.workerStaleAfterMs).toISOString(),
      options.workerId ?? `worker:${process.pid}`,
    );
  }
  const artifacts = new ArtifactStore({ home: config.homeDir });
  await artifacts.ensureRoot();
  const worktrees = new WorktreeManager({ home: config.homeDir });
  const bus = new InProcessMessageBus();
  const adapters = new Map<AgentKind, AgentAdapter>();
  adapters.set(
    "codex",
    new CodexAdapter({
      command: process.env.ACC_CODEX_COMMAND?.trim() || "codex",
      commandArgs: parseExtraArgs("ACC_CODEX_ARGS"),
    }),
  );
  adapters.set(
    "claude",
    new ClaudeAdapter({
      command: process.env.ACC_CLAUDE_COMMAND?.trim() || "claude",
      commandArgs: parseExtraArgs("ACC_CLAUDE_ARGS"),
    }),
  );
  const openClawUrl = process.env.OPENCLAW_ADAPTER_URL?.trim();
  if (openClawUrl) {
    try {
      adapters.set(
        "openclaw",
        new OpenClawAdapter({
          baseUrl: openClawUrl,
          ...(process.env.OPENCLAW_ADAPTER_TOKEN?.trim()
            ? { token: process.env.OPENCLAW_ADAPTER_TOKEN.trim() }
            : {}),
        }),
      );
    } catch (error) {
      adapters.set(
        "openclaw",
        new UnavailableAdapter(
          "openclaw",
          openClawUrl,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  } else {
    adapters.set(
      "openclaw",
      new UnavailableAdapter(
        "openclaw",
        "not configured",
        "Set OPENCLAW_ADAPTER_URL to enable this adapter.",
      ),
    );
  }
  let recovery: RuntimeRecoveryResult | null = null;
  if (recovered) {
    recovery = await reconcileRecoveredRuns(db, adapters, recovered);
  }
  const coordinator = new Coordinator({
    db,
    artifacts,
    worktrees,
    adapters,
    bus,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    heartbeatIntervalMs: config.workerHeartbeatMs,
  });
  return {
    config,
    db,
    adapters,
    coordinator,
    bus,
    get recovery() {
      return recovery;
    },
    recoverDeadWorker: async (
      workerId: string,
      recoveredBy = options.workerId ?? `worker:${process.pid}`,
    ) => {
      const recoveredOwner = await db.recoverTasksOwnedBy(workerId, recoveredBy);
      const reconciled = await reconcileRecoveredRuns(db, adapters, recoveredOwner);
      recovery = mergeRecovery(recovery, reconciled);
      return reconciled;
    },
    close: async () => await db.close(),
  };
}
