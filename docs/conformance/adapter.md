# Adapter conformance

The adapter conformance suite tests a process that implements [`acc-adapter/1`](../reference/adapter-lifecycle.md). It produces a machine-readable report suitable for a release artifact or compatibility registry.

Passing means the adapter satisfied the behaviors sampled by this suite on the recorded platform, Node version, adapter version, and command. It is not a security sandbox, source-code audit, provider certification, or proof that every declared side effect is safe.

## Run the bundled fixture

From a source checkout:

```bash
npm ci
npm run conformance:fixture
```

The fixture is `examples/echo-adapter.mjs`. It has no workspace or network access, declares no secrets or side effects, returns a deterministic artifact, and implements reconciliation. This command must pass in release CI.

## Run a third-party adapter

Through the repository script:

```bash
npm run conformance -- \
  --command /absolute/path/to/adapter \
  --arg first-argument \
  --arg second-argument \
  --report adapter-conformance.json
```

Or, after installing the package binary:

```bash
acc-adapter-conformance \
  --command node \
  --arg /absolute/path/to/adapter.mjs \
  --report adapter-conformance.json
```

Each `--arg` adds exactly one argv item. The runner uses `spawn` with `shell: false`; do not combine multiple arguments into one quoted shell fragment.

Exit codes are:

| Code | Meaning |
| ---: | --- |
| 0 | suite completed and all implemented checks passed |
| 1 | adapter execution, response validation, or behavioral conformance failed |
| 2 | command-line usage error, currently a missing `--command` |

On success, the JSON report is always printed to stdout and is also written to `--report` when supplied. On failure, a concise reason is written to stderr; a passing report is not emitted.

## Test fixture

The runner creates a private temporary root with:

```text
acc-conformance-.../
  workspace/
    MARKER.txt
  artifacts/
```

It records the marker hash, generates a random canary secret in `ACC_CONFORMANCE_SECRET`, launches the adapter, and communicates over JSON Lines. Unless the programmatic `keepFixture` option is set, the root is recursively removed in a `finally` block.

Default limits are 5 seconds per RPC request and 1 MiB total adapter stdout. Stderr retained in the transcript is bounded to the same limit. These values can be changed through the programmatic `runAdapterConformance` API; the current CLI intentionally exposes only command, repeated args, and report path.

## Checks performed

The suite fails immediately when a required response is malformed or a behavioral assertion fails.

1. **JSONL discipline and RPC shape**
   - Every non-empty stdout line must parse as a strict `acc-adapter/1` response.
   - Responses must arrive for pending requests and repeat the exact request ID.
   - Unsolicited stdout frames, timeout, premature exit, or excessive stdout fail the suite.

2. **Manifest**
   - `probe` must succeed.
   - `result.manifest` must satisfy the strict manifest schema.

3. **Idempotent start**
   - The runner submits the same task, workspace, artifact directory, and `fixture:start:1` key twice.
   - Both starts must return the same valid handle ID.

4. **Collection and artifact containment**
   - `collect` must return a valid terminal result with status `succeeded` for the deterministic fixture task.
   - Every returned artifact must exist, resolve through `realpath`, and be a child of the fixture artifact directory.

5. **Capability truthfulness**
   - When `liveMessages` or `cancellation` is true, the matching method must succeed.
   - When false, it must return error code `UNSUPPORTED`.
   - When `reconciliation` is true, `reconcile` must succeed with a valid terminal result.

6. **Cleanup and workspace integrity**
   - `cleanup` must succeed.
   - The workspace marker hash must remain unchanged.

7. **Secret canary**
   - The random `ACC_CONFORMANCE_SECRET` value must not appear in captured stdout or stderr.

A report contains suite and protocol versions, the parsed adapter manifest, a manifest hash, an `adapterArtifact` subject/digest/kind record, platform, Node version, checks, and final `passed` boolean. The current `manifestDigest` is lowercase SHA-256 hex of `JSON.stringify` on the parsed manifest; it is a report fingerprint, not an ACCP-prefixed canonical digest or a code-signing identity. When an argv item resolves to a readable file, `adapterArtifact` hashes the first such file; otherwise it hashes the exact command/argv descriptor. This binds the report to the tested fixture or command description, but it does not resolve a command from `PATH`, hash a dependency tree, or provide a signature.

## What the suite does not prove

The current alpha suite does not:

- block undeclared network access or inspect packets;
- prevent the child process from reading other same-user files;
- inject every declared secret or verify secret-manager integration;
- prove a write-capable adapter changes only intended workspace files;
- exercise a long-running cancellation race or prove the whole process tree exited;
- force a process restart before `reconcile`;
- validate provider receipts, billing/usage values, or every side-effect idempotency failure;
- audit dependency provenance, resolve a command from `PATH`, or hash the complete executable/dependency tree that actually runs in production.

A production adapter review should add least-privilege OS/container isolation, a pinned executable digest, malicious-input tests, restart/reconciliation tests, provider-side idempotency tests, output redaction tests, and domain-specific evidence checks.

## Publishing a conformance claim

A useful claim includes all of the following:

- adapter ID and adapter version;
- exact executable or image digest;
- `acc-adapter/1` and conformance suite version;
- Agent Control Center Core package version/commit;
- OS, CPU architecture, and Node version from the report;
- the unmodified JSON report;
- any extra isolation and provider tests run outside this suite;
- known limitations and capability exceptions.

Do not reuse a passing report after changing the adapter binary, manifest, dependencies, or runtime image.
