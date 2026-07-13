import type { AdapterResult } from "./adapters/types.js";
import type { RouteRole, TaskPayload } from "./protocol.js";

export function buildAgentPrompt(args: {
  task: TaskPayload;
  role: RouteRole;
  priorResults?: AdapterResult[];
}): string {
  const { task, role, priorResults = [] } = args;
  const criteria = task.successCriteria.length
    ? task.successCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Produce a concrete, reviewable result without regressions.";
  const prior = priorResults.length
    ? priorResults
        .map(
          (result, index) =>
            `Prior run ${index + 1} (${result.status}, exit ${result.exitCode ?? "n/a"}):\n${result.summary || "No summary."}`,
        )
        .join("\n\n")
    : "No prior agent results.";

  const roleInstruction =
    role === "execute"
      ? [
          "Implement the task directly in the provided isolated worktree.",
          "The Repository path below is the only checkout you may modify; never follow another checkout path from prior output.",
          "Inspect the repository before editing, keep changes scoped, and run relevant verification.",
          "Do not claim success without concrete evidence. End with a concise handoff: files changed, verification, remaining risks.",
        ].join(" ")
      : role === "review"
        ? [
            "Review the existing implementation and evidence independently.",
            "Do not edit files. Check the diff, correctness, regressions, tests, security, and success criteria.",
            "Start the final answer with PASS or REWORK, then list actionable findings and evidence.",
          ].join(" ")
        : [
            "Create a human-facing approval handoff from the implementation and review evidence.",
            "Do not auto-approve risky work. Summarize what changed, verification, risks, and ask for APPROVE or REWORK.",
          ].join(" ");

  return [
    "# Agent Control Center task",
    "",
    `Role: ${role}`,
    `Goal: ${task.goal}`,
    `Repository: ${task.repo}`,
    `Base ref: ${task.baseRef}`,
    `Priority: ${task.priority}`,
    "",
    "## Instructions",
    roleInstruction,
    "",
    "## Context",
    task.context || "No extra context supplied.",
    "",
    "## Success criteria",
    criteria,
    "",
    "## Verification command",
    task.verificationCommand || "Infer and run the smallest relevant verification from the repository.",
    "",
    "## Prior results",
    prior,
  ].join("\n");
}
