# Compatibility policy

Agent Control Center Core is currently `0.1.0-alpha.1`. This document separates package API, Node.js runtime, local database, adapter protocol, and ACCP wire compatibility so that one green check is not mistaken for compatibility at every layer.

## Stability status

Before package version 1.0:

- TypeScript APIs, CLI flags/output, local HTTP API details, database schema, and behavior may change between minor releases;
- public wire contracts still use explicit protocol identifiers and schema digests and must not change silently;
- release notes must call out migration, protocol, adapter, configuration, and operational changes;
- no managed-cloud compatibility promise is made because a managed service is not included here.

Apache-2.0 source availability does not itself imply API stability.

## Node.js runtime

The package engine range is:

```text
^20.19.0 || ^22.13.0 || ^24.0.0
```

| Runtime | Local CLI, daemon, MCP, control DB, built-in adapters | ACCP `SqliteNodeStateStore` / `acc node connect` | Support |
| --- | --- | --- | --- |
| Node 20.19.x or later 20.x | supported | unavailable because `node:sqlite` is absent | supported local-only runtime |
| Node 22.13.x or later 22.x | supported | supported | preferred full public runtime |
| Node 24.x | supported | supported | supported |
| Earlier Node or unlisted majors | not supported | not supported | upgrade first |

`SqliteNodeStateStore` is lazily loaded, so importing or using classic local features on Node 20 does not require `node:sqlite`.

Git is required for repository execution. POSIX systems receive the strongest process-tree and file-mode behavior. Windows is supported by Node/package interfaces, but POSIX process-group termination and numeric permission semantics do not transfer exactly; high-risk Windows execution requires additional isolation and testing.

## Package and export compatibility

Published entry points are:

- `agent-control-center-core`
- `agent-control-center-core/accp`
- `agent-control-center-core/adapter-sdk`
- `agent-control-center-core/conformance`
- `agent-control-center-core/kernel`
- `agent-control-center-core/mcp`
- `agent-control-center-core/node`

Deep imports into `dist/src/...` are unsupported even when they happen to resolve. Consumers should compile against a declared export and pin an exact alpha version. A source symbol that is not reachable through a package export is internal.

Package SemVer and wire-protocol versions are independent. Upgrading an npm patch does not authorize accepting an unknown ACCP schema digest, and bumping ACCP does not necessarily require a package major before package 1.0.

## ACCP compatibility

Current protocol: `accp/1.0`

Current schema digest: `sha256:3978603f31086172fe5be0c4103a424d186e5bd3bd20cecbf43fde280c9e7c98`

The protocol string describes semantic rules. The schema digest identifies the exact generated payload catalog. A connection is compatible only when both peers select a protocol version and schema digest that each has explicitly declared compatible.

| Change | Required action |
| --- | --- |
| Documentation, comments, or tests only; generated bundle unchanged | no wire-version change |
| Accepted wire shape or message semantics change compatibly | new protocol minor and new schema digest; advertise both during a migration window if implemented |
| Required field removal/change, meaning change, signature/canonicalization change, incompatible state behavior | new protocol major and new schema digest |
| Regenerated digest changes unexpectedly | block release and investigate; never update the pinned digest blindly |

Only `accp/1.0` is implemented today. There is no current-version-minus-one support claim yet. A peer with the same protocol string but an unknown digest must refuse new work unless that digest appears in an audited compatibility allowlist. See the [normative protocol](docs/reference/accp-v1.md) and [protocol conformance](docs/conformance/protocol.md).

`node.welcome.deprecation` can announce `noNewWorkAt` and `removalAt`. Once used, the controller should provide enough overlap for active runs to finish and should refuse new work before removing transport support. Before package 1.0 no fixed calendar duration is promised; dates in the signed welcome are authoritative for that controller.

## Adapter compatibility

Current external adapter protocol: `acc-adapter/1`.

The integer after the slash is a major contract version. Any incompatible request/response, manifest, lifecycle, stdout framing, or idempotency change requires `acc-adapter/2`. Compatible optional capabilities may remain in v1 only when old hosts can safely ignore or reject them and strict schemas are deliberately updated together.

An adapter compatibility claim is scoped to:

- protocol string;
- adapter ID and adapter version;
- executable/image digest;
- conformance suite version and report;
- OS, architecture, and Node/runtime version;
- provider API version and declared capabilities where relevant.

Built-in `AgentAdapter` currently supports `codex`, `claude`, and `openclaw` kinds. The external SDK allows vendor adapter IDs, but dynamic third-party discovery/registration into the local coordinator is not yet a compatibility promise. A wrapper or registry integration is required today.

## SQLite compatibility

The local control database is forward-only and currently supports `PRAGMA user_version = 0`, 1, or 2. Opening a version higher than 2 fails closed. Version 0 is adopted through the baseline check, version 1 is the stamped baseline, and version 2 adds `runs.usage_json`.

The ACCP node journal separately supports only `PRAGMA user_version = 1`; version 0 initializes v1, and any other existing version is rejected. It must not be deleted as an “upgrade,” because it contains cursor, event, offer-answer, and truncation state needed for exactly-once business behavior over at-least-once delivery.

There are no down migrations. After a newer binary migrates a database, an older binary is unsupported unless the operator stops all writers and restores a verified pre-migration backup. See [SQLite migrations](docs/reference/node-sqlite-migrations.md).

## Local HTTP API and MCP

The daemon routes are namespaced under `v1`, but the HTTP API is currently an alpha local API, not a frozen Internet service contract. It assumes a single trusted local-user boundary, loopback binding, bearer token, explicit CORS origins, and one database ownership domain.

The MCP server is a bridge to that API. It does not relax authentication, validation, idempotency, optimistic concurrency, artifact byte limits, or coordinator state transitions. MCP tool names and result JSON may evolve before package 1.0; clients should inspect errors and pin the package.

## Adapter/provider availability

| Integration | Local prerequisite | Absence behavior |
| --- | --- | --- |
| Codex | `codex` executable and `codex login` | `acc doctor` reports unavailable; routes requiring Codex cannot run |
| Claude | `claude` executable and `claude auth login` | `acc doctor` reports unavailable; routes requiring Claude cannot run |
| OpenClaw | `OPENCLAW_ADAPTER_URL`, optional token, compatible endpoint | registered as unavailable when not configured; Codex/Claude local mode remains useful |

Command paths and extra argv can be pinned with `ACC_CODEX_COMMAND`, `ACC_CODEX_ARGS`, `ACC_CLAUDE_COMMAND`, and `ACC_CLAUDE_ARGS`. Argument variables are JSON string arrays, not shell fragments.

## Deprecation and removal process

For any public contract removal, maintainers should:

1. mark the contract deprecated in docs, types, and release notes;
2. provide a machine-detectable warning where practical;
3. document replacement, database/protocol migration, and rollback boundary;
4. retain conformance fixtures for the overlap period;
5. remove only in a version permitted by the relevant package or wire-version policy.

Security fixes may shorten normal notice. They must still identify affected versions, safe upgrade path, credential rotation needs, and any evidence/reconciliation impact.

## Managed service boundary

This compatibility policy covers the open-source local kernel, public protocols, SDK, CLI, daemon, MCP bridge, and node client. It makes no promise about a hosted dashboard, customer authentication, tenant authorization, managed database, hosted queue, billing, support SLA, or managed controller implementation. Those systems are not shipped in this repository and must publish their own service and API compatibility policies.
