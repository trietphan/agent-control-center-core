/**
 * Normalized provider usage extracted from real agent CLI output
 * Provider usage normalization. Parsers are
 * defensive by contract: any malformed, partial, or unexpected CLI output
 * yields null instead of throwing, because usage capture must never fail a
 * run that otherwise succeeded. Completed runs persist this record as
 * runs.usage_json (migration 002).
 */
export interface UsageRecord {
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  costUsdEstimate: number | null;
  source: "provider_reported" | "estimated";
  raw?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function parseJsonObjects(stdout: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record) objects.push(record);
  }
  if (objects.length === 0 && stdout.trim()) {
    // `--output-format json` may pretty-print a single object across lines.
    try {
      const record = asRecord(JSON.parse(stdout));
      if (record) objects.push(record);
    } catch {
      // Garbage input; the caller returns null.
    }
  }
  return objects;
}

/**
 * Claude CLI usage. `--output-format json` emits one result object and
 * `--output-format stream-json` (used by ClaudeAdapter) emits JSONL whose
 * final `type: "result"` event carries the same fields: `total_cost_usd`,
 * API-level token counts under `usage` (snake_case), and per-model
 * aggregates under `modelUsage` (camelCase). The last usage-bearing event
 * wins; token fields prefer `usage` and fall back to the first `modelUsage`
 * entry, which also names the model.
 */
export function parseClaudeCliUsage(stdout: string): UsageRecord | null {
  let event: Record<string, unknown> | null = null;
  for (const candidate of parseJsonObjects(stdout)) {
    if (
      asRecord(candidate.usage) ||
      asRecord(candidate.modelUsage) ||
      typeof candidate.total_cost_usd === "number"
    ) {
      event = candidate;
    }
  }
  if (!event) return null;
  const usage = asRecord(event.usage);
  const modelUsage = asRecord(event.modelUsage);
  const [modelName, perModelValue] =
    Object.entries(modelUsage ?? {})[0] ?? ([null, null] as const);
  const perModel = asRecord(perModelValue);
  const inputTokens =
    asNonNegativeNumber(usage?.input_tokens) ??
    asNonNegativeNumber(perModel?.inputTokens);
  const outputTokens =
    asNonNegativeNumber(usage?.output_tokens) ??
    asNonNegativeNumber(perModel?.outputTokens);
  const cacheReadTokens =
    asNonNegativeNumber(usage?.cache_read_input_tokens) ??
    asNonNegativeNumber(perModel?.cacheReadInputTokens);
  const costUsdEstimate =
    asNonNegativeNumber(event.total_cost_usd) ??
    asNonNegativeNumber(perModel?.costUSD);
  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    costUsdEstimate === null
  ) {
    return null;
  }
  return {
    provider: "claude",
    model: modelName,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsdEstimate,
    source: "provider_reported",
    raw: event,
  };
}

function codexTokenSource(
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const msg = asRecord(event.msg);
  if (msg?.type === "token_count") {
    const info = asRecord(msg.info);
    return asRecord(info?.total_token_usage) ?? msg;
  }
  if (event.type === "turn.completed") return asRecord(event.usage);
  return null;
}

/**
 * Codex CLI usage. `codex exec --json` emits JSONL events; format assumption
 * (from fixture knowledge of the codex CLI, not a live run): cumulative token
 * counts arrive on `token_count` events — flat
 * `{"msg":{"type":"token_count","input_tokens":...,"cached_input_tokens":...,
 * "output_tokens":...}}` or nested under `msg.info.total_token_usage` — or on
 * newer `{"type":"turn.completed","usage":{...}}` events. The last such event
 * wins. The model name is read from any event carrying a string `model`
 * (e.g. `session_configured`). Codex reports no dollar cost, so
 * costUsdEstimate stays null.
 */
export function parseCodexCliUsage(stdout: string): UsageRecord | null {
  let model: string | null = null;
  let tokens: Record<string, unknown> | null = null;
  let raw: Record<string, unknown> | null = null;
  for (const event of parseJsonObjects(stdout)) {
    const msg = asRecord(event.msg);
    const modelValue = msg?.model ?? event.model;
    if (typeof modelValue === "string" && modelValue) model = modelValue;
    const source = codexTokenSource(event);
    if (source) {
      tokens = source;
      raw = event;
    }
  }
  if (!tokens) return null;
  const inputTokens = asNonNegativeNumber(tokens.input_tokens);
  const outputTokens = asNonNegativeNumber(tokens.output_tokens);
  const cacheReadTokens = asNonNegativeNumber(tokens.cached_input_tokens);
  if (inputTokens === null && outputTokens === null && cacheReadTokens === null) {
    return null;
  }
  return {
    provider: "codex",
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costUsdEstimate: null,
    source: "provider_reported",
    raw,
  };
}
