import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  ArtifactStore,
  assertSafePathSegment,
  resolveAccHome,
  type ArtifactMetadata,
} from "./artifacts.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

export class ProcessExecutionError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    message: string;
    command: string;
    args: readonly string[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }) {
    super(input.message);
    this.name = "ProcessExecutionError";
    this.command = input.command;
    this.args = input.args;
    this.exitCode = input.exitCode;
    this.signal = input.signal;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

/** Execute an argv vector directly. No input is ever evaluated by a shell. */
async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failureReason: string | undefined;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const stop = (reason: string) => {
      failureReason ??= reason;
      child.kill("SIGTERM");
      if (!forceKill) {
        forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
        forceKill.unref();
      }
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        stop(`Process output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    const timeout = setTimeout(
      () => stop(`Process timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
    timeout.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(
        new ProcessExecutionError({
          message: `Could not start ${command}: ${error.message}`,
          command,
          args,
          exitCode: null,
          signal: null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (exitCode === 0 && !failureReason) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      reject(
        new ProcessExecutionError({
          message:
            failureReason ??
            `${command} exited with ${exitCode ?? signal ?? "unknown status"}: ${stderrText.trim() || stdoutText.trim()}`,
          command,
          args,
          exitCode,
          signal,
          stdout: stdoutText,
          stderr: stderrText,
        }),
      );
    });
  });
}

export interface WorktreeManagerOptions {
  home?: string;
  gitBinary?: string;
  timeoutMs?: number;
}

export interface CreateWorktreeInput {
  taskId: string;
  runId: string;
  repo: string;
  baseRef?: string;
}

export interface WorktreeInfo {
  taskId: string;
  runId: string;
  sourceRepo: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  createdAt: string;
  preserved: true;
}

export interface SourceRepositorySnapshot {
  repo: string;
  head: string;
  status: string;
  capturedAt: string;
}

export interface GitSnapshot {
  worktreePath: string;
  head: string;
  baseCommit: string;
  branch: string | null;
  status: string;
  diff: string;
  stat: string;
  commits: string;
  capturedAt: string;
}

export interface ReviewArtifactSet {
  snapshot: GitSnapshot;
  artifacts: {
    status: ArtifactMetadata;
    diff: ArtifactMetadata;
    commits: ArtifactMetadata;
    metadata: ArtifactMetadata;
  };
}

function branchSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "run";
}

function validateBaseRef(baseRef: string): string {
  const ref = baseRef.trim();
  if (
    !ref ||
    ref.length > 512 ||
    ref.startsWith("-") ||
    ref.includes("\0") ||
    ref.includes("\n") ||
    ref.includes("\r")
  ) {
    throw new Error("baseRef is not a safe git revision");
  }
  return ref;
}

export class WorktreeManager {
  readonly home: string;
  readonly gitBinary: string;
  readonly timeoutMs: number;

  constructor(options: WorktreeManagerOptions = {}) {
    this.home = resolveAccHome(options.home);
    this.gitBinary = options.gitBinary ?? "git";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async git(repo: string, args: readonly string[]): Promise<ProcessResult> {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    return await runProcess(
      this.gitBinary,
      ["-c", `core.hooksPath=${nullDevice}`, "-C", repo, ...args],
      { timeoutMs: this.timeoutMs },
    );
  }

  private async gitDifference(
    repo: string,
    args: readonly string[],
  ): Promise<ProcessResult> {
    try {
      return await this.git(repo, args);
    } catch (error) {
      // `git diff --no-index` uses exit 1 to mean "files differ".
      if (error instanceof ProcessExecutionError && error.exitCode === 1) {
        return { stdout: error.stdout, stderr: error.stderr };
      }
      throw error;
    }
  }

  async validateRepository(repo: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(repo));
    } catch {
      throw new Error(`Repository path does not exist: ${path.resolve(repo)}`);
    }
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`Repository path is not a directory: ${resolved}`);

    let topLevel: string;
    try {
      const inside = (
        await this.git(resolved, ["rev-parse", "--is-inside-work-tree"])
      ).stdout.trim();
      if (inside !== "true") throw new Error("not a work tree");
      topLevel = (
        await this.git(resolved, [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
        ])
      ).stdout.trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Repository path is not a non-bare git work tree: ${resolved} (${detail})`);
    }
    return await realpath(topLevel);
  }

  async captureSourceSnapshot(repo: string): Promise<SourceRepositorySnapshot> {
    const resolved = await this.validateRepository(repo);
    const [head, status] = await Promise.all([
      this.git(resolved, ["rev-parse", "--verify", "HEAD"]),
      this.git(resolved, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    if (status.stdout.trim()) {
      throw new Error(
        `Source repository must remain clean during isolated execution:\n${status.stdout.trim()}`,
      );
    }
    return {
      repo: resolved,
      head: head.stdout.trim(),
      status: status.stdout,
      capturedAt: new Date().toISOString(),
    };
  }

  async assertSourceUnchanged(snapshot: SourceRepositorySnapshot): Promise<void> {
    const resolved = await this.validateRepository(snapshot.repo);
    const [head, status] = await Promise.all([
      this.git(resolved, ["rev-parse", "--verify", "HEAD"]),
      this.git(resolved, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    const currentHead = head.stdout.trim();
    if (currentHead !== snapshot.head || status.stdout !== snapshot.status) {
      throw new Error(
        [
          "Isolation violation: the source checkout changed while the agent was assigned to a worktree.",
          `Expected HEAD: ${snapshot.head}`,
          `Current HEAD: ${currentHead}`,
          `Source status: ${status.stdout.trim() || "clean"}`,
        ].join("\n"),
      );
    }
  }

  private async assertClean(repo: string): Promise<void> {
    const statusResult = await this.git(repo, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (statusResult.stdout.trim()) {
      throw new Error(
        `Source repository must be clean before creating a worktree:\n${statusResult.stdout.trim()}`,
      );
    }
  }

  private async resolveCommit(repo: string, baseRef: string): Promise<string> {
    let result: ProcessResult;
    try {
      result = await this.git(repo, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${baseRef}^{commit}`,
      ]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`baseRef does not resolve to a commit: ${baseRef} (${detail})`);
    }
    const commit = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error(`Git returned an invalid commit id for ${baseRef}`);
    }
    return commit;
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeInfo> {
    const taskId = assertSafePathSegment(input.taskId, "taskId");
    const runId = assertSafePathSegment(input.runId, "runId");
    const baseRef = validateBaseRef(input.baseRef ?? "HEAD");
    const sourceRepo = await this.validateRepository(input.repo);
    await this.assertClean(sourceRepo);
    const baseCommit = await this.resolveCommit(sourceRepo, baseRef);

    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const realHome = await realpath(this.home);
    const requestedWorktreeRoot = path.join(realHome, "worktrees");
    await mkdir(requestedWorktreeRoot, { recursive: true, mode: 0o700 });
    const worktreeRoot = await realpath(requestedWorktreeRoot);
    const rootRelative = path.relative(realHome, worktreeRoot);
    if (
      rootRelative === "" ||
      rootRelative === ".." ||
      rootRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rootRelative)
    ) {
      throw new Error("ACC_HOME worktrees directory resolves outside ACC_HOME");
    }
    const requestedTaskRoot = path.join(worktreeRoot, taskId);
    await mkdir(requestedTaskRoot, { recursive: true, mode: 0o700 });
    const taskRoot = await realpath(requestedTaskRoot);
    const taskRelative = path.relative(worktreeRoot, taskRoot);
    if (
      taskRelative === "" ||
      taskRelative === ".." ||
      taskRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(taskRelative)
    ) {
      throw new Error("Task worktree directory resolves outside ACC_HOME");
    }

    // Creating ACC_HOME inside the source repo can itself make the repo dirty.
    // Recheck after preparing directories and refuse unless the path is ignored.
    await this.assertClean(sourceRepo);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const worktreePath = path.join(taskRoot, `${runId}-${suffix}`);
    const relative = path.relative(worktreeRoot, worktreePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Worktree path escapes ACC_HOME");
    }
    const branch = `acc/${branchSegment(taskId)}/${branchSegment(runId)}-${suffix}`;
    await this.git(sourceRepo, ["check-ref-format", "--branch", branch]);
    await this.git(sourceRepo, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      worktreePath,
      baseCommit,
    ]);

    const createdPath = await realpath(worktreePath);
    const createdHead = (
      await this.git(createdPath, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim();
    if (createdHead !== baseCommit) {
      throw new Error(
        `Created worktree HEAD ${createdHead} does not match requested base ${baseCommit}`,
      );
    }

    return {
      taskId,
      runId,
      sourceRepo,
      worktreePath: createdPath,
      branch,
      baseRef,
      baseCommit,
      createdAt: new Date().toISOString(),
      preserved: true,
    };
  }

  private async captureUntracked(repo: string): Promise<{
    diff: string;
    stat: string;
  }> {
    const listed = await this.git(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const files = listed.stdout.split("\0").filter(Boolean);
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const patches: string[] = [];
    const stats: string[] = [];
    for (const file of files) {
      const [patchResult, statResult] = await Promise.all([
        this.gitDifference(repo, [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-index",
          "--",
          nullDevice,
          file,
        ]),
        this.gitDifference(repo, [
          "diff",
          "--stat",
          "--no-ext-diff",
          "--no-index",
          "--",
          nullDevice,
          file,
        ]),
      ]);
      if (patchResult.stdout) patches.push(patchResult.stdout);
      if (statResult.stdout) stats.push(statResult.stdout);
    }
    return { diff: patches.join("\n"), stat: stats.join("\n") };
  }

  async capture(worktreePath: string, baseCommit?: string): Promise<GitSnapshot> {
    const repo = await this.validateRepository(worktreePath);
    const requestedBase = validateBaseRef(baseCommit ?? "HEAD");
    const resolvedBase = await this.resolveCommit(repo, requestedBase);
    const [headResult, statusResult, diffResult, statResult, commitsResult] = await Promise.all([
      this.git(repo, ["rev-parse", "--verify", "HEAD"]),
      this.git(repo, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]),
      this.git(repo, ["diff", "--binary", "--no-ext-diff", resolvedBase, "--"]),
      this.git(repo, ["diff", "--stat", "--no-ext-diff", resolvedBase, "--"]),
      this.git(repo, [
        "log",
        "--format=%H%x09%an%x09%aI%x09%s",
        `${resolvedBase}..HEAD`,
        "--",
      ]),
    ]);
    const untracked = await this.captureUntracked(repo);
    let branch: string | null = null;
    try {
      branch = (
        await this.git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      ).stdout.trim() || null;
    } catch (error) {
      if (!(error instanceof ProcessExecutionError && error.exitCode === 1)) throw error;
    }
    return {
      worktreePath: repo,
      head: headResult.stdout.trim(),
      baseCommit: resolvedBase,
      branch,
      status: statusResult.stdout,
      diff: [diffResult.stdout, untracked.diff].filter(Boolean).join("\n"),
      stat: [statResult.stdout, untracked.stat].filter(Boolean).join("\n"),
      commits: commitsResult.stdout,
      capturedAt: new Date().toISOString(),
    };
  }

  async captureReviewArtifacts(input: {
    taskId: string;
    runId: string;
    worktreePath: string;
    baseCommit?: string;
    store?: ArtifactStore;
  }): Promise<ReviewArtifactSet> {
    const snapshot = await this.capture(input.worktreePath, input.baseCommit);
    const store = input.store ?? new ArtifactStore({ home: this.home });
    const status = await store.writeText({
      taskId: input.taskId,
      runId: input.runId,
      kind: "git-status",
      name: "git-status.txt",
      data: snapshot.status,
    });
    const diff = await store.writeText({
      taskId: input.taskId,
      runId: input.runId,
      kind: "diff",
      name: "diff.patch",
      data: snapshot.diff,
    });
    const commits = await store.writeText({
      taskId: input.taskId,
      runId: input.runId,
      kind: "commit",
      name: "commits.txt",
      data: snapshot.commits,
    });
    const metadata = await store.writeJson({
      taskId: input.taskId,
      runId: input.runId,
      kind: "metadata",
      name: "git-metadata.json",
      data: {
        worktreePath: snapshot.worktreePath,
        head: snapshot.head,
        baseCommit: snapshot.baseCommit,
        branch: snapshot.branch,
        stat: snapshot.stat,
        capturedAt: snapshot.capturedAt,
      },
    });
    return { snapshot, artifacts: { status, diff, commits, metadata } };
  }

  // Intentionally no automatic remove: successful worktrees stay available for review.
}

export async function createIsolatedWorktree(
  input: CreateWorktreeInput,
  options: WorktreeManagerOptions = {},
): Promise<WorktreeInfo> {
  return await new WorktreeManager(options).create(input);
}

export async function captureGitState(
  worktreePath: string,
  options: WorktreeManagerOptions & { baseCommit?: string } = {},
): Promise<GitSnapshot> {
  return await new WorktreeManager(options).capture(worktreePath, options.baseCommit);
}
