import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ADAPTER_PROTOCOL_VERSION,
  AdapterCollectResultSchema,
  AdapterManifestSchema,
  AdapterRpcResponseSchema,
  AdapterStartResultSchema,
  type AdapterManifest,
  type AdapterRpcResponse,
} from "./sdk.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export interface ConformanceOptions {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  outputLimitBytes?: number;
  keepFixture?: boolean;
}

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ConformanceReport {
  suite: "acc-adapter-conformance";
  suiteVersion: string;
  protocol: typeof ADAPTER_PROTOCOL_VERSION;
  adapter: AdapterManifest;
  manifestDigest: string;
  adapterArtifact: {
    subject: string;
    sha256: string;
    kind: "file" | "command-descriptor";
  };
  platform: string;
  node: string;
  checks: ConformanceCheck[];
  passed: boolean;
}

class JsonLineClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #timeoutMs: number;
  readonly #outputLimit: number;
  #buffer = "";
  #transcript = "";
  #stderr = "";
  #stdoutBytes = 0;
  #pending: Array<{
    resolve: (value: AdapterRpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(options: ConformanceOptions, env: NodeJS.ProcessEnv) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#outputLimit = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
    this.#child = spawn(options.command, [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: false,
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-this.#outputLimit);
    });
    this.#child.once("error", (error) => this.#failAll(error));
    this.#child.once("exit", (code, signal) => {
      if (this.#pending.length) {
        this.#failAll(
          new Error(`adapter exited before responding (code=${code}, signal=${signal})`),
        );
      }
    });
  }

  async request(
    method: "probe" | "start" | "postMessage" | "collect" | "cancel" | "reconcile" | "cleanup",
    params: Record<string, unknown> = {},
  ): Promise<AdapterRpcResponse> {
    const requestId = `conformance_${randomUUID()}`;
    const response = new Promise<AdapterRpcResponse>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`adapter ${method} timed out after ${this.#timeoutMs}ms`));
        void this.stop();
      }, this.#timeoutMs);
      this.#pending.push({ resolve: resolveResponse, reject, timer });
    });
    this.#child.stdin.write(
      `${JSON.stringify({ protocol: ADAPTER_PROTOCOL_VERSION, requestId, method, params })}\n`,
    );
    const parsed = await response;
    if (parsed.requestId !== requestId) {
      throw new Error(`response requestId mismatch for ${method}`);
    }
    return parsed;
  }

  async stop(): Promise<void> {
    this.#child.stdin.end();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.kill("SIGTERM");
    await new Promise<void>((resolveStopped) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolveStopped();
      }, 1_000);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolveStopped();
      });
    });
  }

  transcript(): string {
    return `${this.#transcript}\n${this.#stderr}`;
  }

  #onStdout(chunk: string): void {
    this.#stdoutBytes += Buffer.byteLength(chunk);
    this.#transcript += chunk;
    if (this.#stdoutBytes > this.#outputLimit) {
      this.#failAll(new Error("adapter stdout exceeded the conformance limit"));
      void this.stop();
      return;
    }
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const pending = this.#pending.shift();
      if (!pending) {
        this.#failAll(new Error("adapter wrote an unsolicited stdout frame"));
        return;
      }
      clearTimeout(pending.timer);
      try {
        pending.resolve(AdapterRpcResponseSchema.parse(JSON.parse(line)));
      } catch (error) {
        pending.reject(
          new Error(`invalid adapter response: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function adapterArtifact(options: ConformanceOptions): Promise<{
  subject: string;
  sha256: string;
  kind: "file" | "command-descriptor";
}> {
  for (const candidate of options.args ?? []) {
    const path = resolve(candidate);
    try {
      const bytes = await readFile(path);
      return {
        subject: candidate,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        kind: "file",
      };
    } catch {
      // Not every argument is a file. Continue to the next candidate.
    }
  }
  const descriptor = JSON.stringify({ command: options.command, args: options.args ?? [] });
  return {
    subject: options.command,
    sha256: sha256(descriptor),
    kind: "command-descriptor",
  };
}

function expectSuccess(response: AdapterRpcResponse, method: string): unknown {
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.error.code}: ${response.error.message}`);
  }
  return response.result;
}

function assertContained(root: string, candidate: string): void {
  const child = relative(root, resolve(candidate));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`adapter artifact escaped its directory: ${candidate}`);
  }
}

export async function runAdapterConformance(
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const root = await mkdtemp(join(tmpdir(), "acc-conformance-"));
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  const canary = `acc_conformance_secret_${randomUUID()}`;
  await Promise.all([mkdir(workspace), mkdir(artifacts)]);
  const marker = join(workspace, "MARKER.txt");
  await writeFile(marker, "immutable fixture\n", "utf8");
  const before = sha256(await readFile(marker, "utf8"));
  const client = new JsonLineClient(options, {
    ...process.env,
    ACC_CONFORMANCE_SECRET: canary,
  });
  const checks: ConformanceCheck[] = [];
  let manifest: AdapterManifest | null = null;
  try {
    const probe = expectSuccess(await client.request("probe"), "probe");
    manifest = AdapterManifestSchema.parse(
      (probe as { manifest?: unknown }).manifest,
    );
    checks.push({ name: "manifest", passed: true, detail: manifest.adapterId });

    const startParams = {
      task: { id: "fixture_task", goal: "Return a deterministic result" },
      workingDirectory: workspace,
      artifactDirectory: artifacts,
      idempotencyKey: "fixture:start:1",
    };
    const first = AdapterStartResultSchema.parse(
      expectSuccess(await client.request("start", startParams), "start"),
    );
    const replay = AdapterStartResultSchema.parse(
      expectSuccess(await client.request("start", startParams), "start replay"),
    );
    if (first.handleId !== replay.handleId) {
      throw new Error("start is not idempotent for the same idempotency key");
    }
    checks.push({ name: "idempotent-start", passed: true, detail: first.handleId });

    const collected = AdapterCollectResultSchema.parse(
      expectSuccess(
        await client.request("collect", { handleId: first.handleId }),
        "collect",
      ),
    );
    if (collected.status !== "succeeded") {
      throw new Error(`fixture collect status is ${collected.status}`);
    }
    const artifactRoot = await realpath(artifacts);
    for (const artifact of collected.artifactPaths) {
      const storedArtifact = await realpath(artifact);
      assertContained(artifactRoot, storedArtifact);
    }
    checks.push({
      name: "collect-and-artifact-containment",
      passed: true,
      detail: `${collected.artifactPaths.length} artifact(s)`,
    });

    for (const [method, declared] of [
      ["postMessage", manifest.capabilities.liveMessages],
      ["cancel", manifest.capabilities.cancellation],
    ] as const) {
      const response = await client.request(method, {
        handleId: first.handleId,
        body: "fixture message",
      });
      if (declared && !response.ok) {
        throw new Error(`${method} is declared but returned ${response.error.code}`);
      }
      if (!declared && (response.ok || response.error.code !== "UNSUPPORTED")) {
        throw new Error(`${method} must return UNSUPPORTED when not declared`);
      }
      checks.push({ name: `capability-${method}`, passed: true, detail: String(declared) });
    }

    if (manifest.capabilities.reconciliation) {
      AdapterCollectResultSchema.parse(
        expectSuccess(
          await client.request("reconcile", { handleId: first.handleId }),
          "reconcile",
        ),
      );
      checks.push({ name: "reconcile", passed: true, detail: "declared and implemented" });
    }

    expectSuccess(
      await client.request("cleanup", { handleId: first.handleId }),
      "cleanup",
    );
    if (sha256(await readFile(marker, "utf8")) !== before) {
      throw new Error("adapter changed a workspace while declaring fixture behavior");
    }
    checks.push({ name: "workspace-integrity", passed: true, detail: "unchanged" });

    if (client.transcript().includes(canary)) {
      throw new Error("adapter leaked a secret canary to stdout or stderr");
    }
    checks.push({ name: "secret-redaction", passed: true, detail: "canary absent" });

    return {
      suite: "acc-adapter-conformance",
      suiteVersion: "0.1.0",
      protocol: ADAPTER_PROTOCOL_VERSION,
      adapter: manifest,
      manifestDigest: sha256(JSON.stringify(manifest)),
      adapterArtifact: await adapterArtifact(options),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      checks,
      passed: true,
    };
  } finally {
    await client.stop().catch(() => undefined);
    if (!options.keepFixture) await rm(root, { recursive: true, force: true });
  }
}
