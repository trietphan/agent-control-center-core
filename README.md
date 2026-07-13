# Agent Control Center Core

Agent Control Center Core is an open-source control plane for evidence-gated
agent work. It turns a goal into a durable task, runs an adapter in an isolated
Git worktree, verifies the result, preserves evidence, and waits for an exact
human review decision. It is orchestration infrastructure, not another chat
interface.

The project is an alpha. Use it on repositories and machines where you
understand the execution risk, and review evidence before accepting changes.

## Five-minute verified outcome

This first run is deterministic and credential-free. It does not call an AI
provider, access the network, or spend provider credits.

Prerequisites:

- Git 2.28 or newer.
- Node.js `20.19+`, `22.13+`, or `24.x`, as declared in `package.json`.
- npm.

```bash
git clone https://github.com/trietphan/agent-control-center-core.git
cd agent-control-center-core
npm ci
npm run demo:verified-outcome
```

The demo creates a disposable repository under `.demo/`, routes one task to a
deterministic fixture adapter, and should finish with output shaped like this:

```text
PASS fixture adapter ready
PASS source checkout unchanged
PASS isolated worktree changed
PASS independent verification
PASS evidence hashes (N artifacts)
WAITING review <review-id> revision <revision>
```

It then prints two commands containing the exact task ID, review ID, evidence
revision, and `ACC_HOME`. Run the printed evidence command first, inspect the
task if needed, and then run the printed review command:

```bash
ACC_HOME="<demo-state>" npm run acc -- evidence verify <task-id>
ACC_HOME="<demo-state>" npm run acc -- review decide <review-id> \
  --decision approve \
  --if-revision "<revision>"
```

The revision is a compare-and-swap precondition: a stale reviewer cannot
silently approve evidence that changed after inspection. Run these commands
before rerunning the demo because each demo run replaces `.demo/`.

### What the demo proves

- The fixture adapter satisfied the same explicit readiness contract without
  impersonating a real provider login.
- The source checkout remained byte-for-byte untouched by execution.
- The task changed only a separate Git worktree.
- A verifier independent of the adapter checked the success condition.
- Recorded artifacts can be re-hashed and checked for storage containment.
- A task requiring handoff stops at `needs-review` instead of auto-approving.

It does not prove that an AI provider is available, that generated code is
correct beyond the configured verifier, or that a Git worktree is a security
sandbox.

## Run the project checks

```bash
npm run check
```

The check gate verifies generated protocol artifacts and the exported-file
inventory, type-checks and builds TypeScript, runs the test suite, exercises the
example adapter conformance suite, repeats the credential-free outcome, checks
dependency licenses, and verifies that GitHub Actions are pinned.

To inspect adapter conformance separately:

```bash
npm run conformance:fixture
```

See [examples/README.md](examples/README.md) to understand the fixture adapters
and to test an out-of-process adapter of your own.

## How the local control loop works

```text
Operator or MCP client
        |
        v
CLI / authenticated loopback daemon
        |
        v
Coordinator + SQLite state + evidence store
        |
        v
Agent adapter -> isolated Git worktree
        |
        v
Independent verifier -> immutable artifacts -> exact human review
```

Core includes:

- A shared task contract and durable task, run, artifact, message, and review
  state.
- ACCP envelopes, schemas, generated artifacts, and protocol test vectors.
- An out-of-process adapter protocol, SDK helpers, and conformance runner.
- Codex, Claude, and HTTP-based OpenClaw adapter implementations.
- Local SQLite coordination, worktree isolation, process supervision,
  verification, recovery, and artifact integrity checks.
- CLI, authenticated loopback control API, MCP bridge, and an outbound node
  runtime for compatible control planes.

Core does not turn arbitrary agent execution into a safe sandbox. Adapters and
verification commands can execute local processes with the permissions of the
current user. Use trusted adapters, least-privilege credentials, clean
repositories, and an additional VM or sandbox for untrusted workloads.

## Local first, managed service optional

The open-source local node is useful on its own: task state, SQLite, worktrees,
artifacts, verification, reviews, CLI, and MCP all run without a hosted account.

A separately operated managed control plane may provide a hosted dashboard,
authentication, multi-tenant durable storage, fleet coordination, policy,
billing, and operational support. That service implementation is not contained
in this repository and is not required for the five-minute outcome or local
operation. The public node and ACCP interfaces are the interoperability
boundary; access to any managed service is governed by that service's own
terms.

## Connect a real adapter

Do this only after the fixture outcome works. Real adapters require their own
CLI or endpoint, authentication, and provider terms. They may send repository
context to a third party and may incur usage charges.

1. Install and authenticate the provider CLI outside this project.
2. Check readiness:

   ```bash
   npm run acc -- doctor
   ```

3. Create a task against a clean local Git repository:

   ```bash
   npm run acc -- task create \
     --goal "Implement the requested change" \
     --repo /absolute/path/to/clean/repository \
     --agent codex \
     --success "Project tests pass" \
     --verify "npm test"
   ```

4. Execute one queued task and inspect its aggregate:

   ```bash
   npm run acc -- run next
   npm run acc -- task show <task-id>
   ```

Use `--agent claude` for the Claude CLI. OpenClaw is optional and is available
only when `OPENCLAW_ADAPTER_URL` points to a compatible authenticated endpoint.
See `.env.example` for command overrides and local daemon configuration. Never
commit provider tokens or `.acc/` state.

## Use as a library

The package exposes the root API plus focused entry points for `accp`,
`adapter-sdk`, `conformance`, `kernel`, `mcp`, and `node`. Until a public package
release is announced, build and consume these exports from a pinned source
revision rather than assuming an npm version exists.

```bash
npm run build
```

Protocol changes are compatibility-sensitive. Generated files under
`protocol/` must match their TypeScript sources; use `npm run generate:protocol`
after an intentional protocol update and include the generated diff.

## Project status and participation

- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Governance](GOVERNANCE.md)
- [Maintainers](MAINTAINERS.md)
- [Support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Trademark policy](TRADEMARKS.md)

Contributions are accepted under the Apache License 2.0 and the
[Developer Certificate of Origin](DCO). The software license does not grant
rights to project names, logos, or conformance marks.

## License

Copyright 2026 The Agent Control Center Core Authors.

Licensed under the [Apache License 2.0](LICENSE). Third-party attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [NOTICE](NOTICE).
