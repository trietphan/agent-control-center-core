import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const checker = resolve(
  root,
  "node_modules/license-checker-rseidelsohn/bin/license-checker-rseidelsohn.js",
);

const approved = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Python-2.0",
]);

// OR expressions are approved only for the exact locked package reviewed in
// docs/dependency-license-decisions.md. A new package with the same expression
// still fails until maintainers record a separate decision.
const approvedExpressionDecisions = new Map([
  ["expand-template@2.0.3", "(MIT OR WTFPL)"],
  ["rc@1.2.8", "(BSD-2-Clause OR MIT OR Apache-2.0)"],
]);

const decisionRecord = readFileSync(
  resolve(root, "docs/dependency-license-decisions.md"),
  "utf8",
);
for (const [packageId, expression] of approvedExpressionDecisions) {
  const documentedExpression = expression.replace(/^\((.*)\)$/u, "$1");
  if (
    !decisionRecord.includes(`\`${packageId}\``) ||
    !decisionRecord.includes(`\`${documentedExpression}\``)
  ) {
    throw new Error(
      `Approved license decision is not recorded in docs/dependency-license-decisions.md: ${packageId} ${expression}`,
    );
  }
}

const result = spawnSync(
  process.execPath,
  [checker, "--production", "--json", "--start", root],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "License inventory failed.");
  process.exit(result.status ?? 2);
}

let inventory;
try {
  inventory = JSON.parse(result.stdout);
} catch (error) {
  console.error(`License inventory was not valid JSON: ${error.message}`);
  process.exit(2);
}

const findings = [];
const counts = new Map();

for (const [packageId, metadata] of Object.entries(inventory)) {
  const raw = Array.isArray(metadata.licenses)
    ? metadata.licenses.join(" AND ")
    : String(metadata.licenses ?? "UNKNOWN").trim();
  counts.set(raw, (counts.get(raw) ?? 0) + 1);
  const reviewedExpression = approvedExpressionDecisions.get(packageId);
  if (!approved.has(raw) && reviewedExpression !== raw) {
    findings.push({ packageId, license: raw || "UNKNOWN" });
  }
}

if (findings.length > 0) {
  console.error(
    "License policy failed. Unknown, copyleft, source-available, compound, or otherwise unapproved licenses require a recorded maintainer and legal review:\n" +
      findings.map(({ packageId, license }) => `- ${packageId}: ${license}`).join("\n"),
  );
  process.exitCode = 1;
} else {
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([license, count]) => `${license}=${count}`)
    .join(", ");
  console.log(`license-policy: ok (${Object.keys(inventory).length} production packages; ${summary})`);
}
