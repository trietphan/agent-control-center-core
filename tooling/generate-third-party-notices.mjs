import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const checker = resolve(
  root,
  "node_modules/license-checker-rseidelsohn/bin/license-checker-rseidelsohn.js",
);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function portableRelative(path) {
  if (!path || !isAbsolute(path)) return undefined;
  const local = relative(root, path);
  if (local === "" || local.startsWith(`..${sep}`) || local === "..") return undefined;
  return local.split(sep).join("/");
}

async function fileEvidence(path) {
  const localPath = portableRelative(path);
  if (!localPath) return undefined;
  const content = await readFile(path);
  return {
    path: localPath,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function splitPackageId(packageId) {
  const separator = packageId.lastIndexOf("@");
  if (separator <= 0) return { name: packageId, version: "unknown" };
  return {
    name: packageId.slice(0, separator),
    version: packageId.slice(separator + 1),
  };
}

const outputArgument = argumentValue("--output") ?? "third-party-licenses.generated.json";
const outputPath = resolve(root, outputArgument);
const outputRelative = relative(root, outputPath);
if (outputRelative.startsWith(`..${sep}`) || outputRelative === "..") {
  throw new Error("Output path must stay inside the repository.");
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

const rawInventory = JSON.parse(result.stdout);
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const directDependencies = new Set(Object.keys(packageJson.dependencies ?? {}));
const lockfile = await readFile(resolve(root, "package-lock.json"));

const packages = [];
for (const [packageId, metadata] of Object.entries(rawInventory)) {
  const { name, version } = splitPackageId(packageId);
  if (name === packageJson.name && version === packageJson.version) continue;
  const licenseFiles = [];
  for (const candidate of [metadata.licenseFile, metadata.noticeFile]) {
    const evidence = await fileEvidence(candidate);
    if (evidence && !licenseFiles.some((item) => item.path === evidence.path)) {
      licenseFiles.push(evidence);
    }
  }
  licenseFiles.sort((left, right) => left.path.localeCompare(right.path));

  packages.push({
    name,
    version,
    direct: directDependencies.has(name),
    license: Array.isArray(metadata.licenses)
      ? metadata.licenses.join(" AND ")
      : String(metadata.licenses ?? "UNKNOWN"),
    repository: metadata.repository || undefined,
    licenseFiles,
  });
}

packages.sort((left, right) =>
  left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
);

const report = {
  schemaVersion: 1,
  project: `${packageJson.name}@${packageJson.version}`,
  productionOnly: true,
  packageLockSha256: createHash("sha256").update(lockfile).digest("hex"),
  packages,
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    // A missing generated report is a drift failure.
  }
  if (current !== rendered) {
    console.error(`Third-party inventory is missing or stale: ${outputRelative}`);
    process.exit(1);
  }
  console.log(`third-party-license-report: current (${packages.length} packages)`);
} else {
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, rendered, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  console.log(`third-party-license-report: wrote ${outputRelative} (${packages.length} packages)`);
}
