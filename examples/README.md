# Examples

The examples are intentionally deterministic. They teach the adapter boundary
and make the local verified-outcome path runnable without an AI account,
network access, or provider spending.

They are test fixtures, not production agents.

## `echo-adapter.mjs`

`echo-adapter.mjs` is a minimal out-of-process implementation of
`acc-adapter/1`. It communicates with newline-delimited JSON over stdin/stdout
and sends diagnostics to stderr.

Its manifest declares:

- No workspace access.
- No network access.
- No secrets.
- No external side effects.
- No live messages or cancellation.
- Reconciliation support.

On `start`, it creates one deterministic result artifact inside the directory
provided by the host. Repeating the same idempotency key returns the same
handle. It supports `probe`, `start`, `collect`, `reconcile`, and `cleanup`, and
returns an explicit `UNSUPPORTED` error for undeclared operations.

Run its conformance suite:

```bash
npm run conformance:fixture
```

Or invoke the runner directly and retain a JSON report:

```bash
npm run conformance -- \
  --command node \
  --arg examples/echo-adapter.mjs \
  --report conformance-report.json
```

The current suite checks the manifest, idempotent start, artifact containment,
declared message and cancel behavior, reconciliation, workspace integrity, and
secret-canary redaction. Passing these checks is not a general security
certification.

## `fixture-codex.mjs`

`fixture-codex.mjs` emulates only the narrow Codex CLI behavior needed by the
credential-free demo. It:

- Returns deterministic version and login-status probes.
- Requires a fixture goal mentioning `STATUS.md`.
- Writes `STATUS.md` in the current isolated worktree.
- Writes a deterministic last-message artifact.
- Makes no network or model call.

Run the end-to-end fixture:

```bash
npm run demo:verified-outcome
```

The demo recreates `.demo/` on every run. It proves source checkout integrity,
isolated worktree changes, independent verification, evidence hashing, and an
exact pending review revision. Use the evidence and review commands printed by
that same run before starting it again.

Do not place `fixture-codex.mjs` on a production `PATH`, use its readiness output
as proof of real provider authentication, or adapt it to silently impersonate a
provider command outside a test.

## Author an adapter

Third-party adapters should remain out-of-process. Do not ask users to load
unsigned adapter JavaScript into the coordinator process.

At minimum:

1. Read one JSON request per line from stdin.
2. Emit one JSON response per line to stdout.
3. Send human-readable diagnostics only to stderr.
4. Return a truthful manifest from `probe`.
5. Make `start` idempotent and return durable handle evidence.
6. Keep every artifact inside the supplied artifact directory.
7. Bound input, output, subprocesses, duration, and retained state.
8. Implement or explicitly reject messages, cancellation, reconciliation, and
   cleanup according to the manifest.
9. Never echo secrets into protocol responses, logs, summaries, or artifacts.
10. Pass the conformance suite and publish its full report with the tested
    adapter digest and runtime details.

Study `echo-adapter.mjs` for protocol shape, then use the public
`agent-control-center-core/adapter-sdk` and
`agent-control-center-core/conformance` package exports. Source-checkout readers
can inspect the corresponding
[`sdk.ts`](https://github.com/trietphan/agent-control-center-core/blob/main/src/adapters/sdk.ts)
and
[`conformance.ts`](https://github.com/trietphan/agent-control-center-core/blob/main/src/adapters/conformance.ts)
implementations. The example is deliberately small; production adapters also
need authentication lifecycle, rate limits, cancellation of child process
trees, restart recovery, output limits, and platform-specific tests.

## Connect a real provider later

Real Codex, Claude, or OpenClaw-compatible adapters are not required to develop
against the protocol. When you choose to connect one:

- Read the provider's data handling and usage terms.
- Authenticate through the provider's supported mechanism.
- Expect network access and possible provider charges.
- Start with a synthetic repository and least-privilege credentials.
- Run `npm run acc -- doctor` and preserve the distinction between installed and
  authenticated readiness.
- Never commit provider tokens, transcripts, or `.acc/` state.

The separately operated managed control plane is not part of these examples.
Local conformance and the verified-outcome demo do not require it.
