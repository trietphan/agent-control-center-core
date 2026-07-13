import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const checklist = readFileSync(
  resolve(root, "docs/legal-release-checklist.md"),
  "utf8",
);

function fail(message) {
  console.error(`npm publication blocked: ${message}`);
  process.exit(1);
}

if (process.env.ACC_PUBLICATION_APPROVED !== "true") {
  fail("ACC_PUBLICATION_APPROVED must be exactly true after every publication gate is recorded");
}

if (/^[\t ]*- \[ \]/mu.test(checklist)) {
  fail("docs/legal-release-checklist.md still contains unchecked gates");
}

const approvalRecord = process.env.ACC_PUBLIC_APPROVAL_RECORD?.trim() ?? "";
if (
  approvalRecord.length === 0 ||
  approvalRecord.length > 512 ||
  approvalRecord.includes("\n") ||
  approvalRecord.includes("\r")
) {
  fail("ACC_PUBLIC_APPROVAL_RECORD must identify the recorded approval in one line of at most 512 characters");
}

const approvedCommit = process.env.ACC_PUBLICATION_COMMIT?.trim() ?? "";
if (!/^[0-9a-f]{40}$/u.test(approvedCommit)) {
  fail("ACC_PUBLICATION_COMMIT must be the approved 40-character lowercase Git commit");
}

let currentCommit;
try {
  currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch {
  fail("the source directory must be a Git checkout at the approved commit");
}

if (currentCommit !== approvedCommit) {
  fail(`current commit ${currentCommit} does not match approved commit ${approvedCommit}`);
}

console.log(`npm publication approval accepted for ${approvalRecord} at ${currentCommit}`);
