import type { Migration } from "./runner.js";

/**
 * Every table created by ControlCenterDb.init() (src/db.ts). The baseline
 * asserts this exact shape so that stamping user_version = 1 is provably a
 * no-op adoption of the framework, never a schema change.
 */
export const BASELINE_TABLES = [
  "tasks",
  "route_steps",
  "runs",
  "events",
  "artifacts",
  "messages",
  "reviews",
  "idempotency_keys",
] as const;

/**
 * Migration 1 "baseline": adopt the migration framework on every existing
 * database. It changes NO schema;
 * the runner stamps user_version = 1 in the same transaction. The
 * schema-changing target migration (stages, leases, effects, protocol
 * inbox/outbox, widened status CHECKs, legacy backfill) ships with the relevant
 * as the next version; its full plan is specified in
 * docs/reference/node-sqlite-migrations.md.
 */
export const migration001Baseline: Migration = {
  version: 1,
  name: "baseline",
  async up(db) {
    for (const table of BASELINE_TABLES) {
      const row = await db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      );
      if (!row) {
        throw new Error(
          `Baseline migration expects table "${table}" to exist; ` +
            "this database was not initialized by ControlCenterDb.init()",
        );
      }
    }
  },
};
