import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workingTreeOnly = process.argv.includes("--working-tree");
const help = process.argv.includes("--help") || process.argv.includes("-h");

if (help) {
  console.log(`Usage: node tooling/secret-scan.mjs [--working-tree]

Runs gitleaks with redaction enabled. The default scans all refs in Git history.
Use --working-tree only for a pre-export directory that does not have Git history.

Set GITLEAKS_BIN to an alternate gitleaks executable when necessary.`);
  process.exit(0);
}

const gitleaks = process.env.GITLEAKS_BIN?.trim() || "gitleaks";
const version = spawnSync(gitleaks, ["version"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (version.error?.code === "ENOENT") {
  console.error(
    "gitleaks is required. Install it from https://github.com/gitleaks/gitleaks, then rerun this command.",
  );
  process.exit(2);
}
if (version.status !== 0) {
  console.error(version.stderr || "Unable to execute gitleaks.");
  process.exit(version.status ?? 2);
}

if (!workingTreeOnly) {
  const git = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git.status !== 0 || git.stdout.trim() !== "true") {
    console.error(
      "History scan requires a Git repository. Initialize the reviewed export first, or explicitly use --working-tree.",
    );
    process.exit(2);
  }
}

const mode = workingTreeOnly ? "dir" : "git";
const modeArguments = workingTreeOnly ? [] : ["--log-opts=--all"];
const result = spawnSync(
  gitleaks,
  [mode, ...modeArguments, "--redact", "--no-banner", "--exit-code", "1", root],
  { cwd: root, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
process.exit(result.status ?? 2);
