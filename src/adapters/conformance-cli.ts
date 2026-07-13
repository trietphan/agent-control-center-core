#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { runAdapterConformance } from "./conformance.js";

function values(flag: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      out.push(process.argv[index + 1]!);
      index += 1;
    }
  }
  return out;
}

const command = values("--command")[0];
const args = values("--arg");
const output = values("--report")[0];
if (!command) {
  console.error("Usage: acc-adapter-conformance --command <binary> [--arg <arg>] [--report <json>]");
  process.exitCode = 2;
} else {
  try {
    const report = await runAdapterConformance({ command, args });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (output) await writeFile(output, serialized, "utf8");
    process.stdout.write(serialized);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
