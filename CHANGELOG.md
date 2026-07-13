# Changelog

All notable changes to Agent Control Center Core are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0, incompatible changes may occur in minor releases but must be called
out with migration guidance.

## [Unreleased]

### Added

- Community contribution, governance, support, conduct, maintainer, roadmap,
  DCO, and trademark documentation.
- A five-minute README path centered on a credential-free verified outcome.
- Documentation of the local Core and separately operated managed-service
  boundary.

## [0.1.0-alpha.1] - 2026-07-13

Initial open-core readiness release.

### Added

- Durable local task coordination backed by SQLite.
- Task routing across Codex, Claude, OpenClaw-compatible, and parallel plans.
- Isolated Git worktrees, independent verification, artifact collection,
  content hashing, handoff summaries, and exact-revision review decisions.
- Authenticated loopback control API, CLI, and MCP bridge.
- Agent adapter lifecycle with command supervision, readiness probes, recovery,
  cancellation handling, and capability reporting.
- Out-of-process `acc-adapter/1` protocol, deterministic echo adapter, and
  conformance runner covering idempotent start, artifact containment,
  capability honesty, reconciliation, workspace integrity, and secret
  redaction.
- ACCP message schemas, signed envelopes, generated schema bundle, fixtures,
  and valid/invalid test vectors.
- Outbound node enrollment, identity, durable state, and reconnect session
  primitives for compatible control planes.
- Credential-free verified-outcome demo proving source-checkout integrity,
  isolated execution, independent verification, evidence hashes, and a pending
  human review.
- License policy, third-party notices generation, SBOM generation, secret scan,
  and pinned GitHub Actions checks.

### Security

- Local daemon bearer-token authentication and artifact path containment.
- Bounded, supervised CLI execution with process-tree cleanup and explicit
  stale-run recovery.
- Ed25519 ACCP envelope signing and verification test vectors.

[Unreleased]: https://github.com/trietphan/agent-control-center-core/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/trietphan/agent-control-center-core/releases/tag/v0.1.0-alpha.1
