import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRelative = "provenance/files.sha256";
const excludedRoots = new Set([
  ".acc",
  ".demo",
  ".git",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);
const excludedFiles = new Set([
  ".DS_Store",
  "conformance-report.json",
  "sbom.cdx.json",
]);

function isGeneratedOrPrivate(rel) {
  const name = rel.split("/").at(-1) ?? rel;
  if (excludedFiles.has(rel) || excludedFiles.has(name)) return true;
  if (name.endsWith(".log") || name.endsWith(".tgz")) return true;
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return true;
  }
  return false;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const rel = relative(root, path).split("\\").join("/");
    const top = rel.split("/", 1)[0];
    if (excludedRoots.has(top)) continue;
    if (rel === outputRelative) continue;
    if (isGeneratedOrPrivate(rel)) continue;
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

const files = (await walk(root)).sort();
const rows = [];
for (const file of files) {
  const digest = createHash("sha256")
    .update(await readFile(join(root, file)))
    .digest("hex");
  rows.push(`${digest}  ${file}`);
}
const expected = `${rows.join("\n")}\n`;
const output = join(root, outputRelative);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = await readFile(output, "utf8");
  } catch {
    console.error(`missing ${outputRelative}`);
    process.exitCode = 1;
  }
  if (current && current !== expected) {
    console.error(`stale ${outputRelative}; run npm run inventory:generate`);
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, expected, "utf8");
  console.log(`${outputRelative}: ${files.length} files`);
}
