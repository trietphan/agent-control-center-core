// Node runtime: the `acc node enroll` / `acc node connect` entrypoints.
// enrollNode() exchanges a single-use code for credentials over HTTPS and
// persists the identity locally (private key never leaves this machine).
// NodeConnection wires NodeWsClient + NodeSession + SqliteNodeStateStore +
// CoordinatorKernelBridge into a long-running outbound worker: offers are
// accepted only after real precondition checks, executed sequentially
// through the local kernel, and their evidence-digested completions flow
// back to the cloud.
import { createPrivateKey, type KeyObject } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createRuntime, type ControlCenterRuntime } from "../runtime.js";
import type { KernelBridge } from "../kernel/bridge.js";
import { CoordinatorKernelBridge } from "../kernel/coordinator-bridge.js";
import { createEnrollmentRequest, type NodeCredentials } from "./enrollment.js";
import { NodeSession } from "./session.js";
import { SqliteNodeStateStore } from "./state-store.js";
import { NodeWsClient } from "./ws-client.js";
import { ACCP_SCHEMA_BUNDLE_DIGEST } from "../accp/bundle.js";

function nodeDir(home: string): string {
  return join(home, "node");
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}

function secureHttpBase(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error("ACCP HTTP URL must not contain credentials");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("ACCP HTTP URL must use https, except for loopback development");
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url;
}

function tightenPrivatePath(path: string, mode: number): void {
  if (process.platform !== "win32") chmodSync(path, mode);
}

function assertPrivateFile(path: string): void {
  if (process.platform === "win32") return;
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`Node identity file must not be accessible by group or other users: ${path}`);
  }
}

export async function enrollNode(options: {
  home: string;
  cloudHttpUrl: string;
  enrollmentCode: string;
  nodeName?: string;
}): Promise<NodeCredentials> {
  const { request, keys } = createEnrollmentRequest(
    options.enrollmentCode,
    options.nodeName ?? "node",
    new Date(),
  );
  const baseUrl = secureHttpBase(options.cloudHttpUrl);
  const response = await fetch(new URL("v1/enroll", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new Error(`enrollment failed: HTTP ${response.status}`);
  }
  const credentials = (await response.json()) as NodeCredentials;
  const dir = nodeDir(options.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenPrivatePath(dir, 0o700);
  const credentialsPath = join(dir, "credentials.json");
  const keyPath = join(dir, "key.pem");
  writeFileSync(
    credentialsPath,
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    keyPath,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    { mode: 0o600 },
  );
  tightenPrivatePath(credentialsPath, 0o600);
  tightenPrivatePath(keyPath, 0o600);
  return credentials;
}

export function loadNodeIdentity(home: string): {
  credentials: NodeCredentials;
  privateKey: KeyObject;
} {
  const dir = nodeDir(home);
  const credentialsPath = join(dir, "credentials.json");
  const keyPath = join(dir, "key.pem");
  assertPrivateFile(credentialsPath);
  assertPrivateFile(keyPath);
  const credentials = JSON.parse(
    readFileSync(credentialsPath, "utf8"),
  ) as NodeCredentials;
  const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  return { credentials, privateKey };
}

export interface NodeConnectionOptions {
  home: string;
  wsUrl: string;
  /** Plan-fetch base URL; defaults to the ws URL with http(s) scheme. */
  httpUrl?: string;
  /** Test seam: injected kernel skips the real coordinator runtime. */
  kernel?: KernelBridge;
}

export class NodeConnection {
  readonly session: NodeSession;
  readonly client: NodeWsClient;
  readonly bridge: CoordinatorKernelBridge | null;
  readonly #store: SqliteNodeStateStore;
  readonly #runtime: ControlCenterRuntime | null;
  readonly #planCache = new Map<string, string>();
  readonly #httpUrl: string;
  readonly #pendingLeases: string[] = [];
  #executing: Promise<void> = Promise.resolve();

  private constructor(args: {
    session: NodeSession;
    client: NodeWsClient;
    bridge: CoordinatorKernelBridge | null;
    store: SqliteNodeStateStore;
    runtime: ControlCenterRuntime | null;
    httpUrl: string;
  }) {
    this.session = args.session;
    this.client = args.client;
    this.bridge = args.bridge;
    this.#store = args.store;
    this.#runtime = args.runtime;
    this.#httpUrl = args.httpUrl;
  }

  static async start(options: NodeConnectionOptions): Promise<NodeConnection> {
    const { credentials, privateKey } = loadNodeIdentity(options.home);
    const store = new SqliteNodeStateStore(
      join(nodeDir(options.home), "state.sqlite"),
    );
    const httpUrl = secureHttpBase(
      options.httpUrl ?? options.wsUrl.replace(/^ws(s?):\/\//, "http$1://"),
    ).toString().replace(/\/$/u, "");

    let runtime: ControlCenterRuntime | null = null;
    let bridge: CoordinatorKernelBridge | null = null;
    let connection: NodeConnection | null = null;
    let kernel: KernelBridge;
    if (options.kernel) {
      kernel = options.kernel;
    } else {
      runtime = await createRuntime({ workerId: `node:${credentials.nodeId}` });
      bridge = new CoordinatorKernelBridge({
        coordinator: runtime.coordinator,
        db: runtime.db,
        resolvePlan: (digest) => connection?.planFromCache(digest) ?? null,
        onAccepted: (leaseId) => connection?.enqueue(leaseId),
      });
      kernel = bridge;
    }

    const session = new NodeSession({
      credentials,
      privateKey,
      kernel,
      schemaBundleDigest: ACCP_SCHEMA_BUNDLE_DIGEST,
      store,
    });
    const client = new NodeWsClient({
      session,
      url: options.wsUrl,
      preprocess: async (raw) => {
        // Prefetch plan bytes so the bridge's synchronous precondition
        // check answers from the local cache (decline-not-fail contract).
        if (
          typeof raw === "object" &&
          raw !== null &&
          (raw as { type?: unknown }).type === "work.offer"
        ) {
          const digest = (
            raw as { payload?: { planRevision?: { digest?: unknown } } }
          ).payload?.planRevision?.digest;
          if (typeof digest === "string") {
            await connection?.prefetchPlan(digest);
          }
        }
      },
    });
    connection = new NodeConnection({
      session,
      client,
      bridge,
      store,
      runtime,
      httpUrl,
    });
    await client.connect();
    return connection;
  }

  planFromCache(digest: string): string | null {
    return this.#planCache.get(digest) ?? null;
  }

  async prefetchPlan(digest: string): Promise<void> {
    if (this.#planCache.has(digest)) return;
    const response = await fetch(`${this.#httpUrl}/v1/plans/${digest}`);
    if (!response.ok) return; // cold cache -> typed decline, never mid-run failure
    const body = (await response.json()) as { planBytes?: string };
    if (typeof body.planBytes === "string") {
      this.#planCache.set(digest, body.planBytes);
    }
  }

  /** Accepted leases execute strictly one at a time through the kernel. */
  enqueue(leaseId: string): void {
    this.#pendingLeases.push(leaseId);
    this.#executing = this.#executing.then(() => this.#drain());
  }

  async #drain(): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    for (;;) {
      const leaseId = this.#pendingLeases.shift();
      if (leaseId === undefined) return;
      const outcome = await bridge.executeAccepted(leaseId, this.session);
      this.client.flushEvents();
      this.client.send(outcome.completionEnvelope);
    }
  }

  /** Resolves once every queued lease has been executed and reported. */
  async idle(): Promise<void> {
    await this.#executing;
  }

  async close(): Promise<void> {
    await this.#executing.catch(() => undefined);
    await this.client.close();
    this.#store.close();
    if (this.#runtime) await this.#runtime.close();
  }
}
