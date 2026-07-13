import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireDaemonLease,
  bearerTokenMatches,
  DAEMON_BEARER_TOKEN_FILENAME,
  DAEMON_LEASE_FILENAME,
  DaemonLeaseHeldError,
  DaemonLeaseOwnershipError,
  loadBearerTokenFile,
  loadOrCreateBearerToken,
  secureTokenEquals,
} from "../src/daemon-lease.js";

async function fixture(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "acc-daemon-lease-"));
  t.after(async () => await rm(home, { recursive: true, force: true }));
  return home;
}

test("atomic daemon lease permits exactly one live owner", async (t) => {
  const home = await fixture(t);
  const first = await acquireDaemonLease(home);
  await assert.rejects(acquireDaemonLease(home), DaemonLeaseHeldError);

  await first.release();
  await first.release();
  const replacement = await acquireDaemonLease(home);
  assert.notEqual(replacement.record.instanceToken, first.record.instanceToken);
  await replacement.release();
});

test("daemon lease reclaims a stale PID", async (t) => {
  const home = await fixture(t);
  const leasePath = join(home, DAEMON_LEASE_FILENAME);
  const stale = {
    version: 1,
    pid: 2_147_483_000,
    instanceToken: "a".repeat(43),
    acquiredAt: new Date(0).toISOString(),
  };
  await writeFile(leasePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(leasePath, 0o600);

  const lease = await acquireDaemonLease(home);
  assert.equal(lease.record.pid, process.pid);
  assert.notEqual(lease.record.instanceToken, stale.instanceToken);
  assert.deepEqual(lease.reclaimed, stale);
  await lease.release();
});

test("lease release refuses to remove another instance token", async (t) => {
  const home = await fixture(t);
  const lease = await acquireDaemonLease(home);
  const replacement = {
    ...lease.record,
    instanceToken: "b".repeat(43),
  };
  await writeFile(lease.path, `${JSON.stringify(replacement)}\n`, "utf8");
  if (process.platform !== "win32") await chmod(lease.path, 0o600);

  await assert.rejects(lease.release(), DaemonLeaseOwnershipError);
  const persisted = JSON.parse(await readFile(lease.path, "utf8")) as {
    instanceToken: string;
  };
  assert.equal(persisted.instanceToken, replacement.instanceToken);
});

test("bearer token is stable, 256-bit, and private", async (t) => {
  const home = await fixture(t);
  const [first, second] = await Promise.all([
    loadOrCreateBearerToken(home),
    loadOrCreateBearerToken(home),
  ]);

  assert.equal(first.path, join(home, DAEMON_BEARER_TOKEN_FILENAME));
  assert.equal(second.token, first.token);
  assert.deepEqual(await loadBearerTokenFile(first.path), first);
  assert.equal(Buffer.from(first.token, "base64url").byteLength, 32);
  if (process.platform !== "win32") {
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
  }
});

test("existing bearer token must retain secure permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not portable to Windows");
    return;
  }
  const home = await fixture(t);
  const created = await loadOrCreateBearerToken(home);
  await chmod(created.path, 0o644);
  await assert.rejects(
    loadOrCreateBearerToken(home),
    /must have mode 0600/,
  );
});

test("bearer authorization uses strict constant-time token comparison", async (t) => {
  const home = await fixture(t);
  const { token } = await loadOrCreateBearerToken(home);

  assert.equal(secureTokenEquals(token, token), true);
  assert.equal(secureTokenEquals(token, `${token}x`), false);
  assert.equal(bearerTokenMatches(token, `Bearer ${token}`), true);
  assert.equal(bearerTokenMatches(token, `bearer ${token}`), true);
  assert.equal(bearerTokenMatches(token, `Bearer ${token} extra`), false);
  assert.equal(bearerTokenMatches(token, "Basic abc"), false);
  assert.equal(bearerTokenMatches(token, undefined), false);
});
