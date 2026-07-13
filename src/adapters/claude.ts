import { writeFile } from "node:fs/promises";

import type { RouteRole } from "../protocol.js";
import { parseClaudeCliUsage, type UsageRecord } from "../usage.js";
import { CliAdapter, type CliAdapterOptions } from "./cli-adapter.js";
import type { SupervisedResult } from "./process-supervisor.js";
import type { AdapterAvailability, AdapterTaskRequest } from "./types.js";

export type ClaudeAdapterOptions = CliAdapterOptions;

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractClaudeSummary(jsonl: string): string {
  let assistantText = "";
  let resultText = "";

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "result" && typeof event.result === "string") {
      resultText = event.result;
      continue;
    }

    if (event.type === "assistant" && event.message && typeof event.message === "object") {
      const content = (event.message as Record<string, unknown>).content;
      const extracted = textFromContent(content);
      if (extracted) assistantText = extracted;
    }
  }

  return resultText || assistantText;
}

export class ClaudeAdapter extends CliAdapter {
  readonly kind = "claude" as const;

  constructor(options: ClaudeAdapterOptions = {}) {
    super("claude", options);
  }

  override async availability(): Promise<AdapterAvailability> {
    const binary = await super.availability();
    if (!binary.available) return binary;
    const auth = await this.probe(["auth", "status", "--json"]);
    let loggedIn = false;
    if (auth.available && auth.stdout) {
      try {
        loggedIn = (JSON.parse(auth.stdout) as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        loggedIn = false;
      }
    }
    return {
      ...binary,
      available: auth.available && loggedIn,
      reason: auth.available && loggedIn
        ? null
        : "Claude CLI is not authenticated; run `claude auth login`.",
    };
  }

  protected buildArguments(
    _request: AdapterTaskRequest,
    role: RouteRole,
    _resultPath: string,
  ): readonly string[] {
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--permission-mode",
      role === "execute" ? "acceptEdits" : "plan",
    ];
  }

  protected async collectSummary(
    supervised: SupervisedResult,
    resultPath: string,
  ): Promise<string> {
    const stdout = await this.readText(supervised.stdoutPath);
    const summary = extractClaudeSummary(stdout);
    await writeFile(resultPath, summary, "utf8");
    return summary;
  }

  protected override async collectUsage(
    supervised: SupervisedResult,
    _resultPath: string,
  ): Promise<UsageRecord | null> {
    return parseClaudeCliUsage(await this.readText(supervised.stdoutPath));
  }
}
