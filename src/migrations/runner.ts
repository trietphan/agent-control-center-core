import { chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type sqlite3 from "sqlite3";
import type { Database } from "sqlite";

type SqliteDb = Database<sqlite3.Database, sqlite3.Statement>;

/**
 * Forward-only, PRAGMA user_version driven SQLite migration runner.
 *
 * Public contract details: docs/reference/node-sqlite-migrations.md.
 *
 * Precedent: Android SQLiteOpenHelper/Room drive schema evolution with the
 * same user_version + ordered forward migration list in production on
 * billions of devices.
 */
export interface Migration {
  /** Strictly ascending positive integer; becomes user_version on commit. */
  version: number;
  name: string;
  /**
   * Minimum permitted net row-count change per table (default 0 for every
   * pre-existing table, i.e. no rows may be lost). Declare a negative value
   * for tables where the migration intentionally removes rows, or any value
   * to exempt a table the migration drops.
   */
  expectedRowDelta?: Record<string, number>;
  up(db: SqliteDb): Promise<void>;
}

export interface RunMigrationsOptions {
  /** ACC home directory; pre-migration backups land in <accHome>/backups. */
  accHome: string;
  /** Ordered array of every migration this binary knows. */
  migrations: Migration[];
  /**
   * Absolute path of the on-disk database file. Omit for in-memory
   * databases; omitting disables pre-migration file backups.
   */
  databasePath?: string;
}

export interface MigrationRunResult {
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
  backupPaths: string[];
}

/**
 * The database was written by a newer binary. The daemon must fail closed
 * and never open (or write to) a schema it does not understand
 * Fail closed on downgrade.
 */
export class MigrationVersionError extends Error {
  readonly databaseVersion: number;
  readonly newestKnownVersion: number;

  constructor(databaseVersion: number, newestKnownVersion: number) {
    super(
      `Database schema version ${databaseVersion} is newer than the newest ` +
        `known migration ${newestKnownVersion}; refusing to open. ` +
        "Upgrade the binary or restore the pre-migration backup.",
    );
    this.name = "MigrationVersionError";
    this.databaseVersion = databaseVersion;
    this.newestKnownVersion = newestKnownVersion;
  }
}

/** A post-migration sanity check failed; the daemon must not serve traffic. */
export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationIntegrityError";
  }
}

function assertMigrationList(migrations: Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new Error(
        `Migration version must be a positive integer: ${migration.version}`,
      );
    }
    if (migration.version <= previous) {
      throw new Error(
        `Migrations must be strictly ascending: ${migration.version} after ${previous}`,
      );
    }
    if (!migration.name.trim()) {
      throw new Error(`Migration ${migration.version} requires a name`);
    }
    previous = migration.version;
  }
}

async function readUserVersion(db: SqliteDb): Promise<number> {
  const row = await db.get<{ user_version: number }>("PRAGMA user_version");
  const version = row?.user_version ?? 0;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new MigrationIntegrityError(`Invalid user_version: ${String(version)}`);
  }
  return version;
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/gu, '""')}"`;
}

async function countAllTables(db: SqliteDb): Promise<Map<string, number>> {
  const tables = await db.all<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  );
  const counts = new Map<string, number>();
  for (const table of tables) {
    const row = await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table.name)}`,
    );
    counts.set(table.name, row?.n ?? 0);
  }
  return counts;
}

function assertNoRowsLost(
  before: Map<string, number>,
  after: Map<string, number>,
  migration: Migration,
): void {
  for (const [table, previousCount] of before) {
    const declared = migration.expectedRowDelta?.[table];
    const nextCount = after.get(table);
    if (nextCount === undefined) {
      if (declared !== undefined) continue;
      throw new MigrationIntegrityError(
        `Migration ${migration.version} (${migration.name}) dropped table ` +
          `${table} without declaring expectedRowDelta`,
      );
    }
    const minimum = previousCount + (declared ?? 0);
    if (nextCount < minimum) {
      throw new MigrationIntegrityError(
        `Migration ${migration.version} (${migration.name}) lost rows in ` +
          `${table}: ${previousCount} -> ${nextCount} ` +
          `(minimum permitted ${minimum})`,
      );
    }
  }
}

/**
 * Snapshot the database file before a migration touches it. Uses
 * `VACUUM INTO`, which produces a transactionally consistent copy even under
 * WAL (SQLite's documented online-backup statement), instead of copying the
 * raw file next to an active WAL.
 *
 * A database with zero user rows is treated as brand-new and not backed up:
 * init() creates the empty tables before migrations run, so file size alone
 * cannot distinguish a fresh database from customer data.
 */
async function backupDatabase(
  db: SqliteDb,
  version: number,
  preCounts: Map<string, number>,
  options: RunMigrationsOptions,
): Promise<string | null> {
  if (!options.databasePath) return null;
  const fileSize = await stat(options.databasePath)
    .then((info) => info.size)
    .catch(() => 0);
  if (fileSize === 0) return null;
  let totalRows = 0;
  for (const count of preCounts.values()) totalRows += count;
  if (totalRows === 0) return null;
  const backupsDir = join(options.accHome, "backups");
  await mkdir(backupsDir, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(backupsDir, `pre-v${version}-${timestamp}.sqlite`);
  await db.exec(`VACUUM INTO '${backupPath.replace(/'/gu, "''")}'`);
  await chmod(backupPath, 0o600).catch(() => undefined);
  return backupPath;
}

/**
 * Apply every pending migration, strictly forward, one transaction per
 * migration. `PRAGMA user_version = N` commits atomically with the
 * migration's schema/data changes, so a crash or thrown `up()` leaves both
 * the schema and the recorded version at the previous migration.
 *
 * Fail-closed rules:
 * - db version newer than the migration list -> MigrationVersionError;
 * - row loss beyond `expectedRowDelta` -> rollback + MigrationIntegrityError;
 * - post-commit `PRAGMA integrity_check` failure -> MigrationIntegrityError
 *   (the daemon must not serve; restore the pre-migration backup).
 */
export async function runMigrations(
  db: SqliteDb,
  options: RunMigrationsOptions,
): Promise<MigrationRunResult> {
  assertMigrationList(options.migrations);
  const newestKnown = options.migrations.at(-1)?.version ?? 0;
  const fromVersion = await readUserVersion(db);
  if (fromVersion > newestKnown) {
    throw new MigrationVersionError(fromVersion, newestKnown);
  }
  const result: MigrationRunResult = {
    fromVersion,
    toVersion: fromVersion,
    appliedVersions: [],
    backupPaths: [],
  };
  const pending = options.migrations.filter(
    (migration) => migration.version > fromVersion,
  );
  if (pending.length === 0) return result;

  let preCounts = await countAllTables(db);
  for (const migration of pending) {
    const backupPath = await backupDatabase(
      db,
      migration.version,
      preCounts,
      options,
    );
    if (backupPath) result.backupPaths.push(backupPath);
    let began = false;
    try {
      await db.exec("BEGIN IMMEDIATE");
      began = true;
      // Another process may have migrated between our version read and this
      // write lock; user_version is re-read under the lock so the migration
      // applies exactly once across concurrent daemons.
      const current = await readUserVersion(db);
      if (current > newestKnown) {
        throw new MigrationVersionError(current, newestKnown);
      }
      if (current >= migration.version) {
        await db.exec("ROLLBACK");
        began = false;
        result.toVersion = current;
        preCounts = await countAllTables(db);
        continue;
      }
      await migration.up(db);
      await db.exec(`PRAGMA user_version = ${migration.version}`);
      // Row-count sanity runs before COMMIT so a violation rolls the whole
      // migration back instead of persisting silent data loss.
      const postCounts = await countAllTables(db);
      assertNoRowsLost(preCounts, postCounts, migration);
      await db.exec("COMMIT");
      began = false;
      preCounts = postCounts;
    } catch (error) {
      if (began) await db.exec("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const integrity = await db.get<{ integrity_check: string }>(
      "PRAGMA integrity_check",
    );
    if (integrity?.integrity_check !== "ok") {
      throw new MigrationIntegrityError(
        `Database failed PRAGMA integrity_check after migration ` +
          `${migration.version} (${migration.name}): ` +
          `${integrity?.integrity_check ?? "no result"}. ` +
          (backupPath
            ? `Restore the pre-migration backup: ${backupPath}`
            : "No pre-migration backup exists (database had no rows)."),
      );
    }
    result.appliedVersions.push(migration.version);
    result.toVersion = migration.version;
  }
  return result;
}
