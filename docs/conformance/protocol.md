# ACCP protocol conformance

This guide validates ACCP v1 schema identity, payload shapes, canonicalization, signed envelopes, and negative vectors. Full endpoint conformance additionally requires the stateful delivery, lease, evidence, review, and reconciliation semantics in the [normative ACCP v1 specification](../reference/accp-v1.md).

## Generated artifacts

| Path | Role |
| --- | --- |
| `protocol/schema-bundle.json` | Draft 2020-12 JSON Schemas for all 24 payload types |
| `protocol/schema-bundle.sha256` | ACCP canonical digest of the bundle JSON value |
| `protocol/test-vectors/valid-payloads.json` | one valid payload for every message type |
| `protocol/test-vectors/canonicalization.json` | input, exact canonical JSON string, and payload digest |
| `protocol/test-vectors/signed-envelope.json` | public key, verification time, and a complete signed `work.offer` envelope |
| `protocol/test-vectors/invalid.json` | named rejection/mutation cases and expected ACCP error codes |

These files are generated from `src/accp/` by `tooling/generate-protocol-artifacts.ts`. Do not hand-edit them.

The current expected digest is:

```text
sha256:3978603f31086172fe5be0c4103a424d186e5bd3bd20cecbf43fde280c9e7c98
```

This is `sha256:` plus SHA-256 of the UTF-8 canonical JSON value. It is not the ordinary file hash of the indented `schema-bundle.json`, so `shasum -a 256 protocol/schema-bundle.json` is not expected to print the same value.

## Repository verification

Run from a clean checkout using a supported Node.js version:

```bash
npm ci
npm run generate:protocol:check
npm run build
npx tsx --test test/accp.test.ts test/accp-generated.test.ts test/accp-ids.test.ts
```

The release gate is broader:

```bash
npm run check
```

That command checks generated protocol drift, TypeScript build, the full test suite, adapter fixture conformance, the verified-outcome demo, license policy, and pinned GitHub Actions.

To intentionally regenerate after changing a source schema:

```bash
npm run generate:protocol
npm run generate:protocol:check
```

Review the protocol version, schema digest, generated diff, vectors, compatibility classification, and documentation together. A digest change is an externally visible contract change even if TypeScript compiles.

## Third-party conformance algorithm

A language-independent implementation should perform these checks in order.

### 1. Schema catalog

- Read `protocol` from the bundle and require `accp/1.0`.
- Require exactly the message names your endpoint claims to support; full v1 has 24.
- Compile each payload schema as JSON Schema Draft 2020-12.
- Validate the matching entry in `valid-payloads.json`.
- Ensure an unknown type is rejected rather than accepted as an opaque command.

### 2. Canonicalization and bundle digest

- Apply the canonicalization rules in the normative specification to the vector `input`.
- Compare bytes, not parsed JSON equivalence, with vector `canonical`.
- Compute the prefixed payload digest and compare with vector `digest`.
- Canonicalize the schema-bundle JSON value and compare its prefixed digest with `schema-bundle.sha256`.

A serializer that merely sorts most keys or emits numerically equivalent but byte-different values is non-conformant.

### 3. Signed envelope

- Parse the public key in `signed-envelope.json` as Ed25519 SPKI PEM.
- Use the vector's `verifyAt` as the receiver clock.
- Recompute the payload digest.
- Remove only `signature`, canonicalize the remaining envelope, decode the base64url signature, and verify Ed25519.
- Validate the `work.offer` payload and clock/expiry window.

The vector contains no private key and is safe to publish. Implementations should also generate their own keypair, seal an envelope, round-trip it, and prove that mutating any signed field fails verification.

### 4. Invalid cases

`invalid.json` is a compact harness description rather than a set of complete independent envelopes:

- direct `{ type, payload }` cases test type/payload dispatch;
- `mutate` cases modify the valid signed-envelope fixture or receiver time;
- `code` is the expected ACCP failure classification.

At minimum, test unknown type, missing offer lease, malformed SHA-256, bad signature, and clock skew. Add local tests for expired messages, UUID version, sequence regression, schema-digest mismatch, payload size, event cursor gaps/overlap, stale lease, stale review subject, artifact hash/size mismatch, and idempotency conflict.

### 5. Stateful semantics

JSON and signature tests alone are insufficient. A full node or controller conformance harness must also prove:

- fresh session ID and sequence reset on reconnect;
- exact protocol/schema negotiation and epoch fencing;
- 15-second heartbeat and 45-second dead detection;
- durable offer answer before `work.accepted`/`work.declined` is sent;
- identical offer replay after process restart;
- atomic event append/cursor advance, contiguous batching, ACK pruning, duplicate re-ACK, and gap reconciliation;
- cancellation and lease revocation reach a safe observed state;
- artifacts are accepted only after digest/size verification;
- completion waits for evidence through `finalCursor`;
- review is bound to the exact subject digest;
- effect grants and provider idempotency prevent duplicate external effects;
- ambiguous provider outcomes remain `unknown` until reconciled;
- buffer truncation is reported and protected terminal/effect/verification facts are retained.

The repository does not yet ship a controller simulator that certifies this full matrix. The public alpha node itself has documented gaps in automatic heartbeat, complete command binding, durable epoch/dedup state, strict inbound sequence/schema negotiation, and artifact upload. Therefore a passing repository test run supports a **protocol primitives/schema-vector** claim, not a **full ACCP endpoint** claim.

## Suggested conformance levels

| Level | Required proof | Suitable claim |
| --- | --- | --- |
| Schema | bundle digest and all valid/invalid payload schema cases | “ACCP v1 schema compatible with digest …” |
| Crypto | Schema plus canonicalization and signed-envelope vectors | “ACCP v1 envelope compatible” |
| Session | Crypto plus negotiation, sequence, heartbeat, replay, cursor, and restart tests | “ACCP v1 session compatible” |
| Node | Session plus work/lease/run/artifact/review/effect node semantics | “ACCP v1 node conformant” |
| Controller | Session plus authoritative controller semantics and persistence | “ACCP v1 controller conformant” |
| End-to-end | Independent conformant node/controller pair plus fault injection | “ACCP v1 end-to-end conformant” |

Every published claim should include implementation version/commit, protocol string, schema digest, conformance level, vector commit, runtime/OS, complete report, and documented exceptions.

## Compatibility failures

A peer must refuse new work when no protocol/schema pair is explicitly compatible. Do not “fix” a digest mismatch by replacing the expected digest, deleting unknown required fields, or disabling signature verification. See [`COMPATIBILITY.md`](../../COMPATIBILITY.md) for version and deprecation rules.
