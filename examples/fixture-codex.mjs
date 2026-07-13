#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("fixture-codex 0.1.0\n");
  process.exit(0);
}
if (args.join(" ") === "login status") {
  process.stdout.write("Logged in using deterministic fixture credentials\n");
  process.exit(0);
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes("STATUS.md")) {
  process.stderr.write("fixture goal must mention STATUS.md\n");
  process.exit(2);
}
const resultIndex = args.indexOf("--output-last-message");
const resultPath = resultIndex >= 0 ? args[resultIndex + 1] : undefined;
if (!resultPath) {
  process.stderr.write("missing --output-last-message\n");
  process.exit(2);
}
await writeFile(join(process.cwd(), "STATUS.md"), "OK\n", "utf8");
await writeFile(resultPath, "Created STATUS.md in the isolated worktree.\n", "utf8");
process.stdout.write(`${JSON.stringify({ type: "item.completed", fixture: true })}\n`);
