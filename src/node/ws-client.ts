// NodeWsClient: the outbound WebSocket transport around a sans-IO
// NodeSession. The session owns all protocol state; this class only moves
// envelopes and implements reconnect with full-jitter exponential backoff
// (accp-v1.md §4.1). Nodes initiate all connections — no inbound port.
import WebSocket from "ws";
import type { Envelope } from "../accp/envelope.js";
import type { NodeSession } from "./session.js";

export interface NodeWsClientOptions {
  session: NodeSession;
  url: string;
  /** Awaited before each inbound envelope reaches the session — the seam
   * where `node connect` prefetches plan bytes for work.offer so the
   * bridge's synchronous resolvePlan can answer from a local cache. */
  preprocess?: (raw: unknown) => Promise<void> | void;
  /** Backoff base/cap in ms; overridable so tests stay fast. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

function validateNodeWebSocketUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error("ACCP WebSocket URL must not contain credentials");
  }
  if (url.protocol === "wss:") return url.toString();
  if (url.protocol === "ws:" && isLoopback(url.hostname)) return url.toString();
  throw new Error("ACCP WebSocket URL must use wss, except for loopback development");
}

export class NodeWsClient {
  readonly #session: NodeSession;
  readonly #url: string;
  readonly #backoffBaseMs: number;
  readonly #backoffCapMs: number;
  readonly #preprocess: ((raw: unknown) => Promise<void> | void) | undefined;
  #socket: WebSocket | null = null;
  #attempts = 0;
  #closed = false;

  constructor(options: NodeWsClientOptions) {
    this.#session = options.session;
    this.#url = validateNodeWebSocketUrl(options.url);
    this.#backoffBaseMs = options.backoffBaseMs ?? 1000;
    this.#backoffCapMs = options.backoffCapMs ?? 60_000;
    this.#preprocess = options.preprocess;
  }

  get connected(): boolean {
    return (
      this.#session.connected &&
      this.#socket !== null &&
      this.#socket.readyState === WebSocket.OPEN
    );
  }

  /** Connect (or reconnect) once; resolves when the handshake completes. */
  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.#closed) throw new Error("client is closed");
    if (this.#socket) this.#abortSocket(this.#socket);
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const onOpen = (): void => {
          cleanup();
          resolvePromise();
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("websocket open timeout"));
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          socket.off("open", onOpen);
          socket.off("error", onError);
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
      });
      // Keep post-open transport errors observed; close/failure cleanup is
      // handled by the close listener or the connect() catch below.
      socket.on("error", () => {
        if (this.#socket === socket) this.#session.disconnect();
      });
      socket.on("message", (data) => {
        void (async () => {
          if (this.#socket !== socket) return;
          let raw: unknown;
          try {
            raw = JSON.parse(String(data));
          } catch {
            return; // ignore non-JSON frames; the session never sees them
          }
          try {
            await this.#preprocess?.(raw);
          } catch {
            // A failed prefetch leaves the cache cold; the session then
            // declines with a typed reason instead of failing mid-run.
          }
          if (this.#socket !== socket) return;
          const outbound = this.#session.receive(raw, new Date());
          for (const envelope of outbound) this.send(envelope);
        })();
      });
      socket.on("close", () => {
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#session.disconnect();
      });
      this.send(this.#session.startHandshake(new Date()));
      await this.#waitForHandshake(socket, timeoutMs);
      this.#attempts = 0;
    } catch (error) {
      this.#abortSocket(socket);
      throw error;
    }
  }

  #abortSocket(socket: WebSocket): void {
    if (this.#socket === socket) this.#socket = null;
    this.#session.disconnect();
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  async #waitForHandshake(socket: WebSocket, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#session.connected) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("handshake failed: websocket closed before node.welcome");
      }
      if (Date.now() > deadline) throw new Error("handshake timeout");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }

  /** Reconnect until it succeeds, with full-jitter exponential backoff. */
  async reconnectWithBackoff(maxAttempts = 8): Promise<void> {
    for (;;) {
      try {
        await this.connect();
        return;
      } catch (error) {
        this.#attempts += 1;
        if (this.#attempts >= maxAttempts) throw error;
        const cap = Math.min(
          this.#backoffCapMs,
          this.#backoffBaseMs * 2 ** this.#attempts,
        );
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, Math.random() * cap),
        );
      }
    }
  }

  send(envelope: Envelope): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(envelope));
  }

  /** Push all unacked event batches to the wire. */
  flushEvents(now = new Date()): void {
    for (const envelope of this.#session.flush(now)) this.send(envelope);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const socket = this.#socket;
    if (!socket) return;
    await new Promise<void>((resolvePromise) => {
      socket.once("close", () => resolvePromise());
      socket.close();
      setTimeout(() => {
        socket.terminate();
        resolvePromise();
      }, 500).unref();
    });
  }
}
