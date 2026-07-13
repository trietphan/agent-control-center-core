import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifactEvidence } from "../src/artifacts.js";
import { createRuntime } from "../src/runtime.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demoRoot = join(root, ".demo");
const repo = join(demoRoot, "fixture-repository");
const home = join(demoRoot, "state");
const fixtureCli = join(root, "examples", "fixture-codex.mjs");

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=ACC Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { encoding: "utf8" },
  ).trim();
}

await rm(demoRoot, { recursive: true, force: true });
await mkdir(repo, { recursive: true });
await writeFile(join(repo, "README.md"), "# Deterministic fixture repository\n", "utf8");
await writeFile(
  join(repo, "verify.mjs"),
  [
    "import { readFile } from 'node:fs/promises';",
    "const value = (await readFile('STATUS.md', 'utf8')).trim();",
    "if (value !== 'OK') throw new Error(`Expected OK, received ${JSON.stringify(value)}`);",
    "console.log('verified: STATUS.md is exactly OK');",
  ].join("\n"),
  "utf8",
);
git("init", "-b", "main");
git("add", "README.md", "verify.mjs");
git("commit", "-m", "fixture baseline");
const sourceHead = git("rev-parse", "HEAD");
const sourceStatus = git("status", "--porcelain=v1");

const previous = {
  home: process.env.ACC_HOME,
  command: process.env.ACC_CODEX_COMMAND,
  args: process.env.ACC_CODEX_ARGS,
};
process.env.ACC_HOME = home;
process.env.ACC_CODEX_COMMAND = process.execPath;
process.env.ACC_CODEX_ARGS = JSON.stringify([fixtureCli]);

const runtime = await createRuntime({ workerId: "verified-outcome-demo" });
try {
  const availability = await runtime.adapters.get("codex")!.availability();
  assert.equal(availability.available, true);
  console.log("PASS fixture adapter ready");

  const created = await runtime.coordinator.createTask({
    goal: "Create STATUS.md whose entire content is exactly OK",
    repo,
    agent: "codex",
    priority: "normal",
    successCriteria: ["STATUS.md contains exactly OK"],
    verificationCommand: "node verify.mjs",
    handoffRequired: true,
  });
  const outcome = await runtime.coordinator.runNext();
  assert.ok(outcome);
  assert.equal(outcome.taskId, created.task.id);
  assert.equal(outcome.status, "needs-review");

  assert.equal(git("rev-parse", "HEAD"), sourceHead);
  assert.equal(git("status", "--porcelain=v1"), sourceStatus);
  console.log("PASS source checkout unchanged");

  const aggregate = await runtime.db.getTask(created.task.id);
  assert.ok(aggregate);
  const execute = aggregate.runs.find((run) => run.role === "execute");
  assert.ok(execute?.worktreePath);
  assert.equal(
    (await readFile(join(execute.worktreePath, "STATUS.md"), "utf8")).trim(),
    "OK",
  );
  console.log("PASS isolated worktree changed");

  assert.ok(aggregate.artifacts.some((artifact) => artifact.kind === "test-log"));
  console.log("PASS independent verification");
  for (const artifact of aggregate.artifacts) {
    await verifyArtifactEvidence(runtime.config.artifactsDir, artifact);
  }
  console.log(`PASS evidence hashes (${aggregate.artifacts.length} artifacts)`);

  const review = aggregate.reviews.find((item) => item.status === "pending");
  assert.ok(review);
  console.log(`WAITING review ${review.id} revision ${review.updatedAt}`);
  console.log("");
  console.log("Inspect and decide the exact evidence revision:");
  console.log(`ACC_HOME=${JSON.stringify(home)} npm run acc -- evidence verify ${created.task.id}`);
  console.log(
    `ACC_HOME=${JSON.stringify(home)} npm run acc -- review decide ${review.id} --decision approve --if-revision ${JSON.stringify(review.updatedAt)}`,
  );
} finally {
  await runtime.close();
  if (previous.home === undefined) delete process.env.ACC_HOME;
  else process.env.ACC_HOME = previous.home;
  if (previous.command === undefined) delete process.env.ACC_CODEX_COMMAND;
  else process.env.ACC_CODEX_COMMAND = previous.command;
  if (previous.args === undefined) delete process.env.ACC_CODEX_ARGS;
  else process.env.ACC_CODEX_ARGS = previous.args;
}
