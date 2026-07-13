# SQLite state and migration reference

Agent Control Center Core uses two separate SQLite files with different APIs and migration policies:

1. `ACC_HOME/control-center.sqlite` is the local control-plane database used by CLI, daemon, coordinator, and MCP-backed operations.
2. `ACC_HOME/node/state.sqlite` is the optional ACCP node journal used only by `acc node connect`.

Do not copy a migration rule from one store to the other without accounting for these differences.

## 1. Local control database

### Runtime configuration

The control database uses the asynchronous `sqlite` wrapper with `sqlite3`. Initialization enables:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

The database contains these baseline tables:

- `tasks`
- `route_steps`
- `runs`
- `events`
- `artifacts`
- `messages`
- `reviews`
- `idempotency_keys`

SQLite is the durable source of truth. The in-process message bus is not a replacement for events stored here.

### Current versions

| `user_version` | Name | Change |
| ---: | --- | --- |
| 0 | legacy/unversioned | Tables may already exist from the bootstrap DDL, but the migration framework has not stamped them |
| 1 | `baseline` | Verifies all eight baseline tables exist; makes no schema change |
| 2 | `run-usage` | Adds nullable `runs.usage_json` for normalized provider usage |

A current binary supports schema version 2. If it sees a higher `user_version`, it throws `MigrationVersionError` before serving traffic. Downgrade-in-place is unsupported.

### Forward-only algorithm

Migrations are strictly ascending positive integers. For every pending migration the runner:

1. counts rows in every non-internal table;
2. when the on-disk database has user rows, creates a transactionally consistent snapshot under `ACC_HOME/backups/` using `VACUUM INTO` and requests file mode `0600`;
3. obtains a write lock with `BEGIN IMMEDIATE`;
4. re-reads `PRAGMA user_version` while holding the lock so concurrent daemon startup applies each migration once;
5. runs `up(db)`;
6. sets `PRAGMA user_version = N` inside the same transaction;
7. checks that no pre-existing table lost more rows than its declared `expectedRowDelta` permits;
8. commits, then requires `PRAGMA integrity_check` to return `ok`.

A thrown migration or row-loss violation rolls back schema/data and version together. An integrity failure after commit stops startup and points to the pre-migration backup. Empty/new databases are not backed up because they have no customer rows.

A migration that intentionally drops a table or rows MUST declare the minimum permitted delta for that table. The declaration is an audit escape hatch, not permission to omit an explicit data-preservation test.

### Adding a control-database migration

1. Add a new `src/migrations/NNN-name.ts` with the next positive version.
2. Keep it forward-only and deterministic; never branch on application traffic or remote state.
3. Add it in strict order to `CONTROL_CENTER_MIGRATIONS`.
4. Prefer additive nullable columns or create/backfill/swap patterns over destructive `ALTER` operations.
5. Declare `expectedRowDelta` for every intentional deletion/drop.
6. Test a fresh database, every supported previous version, a database with representative rows, a thrown mid-migration path, concurrent initialization, and a database newer than the binary.
7. Assert state-machine and foreign-key behavior after migration, not only table shape.
8. Verify backup creation and a documented restore drill.

Never edit an already released migration. A changed historical migration produces divergent databases that share a misleading version number.

### Backup and restore

Stop every ACC process that uses the same `ACC_HOME` before restoration. Preserve the failed database, WAL, and SHM files for diagnosis. Restore a verified `pre-vN-<timestamp>.sqlite` snapshot as the main database only while all writers are stopped, then start a binary whose newest known migration can safely advance that snapshot. Run application checks and `PRAGMA integrity_check` before resuming work.

Backups live on the same filesystem and are not a disaster-recovery system. Copy important snapshots to independently protected storage according to your own retention policy.

## 2. ACCP node journal

The node journal uses synchronous `node:sqlite` `DatabaseSync`, because a session write must commit before an envelope referencing it leaves the process. `SqliteNodeStateStore` is loaded lazily, so classic local CLI/daemon paths can still run on supported Node 20; the federation path requires a runtime that provides `node:sqlite` (use supported Node 22.13 or later).

The store enables WAL and currently has `PRAGMA user_version = 1` with four tables:

```sql
CREATE TABLE node_events (
  cursor INTEGER PRIMARY KEY,
  event_json TEXT NOT NULL
);
CREATE TABLE node_cursors (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE offer_answers (
  idem_key TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE truncations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_cursor INTEGER,
  to_cursor INTEGER,
  reason TEXT
);
```

`node_cursors` uses keys `node_cursor` and `acked_cursor`. The journal persists:

- ordered outbound node events;
- the highest allocated and acknowledged cursors;
- the exact accept/decline answer for every work-offer idempotency key;
- dropped cursor ranges and their `BUFFER_BYTES` or `BUFFER_AGE` reason.

Appending an event and advancing `node_cursor` happens in one `BEGIN IMMEDIATE` transaction. Acknowledged events can be pruned only after the contiguous ACK is durable.

### Node-journal version policy

Version 0 creates the version-1 schema in one transaction. Any version other than 1 is currently rejected. There is not yet a general backup/forward-migration runner for this file. A future schema change MUST add an ordered migration and backup path before raising the supported version; silently deleting `state.sqlite` would lose offer idempotency, cursors, and reconciliation evidence and could duplicate work.

Only one `NodeConnection` should own one node identity and journal at a time. WAL permits safe SQLite mechanics but does not provide semantic multi-process ownership of leases or the WebSocket session.

## 3. File permissions and operational checks

The daemon token/lease code actively validates POSIX mode and ownership. The two SQLite database files do not independently implement the same validation. Protect the entire `ACC_HOME` directory with OS-account permissions, exclude it from source control and sync tools, and use full-disk encryption where task evidence is sensitive.

Useful read-only inspection commands, with all ACC writers stopped when taking a stable snapshot, include:

```bash
sqlite3 .acc/control-center.sqlite 'PRAGMA user_version; PRAGMA integrity_check;'
sqlite3 .acc/node/state.sqlite 'PRAGMA user_version; PRAGMA integrity_check;'
```

Do not change `user_version` manually. It records completed migrations; it is not a repair command.
