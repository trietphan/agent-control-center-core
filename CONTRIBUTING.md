# Contributing to Agent Control Center Core

Thank you for helping build a dependable, interoperable control plane for agent
work. Contributions are welcome across code, tests, protocols, adapters,
documentation, security hardening, and developer experience.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md)
and the project governance described in [GOVERNANCE.md](GOVERNANCE.md).

## Before starting

Search existing issues and pull requests before opening overlapping work. Open
an issue or proposal before investing in a change that:

- Alters ACCP, task, adapter, evidence, or review contracts.
- Changes trust boundaries, process execution, worktree isolation, secrets, or
  artifact handling.
- Adds a dependency or provider integration.
- Introduces a database migration or compatibility break.
- Requires ongoing maintainer or release infrastructure.

Small fixes, tests, and documentation corrections can go directly to a pull
request.

Security vulnerabilities must not be reported in a public issue. Follow
[SECURITY.md](SECURITY.md).

## Set up a development checkout

Use a Node.js version accepted by `package.json` and a current Git client.

```bash
git clone https://github.com/trietphan/agent-control-center-core.git
cd agent-control-center-core
npm ci
npm run demo:verified-outcome
npm run check
```

The demo is credential-free. The full check gate must pass without provider
credentials, a private registry, or access to a managed service.

## Make a focused change

1. Create a branch from the current default branch.
2. Keep the change scoped to one reviewable outcome.
3. Add or update tests for behavior changes and failure paths.
4. Update public contracts, examples, and docs in the same pull request.
5. Run the smallest relevant test while iterating, then `npm run check` before
   requesting review.
6. Sign every commit under the DCO.

Do not commit generated local state, provider credentials, user prompts,
customer repositories, production logs, private endpoints, or `.acc/` data.
Tests and examples must use synthetic identities and deterministic fixture data.

### Protocol changes

Treat schemas and test vectors as public compatibility promises. A protocol pull
request must include:

- The intended compatibility impact and migration path.
- Parser and validation tests for valid and invalid input.
- Updated generated artifacts from `npm run generate:protocol`.
- A clean `npm run generate:protocol:check` result.
- Relevant conformance or replay cases.

Do not weaken size limits, signature checks, idempotency, sequence handling, or
preconditions merely to make a fixture pass.

### Adapter changes

Adapters must report capabilities honestly. Their implementation should be
out-of-process at the third-party extension boundary, keep protocol responses on
stdout, send diagnostics to stderr, bound output, and clean up process trees and
artifacts after failure.

Run the fixture conformance suite:

```bash
npm run conformance:fixture
```

For another executable:

```bash
npm run conformance -- \
  --command node \
  --arg path/to/adapter.mjs \
  --report conformance-report.json
```

Include the report summary in the pull request. A passing report covers the
implemented suite only; it is not a blanket security certification.

### Database and recovery changes

Migrations must be forward-only, deterministic, restart-safe, and tested from
the oldest supported schema. Changes to leases, retries, cancellation, or
recovery must include tests for interruption and duplicate-side-effect risk.
Never silently rerun an operation whose external side effects cannot be proven
idempotent.

### Dependency changes

Dependency updates deliberately fail the provenance gate until the generated
evidence is refreshed. This also applies to Dependabot branches. Check out the
proposed lockfile, review install scripts and version compatibility, then run:

```bash
npm ci
npm run deps:refresh-evidence
npm audit --audit-level=moderate
npm audit signatures
npm run check
```

Commit the reviewed lockfile, third-party inventory, and file inventory
together. Major runtime, type-definition, compiler, native-module, or protocol
dependency updates should remain separate pull requests so their compatibility
impact is independently visible.

### Documentation changes

Prefer a verifiable outcome over a feature claim. Commands in getting-started
content must work from a fresh checkout and identify when credentials, network
access, or provider spending begins. Keep the distinction between the local
open-source Core and any separately operated managed service explicit.

## Required checks

The canonical local gate is:

```bash
npm run check
```

It includes exported-file inventory and generated-protocol drift checks,
type-checking, build, tests, adapter conformance, credential-free outcome,
license policy, and pinned-action checks. Depending on the change, maintainers
may also request:

```bash
npm run security:secrets
npm run sbom
npm run license:report
```

Review generated reports before sharing them and do not commit them unless the
pull request explicitly updates a tracked release artifact.

## Developer Certificate of Origin

This project uses the DCO instead of a contributor license agreement. Sign each
commit with a real name and an email address you are authorized to use:

```bash
git commit -s -m "fix: describe the outcome"
```

Git adds a trailer like:

```text
Signed-off-by: Your Name <you@example.com>
```

The sign-off certifies the [Developer Certificate of Origin](DCO). It is not a
generic acknowledgment and must be added by the contributor, not by a bot or
maintainer on the contributor's behalf. To sign an existing local commit:

```bash
git commit --amend --signoff --no-edit
```

Rebase and sign each commit if a pull request contains more than one unsigned
commit.

## Pull request checklist

In the pull request description, include:

- The user or operator problem and the verified outcome.
- Scope and important non-goals.
- Trust-boundary and compatibility impact.
- Test commands and results.
- Screenshots only when UI output changed, using synthetic data.
- Follow-up work or known limitations.

Reviewers may ask for a smaller pull request when unrelated concerns are mixed.
Approval is not guaranteed merely because checks pass; maintainers also assess
safety, maintainability, compatibility, and project scope.

## Licensing and provenance

Contributions are licensed under Apache-2.0. Keep existing copyright and NOTICE
information. Identify copied or adapted material in the pull request and retain
required attribution. Do not submit code, fixtures, prompts, screenshots, or
design assets unless you have the right to contribute them under the repository
license.

Project names and marks are governed separately by
[TRADEMARKS.md](TRADEMARKS.md).

## Getting help

Use [SUPPORT.md](SUPPORT.md) to choose the correct public or private channel.
Maintainers and their current responsibilities are listed in
[MAINTAINERS.md](MAINTAINERS.md).
