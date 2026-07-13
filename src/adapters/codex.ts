import type { RouteRole } from "../protocol.js";
import { parseCodexCliUsage, type UsageRecord } from "../usage.js";
import { CliAdapter, type CliAdapterOptions } from "./cli-adapter.js";
import type { SupervisedResult } from "./process-supervisor.js";
import type { AdapterTaskRequest } from "./types.js";
import type { AdapterAvailability } from "./types.js";

export type CodexAdapterOptions = CliAdapterOptions;

export class CodexAdapter extends CliAdapter {
  readonly kind = "codex" as const;

  constructor(options: CodexAdapterOptions = {}) {
    super("codex", options);
  }

  override async availability(): Promise<AdapterAvailability> {
    const binary = await super.availability();
    if (!binary.available) return binary;
    const auth = await this.probe(["login", "status"]);
    return {
      ...binary,
      available: auth.available,
      reason: auth.available
        ? null
        : "Codex CLI is not authenticated; run `codex login`.",
    };
  }

  protected buildArguments(
    request: AdapterTaskRequest,
    role: RouteRole,
    resultPath: string,
  ): readonly string[] {
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      role === "execute" ? "workspace-write" : "read-only",
      "--cd",
      request.workingDirectory,
      "--output-last-message",
      resultPath,
      "-",
    ];
  }

  protected collectSummary(
    _supervised: SupervisedResult,
    resultPath: string,
  ): Promise<string> {
    return this.readText(resultPath);
  }

  protected override async collectUsage(
    supervised: SupervisedResult,
    _resultPath: string,
  ): Promise<UsageRecord | null> {
    return parseCodexCliUsage(await this.readText(supervised.stdoutPath));
  }
}
