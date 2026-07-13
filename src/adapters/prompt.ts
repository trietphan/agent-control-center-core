import type { AdapterTaskRequest } from "./types.js";

export function buildTaskPrompt(request: AdapterTaskRequest): string {
  const { task } = request;
  const role = request.role ?? "execute";
  const lines = [
    `Task ID: ${task.id ?? "unassigned"}`,
    `Role: ${role}`,
    `Goal: ${task.goal}`,
    `Repository: ${request.workingDirectory}`,
  ];

  if (task.context) {
    lines.push("", "Context:", task.context);
  }

  if (task.successCriteria.length > 0) {
    lines.push(
      "",
      "Success criteria:",
      ...task.successCriteria.map((criterion) => `- ${criterion}`),
    );
  }

  if (task.verificationCommand) {
    lines.push("", `Verification command: ${task.verificationCommand}`);
  }

  if (role === "review") {
    lines.push(
      "",
      "Review only. Do not modify files. Report concrete findings and verification evidence.",
    );
  } else if (role === "approval") {
    lines.push(
      "",
      "Summarize the evidence and request an explicit approve or rework decision.",
    );
  }

  return `${lines.join("\n").trim()}\n`;
}
