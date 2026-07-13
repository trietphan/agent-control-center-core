import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { ControlCenterDb } from "../src/db.js";
import { TaskPayloadSchema } from "../src/protocol.js";
import { routeTask } from "../src/router.js";
import {
  MigrationIntegrityError,
  MigrationVersionError,
  runMigrations,
  type Migration,
} from "../src/migrations/runner.js";
import { migration001Baseline } from "../src/migrations/001-baseline.js";
import { migration002RunUsage } from "../src/migrations/002-run-usage.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "acc-migrations-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const filename = join(root, "control-center.sqlite");
  return { root, filename };
}

async function openRaw(filename: string) {
  const db = await open<sqlite3.Database, sqlite3.Statement>({
    filename,
    driver: sqlite3.Database,
  });
  await db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

async function userVersion(filename: string): Promise<number> {
  const db = await openRaw(filename);
  try {
    const row = await db.get<{ user_version: number }>("PRAGMA user_version");
    return row?.user_version ?? -1;
  } finally {
    await db.close();
  }
}

async function backupNames(root: string): Promise<string[]> {
  return await readdir(join(root, "backups")).catch(() => []);
}

function payload(id: string) {
  return TaskPayloadSchema.parse({
    id,
    goal: "Fix the login bug",
    repo: "/tmp/example-repo",
    agent: "auto",
    priority: "high",
    successCriteria: ["tests pass"],
  });
}

async function seededDatabase(t: test.TestContext) {
  const { root, filename } = await fixture(t);
  const db = new ControlCenterDb(filename);
  await db.init();
  const taskInput = payload("task_migration_seed");
  await db.createTask(taskInput, routeTask(taskInput));
  await db.close();
  return { root, filename };
}

test("fresh database adopts every migration: user_version 2, no backup", async (t) => {
  const { root, filename } = await fixture(t);
  const db = new ControlCenterDb(filename);
  await db.init();
  await db.close();
  assert.equal(await userVersion(filename), 2);
  assert.deepEqual(await backupNames(root), []);
});

test("reopening an adopted database is a no-op without duplicate backups", async (t) => {
  const { root, filename } = await seededDatabase(t);
  const reopened = new ControlCenterDb(filename);
  await reopened.init();
  assert.equal((await reopened.listTasks()).length, 1);
  await reopened.close();
  assert.equal(await userVersion(filename), 2);
  assert.deepEqual(await backupNames(root), []);

  const raw = await openRaw(filename);
  t.after(async () => await raw.close());
  const result = await runMigrations(raw, {
    accHome: root,
    databasePath: filename,
    migrations: [migration001Baseline, migration002RunUsage],
  });
  assert.deepEqual(result, {
    fromVersion: 2,
    toVersion: 2,
    appliedVersions: [],
    backupPaths: [],
  });
  assert.deepEqual(await backupNames(root), []);
});

test("a database stamped by a newer binary fails closed", async (t) => {
  const { root, filename } = await seededDatabase(t);
  const raw = await openRaw(filename);
  await raw.exec("PRAGMA user_version = 99");
  await raw.close();

  const db = new ControlCenterDb(filename);
  await assert.rejects(db.init(), (error: unknown) => {
    assert.ok(error instanceof MigrationVersionError);
    assert.equal(error.databaseVersion, 99);
    assert.equal(error.newestKnownVersion, 2);
    return true;
  });
  // Fail closed means nothing was migrated, backed up, or rewritten.
  assert.equal(await userVersion(filename), 99);
  assert.deepEqual(await backupNames(root), []);
});

test("a newer blank database fails before bootstrap DDL", async (t) => {
  const { root, filename } = await fixture(t);
  const raw = await openRaw(filename);
  await raw.exec("PRAGMA user_version = 99");
  await raw.close();

  const db = new ControlCenterDb(filename);
  await assert.rejects(db.init(), MigrationVersionError);

  const inspected = await openRaw(filename);
  t.after(async () => await inspected.close());
  const tables = await inspected.all<Array<{ name: string }>>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  );
  assert.deepEqual(tables, []);
  assert.equal(
    (
      await inspected.get<{ user_version: number }>("PRAGMA user_version")
    )?.user_version,
    99,
  );
  assert.deepEqual(await backupNames(root), []);
});

test("migration runner rechecks a newer version after taking its write lock", async (t) => {
  const { root, filename } = await seededDatabase(t);
  const raw = await openRaw(filename);
  t.after(async () => await raw.close());
  const competing = await openRaw(filename);
  t.after(async () => await competing.close());
  let interceptedBegin = false;
  const lockedView = {
    all: raw.all.bind(raw),
    get: raw.get.bind(raw),
    run: raw.run.bind(raw),
    exec: async (sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && !interceptedBegin) {
        interceptedBegin = true;
        await competing.exec("PRAGMA user_version = 99");
      }
      return await raw.exec(sql);
    },
  } as Parameters<typeof runMigrations>[0];
  const additive: Migration = {
    version: 3,
    name: "must-not-run",
    async up(db) {
      await db.exec("CREATE TABLE should_not_exist (id TEXT PRIMARY KEY)");
    },
  };

  await assert.rejects(
    runMigrations(lockedView, {
      accHome: root,
      migrations: [migration001Baseline, migration002RunUsage, additive],
    }),
    (error: unknown) => {
      assert.ok(error instanceof MigrationVersionError);
      assert.equal(error.databaseVersion, 99);
      assert.equal(error.newestKnownVersion, 3);
      return true;
    },
  );
  assert.equal(interceptedBegin, true);
  assert.equal(
    await raw.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_not_exist'",
    ),
    undefined,
  );
  assert.equal(await userVersion(filename), 99);
});

test("a migration that throws mid-transaction rolls back completely", async (t) => {
  const { root, filename } = await seededDatabase(t);
  const failing: Migration = {
    version: 3,
    name: "boom",
    async up(db) {
      await db.exec("CREATE TABLE junk (id TEXT PRIMARY KEY)");
      await db.run("INSERT INTO junk (id) VALUES ('half-applied')");
      throw new Error("boom mid-transaction");
    },
  };
  const raw = await openRaw(filename);
  await assert.rejects(
    runMigrations(raw, {
      accHome: root,
      databasePath: filename,
      migrations: [migration001Baseline, migration002RunUsage, failing],
    }),
    /boom mid-transaction/,
  );
  const junk = await raw.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'junk'",
  );
  assert.equal(junk, undefined);
  const integrity = await raw.get<{ integrity_check: string }>(
    "PRAGMA integrity_check",
  );
  assert.equal(integrity?.integrity_check, "ok");
  await raw.close();
  assert.equal(await userVersion(filename), 2);

  // The database stays openable and intact for the previous binary.
  const reopened = new ControlCenterDb(filename);
  await reopened.init();
  assert.equal((await reopened.listTasks()).length, 1);
  await reopened.close();
});

test("upgrading a non-empty database writes a consistent pre-migration backup", async (t) => {
  const { root, filename } = await seededDatabase(t);
  const additive: Migration = {
    version: 3,
    name: "add-widgets",
    async up(db) {
      await db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY)");
    },
  };
  const raw = await openRaw(filename);
  const result = await runMigrations(raw, {
    accHome: root,
    databasePath: filename,
    migrations: [migration001Baseline, migration002RunUsage, additive],
  });
  await raw.close();
  assert.equal(result.fromVersion, 2);
  assert.equal(result.toVersion, 3);
  assert.deepEqual(result.appliedVersions, [3]);
  assert.equal(await userVersion(filename), 3);

  const names = await backupNames(root);
  assert.equal(names.length, 1);
  assert.match(names[0]!, /^pre-v3-.+\.sqlite$/u);
  assert.deepEqual(result.backupPaths, [join(root, "backups", names[0]!)]);
  assert.ok((await stat(result.backupPaths[0]!)).size > 0);

  // The backup is a pre-migration snapshot: it opens, holds the data, and
  // does not contain the new table or version stamp.
  const backup = await openRaw(result.backupPaths[0]!);
  t.after(async () => await backup.close());
  const tasks = await backup.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks");
  assert.equal(tasks?.n, 1);
  const widgets = await backup.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets'",
  );
  assert.equal(widgets, undefined);
  const version = await backup.get<{ user_version: number }>("PRAGMA user_version");
  assert.equal(version?.user_version, 2);
});

test("undeclared row loss rolls back; a declared expectedRowDelta admits it", async (t) => {
  const { root, filename } = await seededDatabase(t);
  const destructive: Migration = {
    version: 3,
    name: "drop-task-rows",
    async up(db) {
      await db.run("DELETE FROM tasks");
    },
  };
  const raw = await openRaw(filename);
  t.after(async () => await raw.close());
  await assert.rejects(
    runMigrations(raw, {
      accHome: root,
      databasePath: filename,
      migrations: [migration001Baseline, migration002RunUsage, destructive],
    }),
    (error: unknown) => error instanceof MigrationIntegrityError,
  );
  assert.equal(
    (await raw.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks"))?.n,
    1,
  );
  assert.equal(await userVersion(filename), 2);

  const declared = await runMigrations(raw, {
    accHome: root,
    databasePath: filename,
    migrations: [
      migration001Baseline,
      migration002RunUsage,
      { ...destructive, expectedRowDelta: { tasks: -1, route_steps: -1, events: -1 } },
    ],
  });
  assert.deepEqual(declared.appliedVersions, [3]);
  assert.equal(await userVersion(filename), 3);
});
