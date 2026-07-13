import { z } from "zod";

export const ADAPTER_PROTOCOL_VERSION = "acc-adapter/1" as const;

export const AdapterIdSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);
export type AdapterId = z.infer<typeof AdapterIdSchema>;

export const AdapterManifestSchema = z.object({
  protocol: z.literal(ADAPTER_PROTOCOL_VERSION),
  adapterId: AdapterIdSchema,
  displayName: z.string().min(1).max(120),
  adapterVersion: z.string().min(1).max(64),
  capabilities: z.object({
    workspaceAccess: z.enum(["none", "read", "write"]),
    networkAccess: z.boolean(),
    secretNames: z.array(z.string()).max(100),
    sideEffects: z.enum(["none", "declared", "unrestricted"]),
    liveMessages: z.boolean(),
    cancellation: z.boolean(),
    reconciliation: z.boolean(),
  }),
}).strict();
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export const AdapterRpcRequestSchema = z.object({
  protocol: z.literal(ADAPTER_PROTOCOL_VERSION),
  requestId: z.string().min(1).max(200),
  method: z.enum([
    "probe",
    "start",
    "postMessage",
    "collect",
    "cancel",
    "reconcile",
    "cleanup",
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type AdapterRpcRequest = z.infer<typeof AdapterRpcRequestSchema>;

export const AdapterRpcResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocol: z.literal(ADAPTER_PROTOCOL_VERSION),
    requestId: z.string().min(1).max(200),
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    protocol: z.literal(ADAPTER_PROTOCOL_VERSION),
    requestId: z.string().min(1).max(200),
    ok: z.literal(false),
    error: z.object({
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(2_000),
      retryable: z.boolean().default(false),
    }).strict(),
  }).strict(),
]);
export type AdapterRpcResponse = z.infer<typeof AdapterRpcResponseSchema>;

export const AdapterStartResultSchema = z.object({
  handleId: z.string().min(1).max(200),
  startedAt: z.string().datetime({ offset: true }),
}).strict();

export const AdapterCollectResultSchema = z.object({
  handleId: z.string().min(1).max(200),
  status: z.enum(["succeeded", "failed", "stopped", "stale"]),
  summary: z.string().max(100_000),
  artifactPaths: z.array(z.string()).max(200).default([]),
}).strict();

export interface AdapterLifecycle {
  probe(): Promise<AdapterManifest>;
  start(input: {
    task: unknown;
    workingDirectory: string;
    artifactDirectory: string;
    idempotencyKey: string;
  }): Promise<z.infer<typeof AdapterStartResultSchema>>;
  postMessage(handleId: string, body: string): Promise<void>;
  collect(handleId: string): Promise<z.infer<typeof AdapterCollectResultSchema>>;
  cancel(handleId: string): Promise<void>;
  reconcile(handleId: string): Promise<z.infer<typeof AdapterCollectResultSchema>>;
  cleanup(handleId: string): Promise<void>;
}
