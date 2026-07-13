import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "needs-review",
  "blocked",
  "done",
]);

export const PrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const AgentSelectionSchema = z.enum([
  "auto",
  "codex",
  "claude",
  "openclaw",
  "parallel",
]);
export const AgentKindSchema = z.enum(["codex", "claude", "openclaw"]);
export const RouteRoleSchema = z.enum(["execute", "review", "approval"]);

// Task IDs are also durable storage keys. Keep caller-supplied IDs readable,
// but never allow them to become paths or alternate spellings of the same key.
export const TaskIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "Task id may contain only letters, numbers, dot, underscore, or dash",
  )
  .refine((value) => value !== "." && value !== "..", {
    message: "Task id cannot be dot or dot-dot",
  });

export const TaskPayloadSchema = z.object({
  id: TaskIdSchema.optional(),
  goal: z.string().trim().min(1).max(10_000),
  repo: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).default("HEAD"),
  agent: AgentSelectionSchema.default("auto"),
  priority: PrioritySchema.default("normal"),
  context: z.string().trim().max(100_000).optional(),
  successCriteria: z.array(z.string().trim().min(1)).max(50).default([]),
  verificationCommand: z.string().trim().max(2_000).optional(),
  handoffRequired: z.boolean().default(true),
}).strict();

export const RouteStepSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  agent: AgentKindSchema,
  role: RouteRoleSchema,
  required: z.boolean().default(true),
  reason: z.string().min(1),
});

export const RoutePlanSchema = z.object({
  mode: z.enum(["single", "sequential", "parallel"]),
  risk: z.enum(["normal", "high"]),
  reasons: z.array(z.string()),
  steps: z.array(RouteStepSchema).min(1),
});

export const RunStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "stopped",
  "stale",
]);

export const ArtifactKindSchema = z.enum([
  "prompt",
  "stdout",
  "stderr",
  "result",
  "diff",
  "git-status",
  "commit",
  "screenshot",
  "test-log",
  "handoff",
  "metadata",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type AgentSelection = z.infer<typeof AgentSelectionSchema>;
export type AgentKind = z.infer<typeof AgentKindSchema>;
export type RouteRole = z.infer<typeof RouteRoleSchema>;
export type TaskPayload = z.infer<typeof TaskPayloadSchema>;
export type RouteStep = z.infer<typeof RouteStepSchema>;
export type RoutePlan = z.infer<typeof RoutePlanSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export function taskPayloadJsonSchema(): unknown {
  return z.toJSONSchema(TaskPayloadSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  });
}

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "blocked"],
  running: ["needs-review", "blocked", "done", "queued"],
  "needs-review": ["done", "queued", "blocked"],
  blocked: ["queued", "done"],
  done: ["queued"],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["starting", "stopped"],
  starting: ["running", "failed", "stopped"],
  running: ["succeeded", "failed", "stopped", "stale"],
  succeeded: [],
  failed: ["queued"],
  stopped: ["queued"],
  stale: ["queued", "failed"],
};

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (from === to) return;
  if (!RUN_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}
