import { EventEmitter } from "node:events";

export interface ControlCenterEvent {
  id: number;
  taskId: string;
  runId?: string;
  type: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface MessageBus {
  publish(event: ControlCenterEvent): Promise<void>;
  subscribe(listener: (event: ControlCenterEvent) => void): () => void;
}

/**
 * Process-local fan-out for the CLI/daemon. Durable history is written to
 * SQLite separately; a later Redis/NATS adapter can implement this interface
 * without changing coordinator behavior.
 */
export class InProcessMessageBus implements MessageBus {
  readonly #emitter = new EventEmitter();

  async publish(event: ControlCenterEvent): Promise<void> {
    this.#emitter.emit("event", event);
  }

  subscribe(listener: (event: ControlCenterEvent) => void): () => void {
    const isolated = (event: ControlCenterEvent) => {
      queueMicrotask(() => {
        try {
          listener(event);
        } catch {
          // Subscribers are outside the durable transition boundary. A broken
          // UI/SSE client must never fail a coordinator operation.
        }
      });
    };
    this.#emitter.on("event", isolated);
    return () => this.#emitter.off("event", isolated);
  }
}
