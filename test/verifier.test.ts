import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifacts.js";
import {
  ProcessTaskVerifier,
  parseVerificationCommand,
} from "../src/verifier.js";

function commandLine(...argv: string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ");
}

test("verification command parsing produces argv without shell evaluation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-verifier-argv-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "must-not-exist");
  const script = join(root, "print-argv.mjs");
  await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  const injected = `$(touch ${sentinel})`;
  const parsed = parseVerificationCommand(
    commandLine(process.execPath, script, injected, "two words", ""),
  );
  assert.deepEqual(parsed, [process.execPath, script, injected, "two words", ""]);

  const verifier = new ProcessTaskVerifier({
    artifacts: new ArtifactStore({ home: join(root, "home") }),
  });
  let startedPid: number | null | undefined;
  const result = await verifier.run({
    taskId: "task_argv",
    runId: "run_argv",
    commandLine: commandLine(process.execPath, script, injected),
    workingDirectory: root,
    onStarted: async ({ pid }) => {
      startedPid = pid;
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(typeof startedPid, "number");
  await assert.rejects(access(sentinel));
  assert.match(await readFile(result.artifact.path, "utf8"), /\$\(touch/);
});

test("verifier captures stdout and stderr and reports a nonzero exit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-verifier-fail-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const script = join(root, "fail.mjs");
  await writeFile(
    script,
    "console.log('verification stdout'); console.error('verification stderr'); process.exit(7);\n",
    "utf8",
  );
  const verifier = new ProcessTaskVerifier({
    artifacts: new ArtifactStore({ home: join(root, "home") }),
  });
  const result = await verifier.run({
    taskId: "task_fail",
    runId: "run_fail",
    commandLine: commandLine(process.execPath, script),
    workingDirectory: root,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  const log = await readFile(result.artifact.path, "utf8");
  assert.match(log, /verification stdout/);
  assert.match(log, /verification stderr/);
  assert.match(log, /Status: failed/);
});

test("verifier enforces timeout and output caps", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acc-verifier-limits-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const timeoutScript = join(root, "timeout.mjs");
  await writeFile(timeoutScript, "setInterval(() => {}, 1000);\n", "utf8");
  const timeoutVerifier = new ProcessTaskVerifier({
    artifacts: new ArtifactStore({ home: join(root, "timeout-home") }),
    timeoutMs: 50,
  });
  const timedOut = await timeoutVerifier.run({
    taskId: "task_timeout",
    runId: "run_timeout",
    commandLine: commandLine(process.execPath, timeoutScript),
    workingDirectory: root,
  });
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error ?? "", /timed out/i);

  const outputScript = join(root, "output.mjs");
  await writeFile(outputScript, "process.stdout.write('x'.repeat(4096));\n", "utf8");
  const cappedVerifier = new ProcessTaskVerifier({
    artifacts: new ArtifactStore({ home: join(root, "output-home") }),
    maxOutputBytes: 128,
  });
  const capped = await cappedVerifier.run({
    taskId: "task_output",
    runId: "run_output",
    commandLine: commandLine(process.execPath, outputScript),
    workingDirectory: root,
  });
  assert.equal(capped.status, "failed");
  assert.match(capped.error ?? "", /maximum of 128 bytes/i);
});

test("verification parser rejects incomplete quoting", () => {
  assert.throws(() => parseVerificationCommand("node 'unterminated"), /unterminated/);
  assert.throws(() => parseVerificationCommand("node trailing\\"), /incomplete escape/);
});
