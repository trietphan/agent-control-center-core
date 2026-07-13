# Agent Control Center Core documentation

Agent Control Center Core is a local-first control plane for durable agent work. It routes tasks, runs agents in isolated Git worktrees, records evidence, applies explicit review gates, and exposes the same state through a CLI, a loopback HTTP daemon, and MCP. It is deliberately not another chat UI.

The package is currently `0.1.0-alpha.1`. Interfaces are usable, tested, and documented, but they are not yet covered by a pre-1.0 stability promise.

## What is public and useful without a hosted service

A local installation provides:

- a durable task board and timeline in SQLite;
- deterministic routing across Codex, Claude, and optional OpenClaw adapters;
- isolated Git worktrees for repository-scoped runs;
- supervised agent and verification processes with bounded output and timeouts;
- immutable artifact metadata, hashes, diffs, test logs, and handoff summaries;
- an authenticated loopback control API with SSE and idempotent mutations;
- an MCP bridge that calls that API instead of bypassing its controls;
- the ACCP v1 schema bundle, signed-envelope primitives, test vectors, and an optional outbound execution-node runtime;
- an external adapter SDK and conformance runner.

Codex and Claude are ordinary local CLI dependencies. OpenClaw is optional. If it is not configured, `acc doctor` reports it as unavailable; Codex-only and Claude-only local flows continue to work. A route that explicitly requires OpenClaw can block or skip only when that route step is optional.

## Local quick start

Prerequisites are a supported Node.js version, Git, and at least one authenticated agent CLI.

```bash
npm ci
npm run build
npm run acc -- init
npm run acc -- doctor
```

Create and execute one task:

```bash
npm run acc -- task create \
  --goal "Fix the failing login test" \
  --repo /absolute/path/to/repository \
  --agent codex \
  --success "Tests pass" \
  --verify "npm test"
npm run acc -- run next
```

For a continuously running local control plane:

```bash
npm run acc -- serve
```

The daemon binds to `127.0.0.1:4317` by default. Its bearer token is stored in `.acc/daemon.token`; do not paste that token into logs or commit `.acc/`.

## Documentation map

| Document | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Components, local execution flow, optional node federation, state, and failure boundaries |
| [Threat model](threat-model.md) | Assets, trust assumptions, controls, residual risks, and deployment guidance |
| [ACCP v1 specification](reference/accp-v1.md) | Standalone normative wire protocol, message catalog, signing, replay, and negotiation |
| [Adapter lifecycle](reference/adapter-lifecycle.md) | `acc-adapter/1` JSONL RPC contract and the in-process adapter boundary |
| [SQLite migrations](reference/node-sqlite-migrations.md) | Forward-only migration policy for the local control database and node journal |
| [Adapter conformance](conformance/adapter.md) | How a third-party adapter is tested and what a passing report means |
| [Protocol conformance](conformance/protocol.md) | Schema digest, canonicalization, signed vectors, and implementation checklist |
| [Compatibility policy](../COMPATIBILITY.md) | Runtime, package, protocol, adapter, database, and deprecation compatibility |
| [Legal release checklist](legal-release-checklist.md) | Release-time licensing and provenance checks |
| [Dependency license decisions](dependency-license-decisions.md) | Recorded dependency license policy decisions |

## Sources of contract truth

Use this precedence when two artifacts appear to disagree:

1. the normative ACCP or adapter contract for required behavior;
2. `protocol/schema-bundle.json` for the exact accepted ACCP payload shapes in this release;
3. `protocol/schema-bundle.sha256` for the exact canonical schema identity;
4. `protocol/test-vectors/` for language-neutral examples;
5. TypeScript types and implementation tests for package behavior.

Run `npm run generate:protocol:check` before publishing. Generated protocol artifacts must never be edited by hand.

## Explicit non-goals of this repository

This repository does not ship a managed multi-tenant control service, hosted dashboard, customer authentication, billing, organization administration, managed secrets, a hosted scheduler, or the cloud side of ACCP. Those can be built against the public contracts, but they are separate products and separate security boundaries. Local mode does not depend on them.
