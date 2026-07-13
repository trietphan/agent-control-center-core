import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCP_SCHEMA_BUNDLE_DIGEST,
  canonicalJson,
  computePayloadDigest,
  verifySealedEnvelope,
} from "../src/accp/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("generated ACCP schema bundle is pinned to the runtime digest", async () => {
  const pinned = (
    await readFile(join(root, "protocol", "schema-bundle.sha256"), "utf8")
  ).trim();
  assert.equal(pinned, ACCP_SCHEMA_BUNDLE_DIGEST);
  assert.notEqual(pinned, `sha256:${"0".repeat(64)}`);
});

test("language-neutral canonicalization vector matches runtime bytes", async () => {
  const vector = JSON.parse(
    await readFile(
      join(root, "protocol", "test-vectors", "canonicalization.json"),
      "utf8",
    ),
  ) as { input: unknown; canonical: string; digest: string };
  assert.equal(canonicalJson(vector.input), vector.canonical);
  assert.equal(computePayloadDigest(vector.input), vector.digest);
});

test("published signed envelope vector verifies without a private key", async () => {
  const vector = JSON.parse(
    await readFile(
      join(root, "protocol", "test-vectors", "signed-envelope.json"),
      "utf8",
    ),
  ) as { publicKeyPem: string; verifyAt: string; envelope: unknown };
  const result = verifySealedEnvelope(
    vector.envelope,
    vector.publicKeyPem,
    Date.parse(vector.verifyAt),
  );
  assert.equal(result.ok, true);
});
