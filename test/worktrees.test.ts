import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifacts.js";
import { WorktreeManager } from "../src/worktrees.js";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function createRepository(root: string, name = "source repo"): Promise<string> {
  const repo = path.join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "--initial-branch=main", "."]);
  git(repo, ["config", "user.name", "ACC Test"]);
  git(repo, ["config", "user.email", "acc-test@example.com"]);
  await writeFile(path.join(repo, "README.md"), "# fixture\n", "utf8");
  git(repo, ["add", "--all"]);
  git(repo, ["-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  return repo;
}

test("creates unique isolated worktrees under ACC_HOME and preserves them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-worktree-create-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = await createRepository(root, "source repo ; shell chars");
  const home = path.join(root, "acc home");
  const manager = new WorktreeManager({ home });

  // A repository hook would create this sentinel if worktree creation ran hooks.
  const hookSentinel = path.join(root, "post-checkout-ran");
  const hook = path.join(repo, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\ntouch "${hookSentinel}"\n`, "utf8");
  await chmod(hook, 0o755);

  const first = await manager.create({
    taskId: "task_123",
    runId: "run_abc",
    repo,
    baseRef: "HEAD",
  });
  const second = await manager.create({
    taskId: "task_123",
    runId: "run_abc",
    repo,
    baseRef: "HEAD",
  });

  const realHome = await import("node:fs/promises").then(({ realpath }) => realpath(home));
  assert.equal(first.preserved, true);
  assert.equal(second.preserved, true);
  assert.notEqual(first.worktreePath, second.worktreePath);
  assert.notEqual(first.branch, second.branch);
  assert.ok(first.worktreePath.startsWith(`${path.join(realHome, "worktrees")}${path.sep}`));
  assert.equal(first.baseCommit, git(repo, ["rev-parse", "HEAD"]).trim());
  assert.equal(git(first.worktreePath, ["branch", "--show-current"]).trim(), first.branch);
  assert.equal(git(repo, ["status", "--porcelain=v1"]).trim(), "");
  await access(path.join(first.worktreePath, "README.md"));
  await assert.rejects(access(hookSentinel));

  // The manager deliberately leaves successful worktrees in place for review.
  assert.equal((await stat(first.worktreePath)).isDirectory(), true);
});

test("refuses a dirty source repository before allocating a worktree", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-worktree-dirty-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = await createRepository(root);
  await writeFile(path.join(repo, "uncommitted.txt"), "dirty\n", "utf8");
  const manager = new WorktreeManager({ home: path.join(root, "acc") });

  await assert.rejects(
    manager.create({ taskId: "task_dirty", runId: "run_dirty", repo }),
    /must be clean.*uncommitted\.txt/is,
  );
});

test("passes revisions as argv and never evaluates shell syntax", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-worktree-argv-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = await createRepository(root);
  const sentinel = path.join(root, "shell-was-evaluated");
  const manager = new WorktreeManager({ home: path.join(root, "acc") });

  await assert.rejects(
    manager.create({
      taskId: "task_safe",
      runId: "run_safe",
      repo,
      baseRef: `HEAD; touch ${sentinel}`,
    }),
    /does not resolve to a commit/,
  );
  await assert.rejects(access(sentinel));
  await assert.rejects(
    manager.create({ taskId: "../escape", runId: "run_safe", repo }),
    /taskId must contain only/,
  );
});

test("captures review git state and stores atomic hash-addressed metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "acc-worktree-capture-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const repo = await createRepository(root);
  const home = path.join(root, "acc");
  const manager = new WorktreeManager({ home });
  const worktree = await manager.create({
    taskId: "task_capture",
    runId: "run_capture",
    repo,
  });

  await writeFile(path.join(worktree.worktreePath, "README.md"), "# committed fixture\n", "utf8");
  git(worktree.worktreePath, ["add", "README.md"]);
  git(worktree.worktreePath, [
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "worktree commit",
  ]);
  await writeFile(
    path.join(worktree.worktreePath, "README.md"),
    "# committed fixture\nworking tree change\n",
    "utf8",
  );
  await writeFile(path.join(worktree.worktreePath, "untracked.txt"), "new file\n", "utf8");
  await writeFile(
    path.join(worktree.worktreePath, "untracked.bin"),
    Buffer.from([0, 1, 2, 3, 0, 255, 128, 64]),
  );

  const store = new ArtifactStore({ home });
  const captured = await manager.captureReviewArtifacts({
    taskId: worktree.taskId,
    runId: worktree.runId,
    worktreePath: worktree.worktreePath,
    baseCommit: worktree.baseCommit,
    store,
  });

  assert.notEqual(captured.snapshot.head, worktree.baseCommit);
  assert.equal(captured.snapshot.baseCommit, worktree.baseCommit);
  assert.equal(captured.snapshot.branch, worktree.branch);
  assert.match(captured.snapshot.status, / M README\.md/);
  assert.match(captured.snapshot.status, /\?\? untracked\.txt/);
  assert.match(captured.snapshot.diff, /committed fixture/);
  assert.match(captured.snapshot.diff, /working tree change/);
  assert.match(captured.snapshot.diff, /new file/);
  assert.match(captured.snapshot.diff, /untracked\.txt/);
  assert.match(captured.snapshot.diff, /untracked\.bin/);
  assert.match(captured.snapshot.diff, /GIT binary patch/);
  assert.match(captured.snapshot.stat, /README\.md/);
  assert.match(captured.snapshot.stat, /untracked\.txt/);
  assert.match(captured.snapshot.commits, /worktree commit/);
  assert.match(
    await readFile(captured.artifacts.commits.path, "utf8"),
    /worktree commit/,
  );

  for (const artifact of Object.values(captured.artifacts)) {
    const bytes = await readFile(artifact.path);
    assert.equal(artifact.sizeBytes, bytes.byteLength);
    assert.equal(
      artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const sidecar = JSON.parse(await readFile(artifact.metadataPath, "utf8")) as {
      sha256: string;
      sizeBytes: number;
    };
    assert.equal(sidecar.sha256, artifact.sha256);
    assert.equal(sidecar.sizeBytes, artifact.sizeBytes);
  }

  await assert.rejects(
    store.writeText({
      taskId: worktree.taskId,
      runId: worktree.runId,
      kind: "result",
      name: "../outside.txt",
      data: "nope",
    }),
    /artifact name must contain only/,
  );
  assert.equal((await stat(worktree.worktreePath)).isDirectory(), true);
});
