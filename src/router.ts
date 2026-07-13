import { randomUUID } from "node:crypto";
import type { AgentKind, RoutePlan, RouteRole, TaskPayload } from "./protocol.js";

const RISKY = /\b(prod(?:uction)?|deploy|migration|database|schema|auth|security|permission|payment|billing|delete|destructive|secret|credential|infrastructure)\b/i;
const ARCHITECTURE = /\b(architect(?:ure)?|design|review|audit|analy[sz]e|plan|trade-?off|spec|proposal)\b/i;
const EXTERNAL = /\b(discord|telegram|slack|email|calendar|cron|macos|desktop|browser automation|external system|openclaw)\b/i;
const CODING = /\b(code|implement|fix|bug|refactor|test|build|typescript|javascript|python|api|cli|repo|commit|pull request|pr|schema|migration|migrate|deploy)\b/i;
const CHANGE_INTENT = /\b(implement|fix|refactor|write|add|build|change|modify|migrate|deploy|remove|delete)\b/i;
const PLANNER_FIRST = /\b(planner[- ]?first|claude (?:as )?(?:planner|brain|assigner)|assign (?:work|tasks?)|delegate(?:s|d)? (?:work|tasks?)|codex and openclaw execute)\b/i;

function step(
  sequence: number,
  agent: AgentKind,
  role: RouteRole,
  reason: string,
  required = true,
) {
  return {
    id: `step_${randomUUID()}`,
    sequence,
    agent,
    role,
    reason,
    required,
  };
}

export function routeTask(task: TaskPayload): RoutePlan {
  const text = `${task.goal}\n${task.context ?? ""}\n${task.successCriteria.join("\n")}`;
  const risky = RISKY.test(text) || task.priority === "urgent";

  if (task.agent === "parallel") {
    return {
      mode: "parallel",
      risk: risky ? "high" : "normal",
      reasons: ["The requester explicitly selected a parallel Codex + Claude run."],
      steps: [
        step(0, "codex", "execute", "Codex produces an implementation candidate."),
        step(0, "claude", "execute", "Claude produces an independent candidate."),
      ],
    };
  }

  if (task.agent === "auto" && PLANNER_FIRST.test(text)) {
    return {
      mode: "sequential",
      risk: risky ? "high" : "normal",
      reasons: [
        "The requester asked for a planner-first delegation flow: Claude plans first, then Codex and OpenClaw execute from that plan.",
      ],
      steps: [
        step(
          0,
          "claude",
          "review",
          "Claude acts as the planner: decompose the goal, assign responsibilities, and define success checks.",
        ),
        step(
          1,
          "codex",
          "execute",
          "Codex implements the repository-scoped work from Claude's plan in an isolated worktree.",
        ),
        step(
          2,
          "openclaw",
          "execute",
          "OpenClaw executes the external coordination, workflow explanation, and handoff work from Claude's plan.",
        ),
      ],
    };
  }

  if (
    risky &&
    CODING.test(text) &&
    CHANGE_INTENT.test(text) &&
    (task.agent === "auto" || task.agent === "codex")
  ) {
    return {
      mode: "sequential",
      risk: "high",
      reasons: [
        "Risk-sensitive coding work requires implementation, independent review, and a human-facing approval handoff.",
        ...(task.agent === "codex" ? ["The explicit Codex assignment is preserved as the implementation step."] : []),
      ],
      steps: [
        step(0, "codex", "execute", "Codex implements the change in an isolated worktree."),
        step(1, "claude", "review", "Claude independently reviews the implementation and evidence."),
        step(
          2,
          "openclaw",
          "approval",
          "OpenClaw summarizes the evidence and requests approve/rework.",
          false,
        ),
      ],
    };
  }

  if (task.agent !== "auto") {
    return {
      mode: "single",
      risk: risky ? "high" : "normal",
      reasons: [`The requester explicitly selected ${task.agent}.`],
      steps: [step(0, task.agent, "execute", "Explicit agent assignment.")],
    };
  }

  if (EXTERNAL.test(text)) {
    return {
      mode: "single",
      risk: risky ? "high" : "normal",
      reasons: ["The task targets chat, automation, desktop, or another external system."],
      steps: [step(0, "openclaw", "execute", "OpenClaw owns external-system work.")],
    };
  }

  if (ARCHITECTURE.test(text) && !CHANGE_INTENT.test(text)) {
    return {
      mode: "single",
      risk: risky ? "high" : "normal",
      reasons: ["The task is primarily architecture, analysis, or review."],
      steps: [step(0, "claude", "review", "Claude owns non-destructive analysis and review work.")],
    };
  }

  return {
    mode: "single",
    risk: risky ? "high" : "normal",
    reasons: ["The task is repository-scoped implementation work."],
    steps: [step(0, "codex", "execute", "Codex owns coding implementation.")],
  };
}
