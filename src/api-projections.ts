import {
  ArtifactKindSchema,
  type AgentKind,
  type ArtifactKind,
  type Priority,
  type RouteRole,
  type RunStatus,
  type TaskStatus,
} from "./protocol.js";
import type {
  ArtifactRecord,
  EventLevel,
  MessageRecord,
  ReviewStatus,
  RouteStepStatus,
  RunRecord,
  TaskAggregate,
} from "./db.js";

export type TaskNextAction =
  | "execute"
  | "monitor"
  | "review"
  | "retry"
  | "inspect"
  | "none";

export interface RouteProgressDto {
  total: number;
  completed: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  percent: number;
}

export interface ActiveRunDto {
  id: string;
  routeStepId: string;
  agent: AgentKind;
  role: RouteRole;
  attempt: number;
  status: Extract<RunStatus, "queued" | "starting" | "running">;
  startedAt: string | null;
  updatedAt: string;
}

export interface EvidenceSummaryDto {
  totalArtifacts: number;
  totalBytes: number;
  byKind: Record<ArtifactKind, number>;
}

export interface PendingReviewDto {
  id: string;
  runId: string | null;
  reviewer: string | null;
  createdAt: string;
}

export interface EventSummaryDto {
  id: number;
  runId: string | null;
  type: string;
  level: EventLevel;
  message: string;
  createdAt: string;
}

export interface TaskBoardRowDto {
  id: string;
  goal: string;
  repositoryName: string;
  status: TaskStatus;
  priority: Priority;
  requestedAgent: TaskAggregate["task"]["agent"];
  routeMode: TaskAggregate["task"]["routePlan"]["mode"];
  routeRisk: TaskAggregate["task"]["routePlan"]["risk"];
  routeAgents: AgentKind[];
  routeReasons: string[];
  routeProgress: RouteProgressDto;
  activeRuns: ActiveRunDto[];
  evidenceSummary: EvidenceSummaryDto;
  pendingReview: PendingReviewDto | null;
  latestEvent: EventSummaryDto | null;
  nextAction: TaskNextAction;
  latestUpdate: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetailHeaderDto {
  id: string;
  goal: string;
  status: TaskStatus;
  priority: Priority;
  requestedAgent: TaskAggregate["task"]["agent"];
  repositoryName: string;
  baseRef: string;
  context: string | null;
  successCriteria: string[];
  verificationCommand: string | null;
  handoffRequired: boolean;
  latestUpdate: string;
  route: {
    mode: TaskAggregate["task"]["routePlan"]["mode"];
    risk: TaskAggregate["task"]["routePlan"]["risk"];
    reasons: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface RouteStepDto {
  id: string;
  sequence: number;
  agent: AgentKind;
  role: RouteRole;
  required: boolean;
  reason: string;
  status: RouteStepStatus;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunDto {
  id: string;
  routeStepId: string;
  agent: AgentKind;
  role: RouteRole;
  attempt: number;
  status: RunStatus;
  branch: string | null;
  baseCommit: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDto {
  id: string;
  runId: string | null;
  kind: ArtifactKind;
  name: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  contentUrl: string;
}

export interface MessageDto {
  id: string;
  runId: string | null;
  direction: MessageRecord["direction"];
  role: string;
  body: string;
  deliveryStatus: MessageRecord["deliveryStatus"];
  createdAt: string;
}

export interface ReviewDto {
  id: string;
  runId: string | null;
  reviewer: string | null;
  status: ReviewStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetailDto {
  summary: TaskBoardRowDto;
  task: TaskDetailHeaderDto;
  routeSteps: RouteStepDto[];
  runs: RunDto[];
  events: EventSummaryDto[];
  artifacts: ArtifactDto[];
  messages: MessageDto[];
  reviews: ReviewDto[];
}

const ACTIVE_RUN_STATUSES = new Set<RunStatus>(["queued", "starting", "running"]);

function pathLeaf(value: string, fallback: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const leaf = normalized.slice(normalized.lastIndexOf("/") + 1);
  return leaf && leaf !== "." && leaf !== ".." ? leaf : fallback;
}

function isActiveRunStatus(
  status: RunStatus,
): status is Extract<RunStatus, "queued" | "starting" | "running"> {
  return ACTIVE_RUN_STATUSES.has(status);
}

function isActiveRun(
  run: RunRecord,
): run is RunRecord & {
  status: Extract<RunStatus, "queued" | "starting" | "running">;
} {
  return isActiveRunStatus(run.status);
}

function projectRouteProgress(aggregate: TaskAggregate): RouteProgressDto {
  const counts: Record<RouteStepStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  for (const step of aggregate.routeSteps) counts[step.status] += 1;
  const total = aggregate.routeSteps.length;
  const completed = counts.succeeded + counts.failed + counts.skipped;
  return {
    total,
    completed,
    pending: counts.pending,
    running: counts.running,
    succeeded: counts.succeeded,
    failed: counts.failed,
    skipped: counts.skipped,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  };
}

function projectEvidenceSummary(artifacts: ArtifactRecord[]): EvidenceSummaryDto {
  const byKind = Object.fromEntries(
    ArtifactKindSchema.options.map((kind) => [kind, 0]),
  ) as Record<ArtifactKind, number>;
  let totalBytes = 0;
  for (const artifact of artifacts) {
    byKind[artifact.kind] += 1;
    totalBytes += artifact.sizeBytes;
  }
  return { totalArtifacts: artifacts.length, totalBytes, byKind };
}

function latestPendingReview(aggregate: TaskAggregate): PendingReviewDto | null {
  const pending = aggregate.reviews
    .filter((review) => review.status === "pending")
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    )[0];
  return pending
    ? {
        id: pending.id,
        runId: pending.runId,
        reviewer: pending.reviewer,
        createdAt: pending.createdAt,
      }
    : null;
}

function projectEvent(event: TaskAggregate["events"][number]): EventSummaryDto {
  return {
    id: event.id,
    runId: event.runId,
    type: event.type,
    level: event.level,
    message: event.message,
    createdAt: event.createdAt,
  };
}

function latestEvent(aggregate: TaskAggregate): EventSummaryDto | null {
  const event = aggregate.events.reduce<TaskAggregate["events"][number] | null>(
    (latest, candidate) => (!latest || candidate.id > latest.id ? candidate : latest),
    null,
  );
  return event ? projectEvent(event) : null;
}

function nextAction(
  status: TaskStatus,
  pendingReview: PendingReviewDto | null,
): TaskNextAction {
  if (status === "queued") return "execute";
  if (status === "running") return "monitor";
  if (status === "needs-review") return pendingReview ? "review" : "inspect";
  if (status === "blocked") return "retry";
  return "none";
}

export function artifactContentUrl(artifactId: string): string {
  return `/v1/artifacts/${encodeURIComponent(artifactId)}/content`;
}

export function projectTaskBoardRow(aggregate: TaskAggregate): TaskBoardRowDto {
  const pendingReview = latestPendingReview(aggregate);
  const activeRuns = aggregate.runs
    .filter(isActiveRun)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .map<ActiveRunDto>((run) => ({
      id: run.id,
      routeStepId: run.routeStepId,
      agent: run.agent,
      role: run.role,
      attempt: run.attempt,
      status: run.status,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
    }));
  return {
    id: aggregate.task.id,
    goal: aggregate.task.goal,
    repositoryName: pathLeaf(aggregate.task.repo, "repository"),
    status: aggregate.task.status,
    priority: aggregate.task.priority,
    requestedAgent: aggregate.task.agent,
    routeMode: aggregate.task.routePlan.mode,
    routeRisk: aggregate.task.routePlan.risk,
    routeAgents: aggregate.routeSteps.map((step) => step.agent),
    routeReasons: [...aggregate.task.routePlan.reasons],
    routeProgress: projectRouteProgress(aggregate),
    activeRuns,
    evidenceSummary: projectEvidenceSummary(aggregate.artifacts),
    pendingReview,
    latestEvent: latestEvent(aggregate),
    nextAction: nextAction(aggregate.task.status, pendingReview),
    latestUpdate: aggregate.task.latestUpdate,
    createdAt: aggregate.task.createdAt,
    updatedAt: aggregate.task.updatedAt,
  };
}

export function projectTaskDetail(aggregate: TaskAggregate): TaskDetailDto {
  const repositoryName = pathLeaf(aggregate.task.repo, "repository");
  return {
    summary: projectTaskBoardRow(aggregate),
    task: {
      id: aggregate.task.id,
      goal: aggregate.task.goal,
      status: aggregate.task.status,
      priority: aggregate.task.priority,
      requestedAgent: aggregate.task.agent,
      repositoryName,
      baseRef: aggregate.task.baseRef,
      context: aggregate.task.context ?? null,
      successCriteria: [...aggregate.task.successCriteria],
      verificationCommand: aggregate.task.verificationCommand ?? null,
      handoffRequired: aggregate.task.handoffRequired,
      latestUpdate: aggregate.task.latestUpdate,
      route: {
        mode: aggregate.task.routePlan.mode,
        risk: aggregate.task.routePlan.risk,
        reasons: [...aggregate.task.routePlan.reasons],
      },
      createdAt: aggregate.task.createdAt,
      updatedAt: aggregate.task.updatedAt,
    },
    routeSteps: [...aggregate.routeSteps]
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.createdAt.localeCompare(right.createdAt),
      )
      .map((step) => ({
        id: step.id,
        sequence: step.sequence,
        agent: step.agent,
        role: step.role,
        required: step.required,
        reason: step.reason,
        status: step.status,
        runId: step.runId,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
      })),
    runs: [...aggregate.runs]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((run) => ({
        id: run.id,
        routeStepId: run.routeStepId,
        agent: run.agent,
        role: run.role,
        attempt: run.attempt,
        status: run.status,
        branch: run.branch,
        baseCommit: run.baseCommit,
        exitCode: run.exitCode,
        signal: run.signal,
        summary: run.summary,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
    events: [...aggregate.events]
      .sort((left, right) => left.id - right.id)
      .map(projectEvent),
    artifacts: [...aggregate.artifacts]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((artifact) => ({
        id: artifact.id,
        runId: artifact.runId,
        kind: artifact.kind,
        name: pathLeaf(artifact.path, artifact.kind),
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt,
        contentUrl: artifactContentUrl(artifact.id),
      })),
    messages: [...aggregate.messages]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((message) => ({
        id: message.id,
        runId: message.runId,
        direction: message.direction,
        role: message.role,
        body: message.body,
        deliveryStatus: message.deliveryStatus,
        createdAt: message.createdAt,
      })),
    reviews: [...aggregate.reviews]
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((review) => ({
        id: review.id,
        runId: review.runId,
        reviewer: review.reviewer,
        status: review.status,
        note: review.note,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
      })),
  };
}

export const toTaskBoardRow = projectTaskBoardRow;
export const toTaskDetail = projectTaskDetail;
