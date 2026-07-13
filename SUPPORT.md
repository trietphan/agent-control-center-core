# Support

Agent Control Center Core is pre-1.0 software. Community support is best-effort,
public by default, and focused on reproducible behavior in the open-source Core.
No response time or resolution time is guaranteed.

## Choose the right channel

| Need | Channel |
| --- | --- |
| Reproducible bug in Core | [Open a GitHub issue](https://github.com/trietphan/agent-control-center-core/issues/new) |
| Feature or protocol proposal | Open an issue before implementation |
| Usage question | Open an issue with the `question` prefix in the title |
| Security vulnerability | Follow [SECURITY.md](SECURITY.md); do not open a public issue |
| Conduct concern | Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) privately |
| Managed-service account, billing, or service incident | Use that service's support channel; do not post account data here |

Before reporting a bug, run the credential-free baseline:

```bash
npm ci
npm run demo:verified-outcome
npm run check
```

If the baseline fails, include the first failing command and its output. If it
passes but a real adapter fails, run:

```bash
npm run acc -- doctor --json
```

Redact usernames, repository paths, access tokens, prompts, customer content,
provider request IDs, and any other sensitive value before sharing output.

## A useful bug report

Include:

- Core version or commit SHA.
- Operating system, architecture, Node.js version, npm version, and Git version.
- Exact command and minimal steps to reproduce.
- Expected result and actual result.
- Whether the credential-free demo and conformance fixture pass.
- Sanitized logs or a minimal synthetic repository.
- Whether the issue is deterministic, intermittent, or recovery-related.

Do not upload `.acc/`, database files, daemon tokens, private keys, real provider
transcripts, or an entire customer repository. Maintainers may close reports
that cannot be investigated safely and reproducibly.

## Supported environments

The supported Node.js ranges are the ranges declared in `package.json`. The
project tests the operating systems and versions represented by its current CI
configuration; an environment working outside those ranges does not make it a
supported environment.

Before 1.0, support normally targets:

- The current pre-release line.
- The current default branch for contributor verification.
- Protocol versions explicitly listed as supported by the current release.

Compatibility fixes for older snapshots are considered when they protect data
or provide a low-risk migration path, but there is no general backport promise.

## Provider and third-party boundaries

Codex, Claude, OpenClaw-compatible endpoints, Git hosts, and other integrations
are separate products. Their installation, authentication, uptime, pricing,
model output, and policy enforcement are controlled by their providers. A Core
adapter bug can be reported here; provider account or billing problems cannot
be resolved by this project.

Real adapters may transmit context and incur charges. Reproduce with the local
fixture when possible. Never share credentials with maintainers.

## Managed-service boundary

This repository contains the local execution core and public interoperability
interfaces. It does not contain a hosted dashboard, customer authentication,
multi-tenant database, billing system, or managed service operations. A
separately operated service may use these interfaces, but its account and
incident support belong in that service's private support channel.

## Commercial support

No commercial support offering is promised by this repository. If one is
offered elsewhere, purchasing it does not change the open-source governance,
license, issue priority rules, or security disclosure process.
