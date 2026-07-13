import type { Migration } from "./runner.js";

/**
 * Migration 2 "run-usage": persist the normalized provider UsageRecord
 * (src/usage.ts) on completed runs, adding
 * F14 / action A14 (package COST-001, node side). Purely additive: one
 * nullable TEXT column on runs holding the serialized UsageRecord JSON.
 * Existing rows keep NULL; no data moves and no rows may be lost.
 */
export const migration002RunUsage: Migration = {
  version: 2,
  name: "run-usage",
  async up(db) {
    await db.exec("ALTER TABLE runs ADD COLUMN usage_json TEXT");
  },
};
