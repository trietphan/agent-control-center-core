# Maintainers

This file records who may merge, coordinate releases, and make governance
decisions for Agent Control Center Core. It is intentionally separate from Git
hosting permissions: a permission grant is not valid project authority unless
the person is listed here.

## Active maintainers

| GitHub | Role | Primary responsibilities |
| --- | --- | --- |
| [@trietphan](https://github.com/trietphan) | Bootstrap maintainer and release owner | Repository stewardship, architecture, release coordination, community triage |

The project is in bootstrap governance. Its near-term bus-factor goal is at
least two active maintainers with independent release and security review
capacity. Until then, protected changes wait for the independent qualified
review required by [GOVERNANCE.md](GOVERNANCE.md).

## Review ownership

No subsystem reviewer roles are currently delegated. Review expertise will be
recorded here as contributors establish sustained ownership of areas such as:

- ACCP and generated protocol artifacts.
- Adapter SDK and conformance.
- Local execution, process supervision, and worktrees.
- SQLite migrations, leases, recovery, and evidence.
- CLI, MCP, public API, documentation, and developer experience.
- Security response, dependency policy, and release provenance.

## Contact and escalation

- For normal bugs and proposals, use the public issue tracker.
- For vulnerabilities, use the private channel in `SECURITY.md`.
- For conduct reports, use the private process in `CODE_OF_CONDUCT.md` and
  contact a non-involved maintainer.
- For account, billing, or incidents in a separately operated managed service,
  use that service's support channel.

Maintainers never need a contributor's provider token, daemon token, private
key, production database, or customer repository to provide community support.

## Updating this file

Adding, removing, or changing a maintainer or delegated reviewer follows the
protected governance process. The pull request must record the nomination,
scope, public feedback period, approvals, and effective date. Emeritus
maintainers may be listed in a future section but retain no merge authority by
that designation alone.
