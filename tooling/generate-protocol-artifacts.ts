import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCP_SCHEMA_BUNDLE,
  ACCP_SCHEMA_BUNDLE_DIGEST,
} from "../src/accp/bundle.js";
import {
  canonicalJson,
  computePayloadDigest,
} from "../src/accp/envelope.js";
import { ACCP_VALID_PAYLOADS } from "../src/accp/test-vectors.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const canonicalInput = {
  z: [3, true, null],
  a: { escaped: "line\nfeed", unicode: "control-plane" },
};

const signedEnvelopeVector = {
  note: "TEST VECTOR ONLY - no private key is distributed",
  publicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAKh5KvJve1DA2BiYl70WZCdT+r/+yGs9qBUHTmDYIYkU=\n-----END PUBLIC KEY-----\n",
  verifyAt: "2026-07-12T10:00:30.000Z",
  envelope: {
    protocol: "accp/1.0",
    schemaDigest: "sha256:3978603f31086172fe5be0c4103a424d186e5bd3bd20cecbf43fde280c9e7c98",
    type: "work.offer",
    messageId: "019f6a00-0000-7000-8000-000000000050",
    sessionId: "019f6a00-0000-7000-8000-000000000051",
    workspaceId: "019f6a00-0000-7000-8000-000000000052",
    senderId: "cloud",
    idempotencyKey: "fixture:work-offer:1",
    sequence: 1,
    sentAt: "2026-07-12T10:00:00.000Z",
    expiresAt: "2026-07-12T10:05:00.000Z",
    payload: ACCP_VALID_PAYLOADS["work.offer"],
    payloadDigest: "sha256:1e61f525508440e13ca147fdc892e564cf514f1c154c1913392190c88bab93d8",
    signature:
      "ed25519:qLpCWFz6RyFTnTGU4_b6qsWhk7_VN3UR5s0ZhrMYPE-hXcJeEnJ-jNI4H511fMxyhS3iDRMqW9wi-DKx1-fSAg",
  },
};

const artifacts = new Map<string, string>([
  ["protocol/schema-bundle.json", `${JSON.stringify(ACCP_SCHEMA_BUNDLE, null, 2)}\n`],
  ["protocol/schema-bundle.sha256", `${ACCP_SCHEMA_BUNDLE_DIGEST}\n`],
  [
    "protocol/test-vectors/valid-payloads.json",
    `${JSON.stringify({ protocol: "accp/1.0", payloads: ACCP_VALID_PAYLOADS }, null, 2)}\n`,
  ],
  [
    "protocol/test-vectors/canonicalization.json",
    `${JSON.stringify(
      {
        input: canonicalInput,
        canonical: canonicalJson(canonicalInput),
        digest: computePayloadDigest(canonicalInput),
      },
      null,
      2,
    )}\n`,
  ],
  [
    "protocol/test-vectors/invalid.json",
    `${JSON.stringify(
      [
        { name: "unknown-message", type: "work.destroy_everything", payload: {}, code: "UNKNOWN_TYPE" },
        { name: "missing-offer-lease", type: "work.offer", payload: { taskId: "fixture" }, code: "SCHEMA_VIOLATION" },
        { name: "bad-sha256", type: "artifact.declared", payload: { digest: "abc123" }, code: "SCHEMA_VIOLATION" },
        { name: "bad-signature", mutate: "envelope.signature", value: "ed25519:AAAA", code: "SIGNATURE_INVALID" },
        { name: "clock-skew", mutate: "receiverNow", value: "2026-07-12T10:10:00.000Z", code: "CLOCK_SKEW_EXCEEDED" },
      ],
      null,
      2,
    )}\n`,
  ],
  [
    "protocol/test-vectors/signed-envelope.json",
    `${JSON.stringify(signedEnvelopeVector, null, 2)}\n`,
  ],
]);

let stale = false;
for (const [relativePath, expected] of artifacts) {
  const path = join(root, relativePath);
  if (check) {
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch {
      stale = true;
      console.error(`missing generated protocol artifact: ${relativePath}`);
      continue;
    }
    if (current !== expected) {
      stale = true;
      console.error(`stale generated protocol artifact: ${relativePath}`);
    }
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, expected, "utf8");
  console.log(relativePath);
}

if (stale) process.exitCode = 1;
