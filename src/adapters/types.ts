import type {
  AgentKind,
  RouteRole,
  TaskPayload,
} from "../protocol.js";
import type { UsageRecord } from "../usage.js";

export const CONTROL_RUN_TOKEN_ENV = "ACC_CONTROL_RUN_ID";

export type AdapterTerminalStatus = "succeeded" | "failed" | "stopped" | "stale";

export interface AdapterAvailability {
  available: boolean;
  target: string;
  version: string | null;
  reason: string | null;
}

export interface AdapterTaskRequest {
  task: TaskPayload;
  workingDirectory: string;
  artifactDir: string;
  role?: RouteRole;
  prompt?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Called after execution starts but before startTask resolves. Local adapters
   * use this boundary to durably persist the PID before a supervisor crash can
   * orphan an otherwise untracked process group.
   */
  onStarted?: (run: AdapterRun) => Promise<void>;
}

export interface AdapterRun {
  id: string;
  taskId: string;
  agent: AgentKind;
  role: RouteRole;
  status: "running";
  startedAt: string;
  pid: number | null;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

export interface AdapterResult {
  id: string;
  taskId: string;
  agent: AgentKind;
  role: RouteRole;
  status: AdapterTerminalStatus;
  startedAt: string;
  finishedAt: string;
  pid: number | null;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  summary: string;
  error: string | null;
  /** Normalized provider usage parsed from CLI output, when available. */
  usage?: UsageRecord;
}

export interface AgentAdapter {
  readonly kind: AgentKind;

  availability(): Promise<AdapterAvailability>;
  startTask(request: AdapterTaskRequest): Promise<AdapterRun>;
  postMessage(runId: string, message: string): Promise<void>;
  collectResult(runId: string): Promise<AdapterResult>;
  stop(runId: string): Promise<AdapterResult>;
}

export class AdapterRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Unknown adapter run: ${runId}`);
    this.name = "AdapterRunNotFoundError";
  }
}

export class AdapterCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterCapabilityError";
  }
}
