import type { AgentKind } from "../protocol.js";
import type {
  AdapterAvailability,
  AdapterResult,
  AdapterRun,
  AdapterTaskRequest,
  AgentAdapter,
} from "./types.js";

/** A configured registry entry whose dependency is intentionally unavailable. */
export class UnavailableAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  readonly #target: string;
  readonly #reason: string;

  constructor(kind: AgentKind, target: string, reason: string) {
    this.kind = kind;
    this.#target = target;
    this.#reason = reason;
  }

  async availability(): Promise<AdapterAvailability> {
    return {
      available: false,
      target: this.#target,
      version: null,
      reason: this.#reason,
    };
  }

  async startTask(_request: AdapterTaskRequest): Promise<AdapterRun> {
    throw new Error(this.#reason);
  }

  async postMessage(_runId: string, _message: string): Promise<void> {
    throw new Error(this.#reason);
  }

  async collectResult(_runId: string): Promise<AdapterResult> {
    throw new Error(this.#reason);
  }

  async stop(_runId: string): Promise<AdapterResult> {
    throw new Error(this.#reason);
  }
}
