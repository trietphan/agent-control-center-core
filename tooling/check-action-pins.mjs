import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowsDirectory = join(root, ".github", "workflows");
const commitPin = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.\/-]+)?@[0-9a-f]{40}$/u;
const dockerDigest = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/u;

async function workflowFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await workflowFiles(path)));
    if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function displayPath(path) {
  return relative(root, path).split(sep).join("/");
}

const failures = [];
let remoteUses = 0;

for (const file of await workflowFiles(workflowsDirectory)) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (/^\s*#/u.test(line)) continue;
    const match = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)["']?(?:\s+#.*)?$/u);
    if (!match) continue;

    const reference = match[1];
    if (reference.startsWith("./")) continue;
    remoteUses += 1;

    if (reference.startsWith("docker://")) {
      if (!dockerDigest.test(reference)) {
        failures.push(
          `${displayPath(file)}:${index + 1}: Docker action must use an immutable sha256 digest: ${reference}`,
        );
      }
      continue;
    }

    if (!commitPin.test(reference)) {
      failures.push(
        `${displayPath(file)}:${index + 1}: action must use a full lowercase 40-character commit SHA: ${reference}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Action pin policy failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`action-pin-check: ok (${remoteUses} immutable remote action references)`);
}
