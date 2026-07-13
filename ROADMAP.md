# Public roadmap

Agent Control Center Core aims to make agent execution inspectable, recoverable,
and interoperable. The roadmap prioritizes verified outcomes and safe extension
points over adding more conversational UI.

This is a direction, not a delivery promise. Scope and order can change with
security findings, compatibility evidence, contributor capacity, and user
feedback. Accepted work is tracked in public issues and pull requests.

## Product principles

1. **Local Core remains useful alone.** A hosted account is never required for
   local tasks, evidence, review, CLI, or MCP.
2. **Evidence before trust.** Agent output is an input to independent
   verification, not proof of success.
3. **Human decisions are exact.** Approval binds to a known evidence revision.
4. **Effects are explicit.** Adapters declare workspace, network, secrets,
   cancellation, and side-effect capabilities.
5. **Recovery is a product behavior.** Restart, duplicate delivery, stale
   leases, partial artifacts, and unconfirmed cancellation are first-class test
   cases.
6. **Interoperability is versioned.** Protocols, manifests, fixtures, and
   conformance results evolve under documented compatibility rules.

## Now: make the alpha reproducible

Release gate for the `0.1.x` line:

- Fresh clone reaches a credential-free verified outcome in under five minutes.
- `npm ci` and `npm run check` require no private registry or managed service.
- README commands are continuously exercised, not illustrative pseudocode.
- Public protocol artifacts are generated deterministically and drift-checked.
- Fixture adapter conformance runs on every supported Node.js line.
- Conformance reports bind the parsed manifest and tested file or command
  descriptor to SHA-256 digests, plus platform and Node.js version.
- Release artifacts include licenses, third-party notices, SBOM, checksums, and
  provenance.
- Security, support, DCO, conduct, governance, trademark, and maintainer
  policies are operational.

## Next: dependable adapter authoring

Target for the `0.2.x` line:

- Publish a versioned adapter manifest schema and capability vocabulary.
- Provide a scaffold that produces a passing deterministic adapter from a fresh
  directory.
- Expand conformance for slow start, durable-start failure, output overflow,
  timeouts, process-tree cancellation, unsupported operations, restart,
  reconciliation, cleanup, and secret canaries.
- Distinguish installed, authenticated, authorized, and degraded readiness.
- Strengthen artifact identity for `PATH`-resolved executables, package trees,
  and container images, and support portable signed conformance attestations.
- Add compatibility and deprecation matrices for first-party adapters.
- Document least-privilege examples for read-only, worktree-write, networked,
  and externally side-effecting adapters.

Exit evidence: a new contributor can author a minimal adapter, pass conformance
locally and in CI, and understand exactly what the result does and does not
certify.

## Then: protocol and operational resilience

Target for the `0.3.x` line:

- Publish normative ACCP documentation alongside generated schemas and golden
  transcripts.
- Add conformance scenarios for duplicate, reordered, missing, and replayed
  messages; reconnect; clock skew; invalid signatures; version mismatch;
  interrupted upload; outage overflow; failed preconditions; and idempotency
  conflict.
- Define supported-version negotiation and deprecation windows.
- Expand crash-safe recovery and operator-visible reconciliation evidence.
- Make evidence bundles portable and independently verifiable without database
  access.
- Add deterministic load and fault-injection tests for queues, leases, artifact
  limits, and concurrent review decisions.

Exit evidence: compatible independent nodes can survive interruption and prove
the same final task, evidence, and decision state.

## Toward 1.0

The project will not call an API stable merely because it is old. A 1.0 release
requires:

- A documented stable task, adapter, evidence, review, and ACCP contract.
- Tested migrations from every supported persisted-data version.
- Explicit compatibility and security-support windows.
- A reviewed threat model for local execution and remote coordination.
- Reproducible signed releases with provenance and rollback instructions.
- At least two active people capable of independent protected-area review, or a
  documented governance alternative with equivalent checks.
- Evidence from real external adapter authors, not only first-party fixtures.

## Public extension opportunities

Contributions are especially useful for:

- Synthetic fixture repositories for different languages and build systems.
- Adapter conformance edge cases and platform portability.
- Protocol implementations in other languages.
- Evidence viewers, CLI ergonomics, and accessible operator clients using the
  public API or MCP bridge.
- Reproducible sandbox profiles for higher-risk execution.
- Recovery, cancellation, and idempotency tests against real failure modes.

Open a proposal issue before beginning a compatibility-sensitive change. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [GOVERNANCE.md](GOVERNANCE.md).

## Explicit non-goals

- Replacing Codex, Claude, OpenClaw, or other agents.
- Becoming a fourth generic chat application.
- Treating a Git worktree as a security sandbox.
- Guaranteeing agent correctness without user-defined verification.
- Hiding provider data transfer or spending behind the local demo.
- Shipping customer authentication, billing, multi-tenant operations, or a
  managed dashboard from this Core repository.

A separately operated managed service may implement the last category using
public Core interfaces. Its private roadmap, availability, and commercial terms
are outside this public roadmap.
