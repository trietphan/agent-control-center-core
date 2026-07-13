import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactConflictError,
  ArtifactStore,
} from "../src/artifacts.js";

test("artifact paths are immutable while identical retries reuse their sidecar", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-artifact-immutable-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ home: join(root, "home") });
  const input = {
    taskId: "task_immutable",
    runId: "run_immutable",
    kind: "screenshot" as const,
    name: "browser.png",
    data: Buffer.from("first immutable evidence"),
  };

  const first = await store.write(input);
  const firstSidecar = await readFile(first.metadataPath, "utf8");
  const retry = await store.write(input);

  assert.deepEqual(retry, first);
  assert.equal(await readFile(first.path, "utf8"), "first immutable evidence");
  assert.equal(await readFile(first.metadataPath, "utf8"), firstSidecar);

  await assert.rejects(
    store.write({ ...input, data: Buffer.from("different evidence") }),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactConflictError);
      assert.match(error.message, /must be identical/);
      return true;
    },
  );
  assert.equal(await readFile(first.path, "utf8"), "first immutable evidence");
  assert.equal(await readFile(first.metadataPath, "utf8"), firstSidecar);
});

test("concurrent different writes cannot replace the winning artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-artifact-race-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ home: join(root, "home") });
  const common = {
    taskId: "task_race",
    runId: "run_race",
    kind: "result" as const,
    name: "result.txt",
  };
  const candidates = [Buffer.from("candidate one"), Buffer.from("candidate two")];

  const outcomes = await Promise.allSettled(
    candidates.map(async (data) => await store.write({ ...common, data })),
  );
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);

  const winner = outcomes.find(
    (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof store.write>>> =>
      outcome.status === "fulfilled",
  );
  assert.ok(winner);
  const bytes = await readFile(winner.value.path);
  assert.ok(candidates.some((candidate) => candidate.equals(bytes)));
  assert.equal(
    winner.value.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    await store.write({ ...common, data: bytes }),
    winner.value,
  );
});

test("adapter-created files can be adopted only when bytes are identical", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-artifact-adopt-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const store = new ArtifactStore({ home: join(root, "home") });
  const directory = await store.prepareRunDirectory("task_adapter", "run_adapter");
  const destination = join(directory, "codex.stdout.log");
  await writeFile(destination, "adapter output\n", { mode: 0o600 });

  const artifact = await store.writeText({
    taskId: "task_adapter",
    runId: "run_adapter",
    kind: "stdout",
    name: "codex.stdout.log",
    data: "adapter output\n",
  });
  assert.equal(await readFile(destination, "utf8"), "adapter output\n");
  assert.equal(
    artifact.sha256,
    createHash("sha256").update("adapter output\n").digest("hex"),
  );
});
