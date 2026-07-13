import { resolve } from "node:path";

export interface ControlCenterConfig {
  homeDir: string;
  databasePath: string;
  artifactsDir: string;
  worktreesDir: string;
  workerHeartbeatMs: number;
  workerStaleAfterMs: number;
}

function integerEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

export function loadConfig(cwd = process.cwd()): ControlCenterConfig {
  const homeDir = resolve(cwd, process.env.ACC_HOME?.trim() || ".acc");
  return {
    homeDir,
    databasePath: resolve(homeDir, "control-center.sqlite"),
    artifactsDir: resolve(homeDir, "artifacts"),
    worktreesDir: resolve(homeDir, "worktrees"),
    workerHeartbeatMs: integerEnv("ACC_WORKER_HEARTBEAT_MS", 15_000, 1_000),
    workerStaleAfterMs: integerEnv("ACC_WORKER_STALE_AFTER_MS", 5 * 60_000, 10_000),
  };
}

export function parseExtraArgs(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}
