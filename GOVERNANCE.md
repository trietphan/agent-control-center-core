# Governance

Agent Control Center Core is intended to be maintained in public after its
publication gates are complete. The
governance goal is dependable evolution of the protocol and execution kernel,
with decisions grounded in user outcomes, interoperability, safety, evidence,
and long-term maintainability.

The Apache-2.0 license governs code use. The
[Developer Certificate of Origin](DCO) governs contribution provenance. The
[Trademark Policy](TRADEMARKS.md) governs project names and marks.

## Project roles

### Contributor

Anyone who reports a reproducible issue, improves documentation, reviews a
change, authors code, or helps another participant. Contributors have no commit
access by default.

### Reviewer

A contributor trusted to review an area based on demonstrated expertise.
Reviewers may approve changes but cannot merge unless they are also a
maintainer. Review status is scoped and can be withdrawn for inactivity,
conflicts, or repeated unsafe review.

### Maintainer

A person entrusted with triage, merge decisions, releases, governance, and
community stewardship. Maintainers must act for the health of the public
project, disclose conflicts, preserve compatibility or document breaks, and
enforce the Code of Conduct.

### Release manager

A maintainer assigned to coordinate one release, verify its checks and
provenance, publish artifacts, and record the changelog. Assignment does not
permit bypassing review or security gates.

### Security responder

A maintainer or explicitly delegated reviewer authorized to receive private
vulnerability reports. Security responders follow `SECURITY.md` and share
details only on a need-to-know basis.

Current role holders are listed in [MAINTAINERS.md](MAINTAINERS.md).

## Decision process

### Routine changes

Bug fixes, tests, and documentation normally proceed by pull request. The author
must satisfy required checks and DCO sign-off. One non-author maintainer approval
is sufficient when the change is low-risk, compatible, and within established
scope.

### Material changes

Start with a public proposal issue for changes to:

- ACCP, task, adapter, evidence, review, or persistence contracts.
- Trust boundaries, process execution, isolation, secrets, or artifact storage.
- Compatibility policy, governance, licensing, trademarks, or releases.
- Major dependencies, extension mechanisms, or externally operated services.

The proposal should define the user problem, constraints, alternatives,
compatibility impact, threat-model impact, rollout, recovery, and measurable
acceptance evidence. Maintainers should leave at least seven calendar days for
community feedback unless an actively exploited vulnerability requires a
private and expedited response.

Protected changes require two qualified approvals, including at least one
non-author maintainer. The second approval may come from another maintainer or a
reviewer explicitly recognized for that area. No one may approve their own
change. If qualified independent review is unavailable, the change waits.

### Reaching a decision

The project prefers reasoned consensus. Consensus means substantive objections
have been resolved or explicitly answered; it does not require unanimity. When
consensus is not possible, a non-conflicted maintainer records the decision and
its rationale in the proposal or pull request. For protected changes, the
required independent approvals still apply.

Decisions may be revisited when new evidence, incidents, compatibility data, or
maintainer capacity materially changes the tradeoff.

## Merge and release authority

- Only maintainers merge to protected branches.
- Authors do not merge their own pull requests except for an emergency after an
  independent approval is recorded.
- Required checks and DCO sign-off cannot be waived for convenience.
- Security embargoes may keep vulnerability details private until a fix is
  available, but the eventual release record should explain the user impact.
- A release manager verifies the changelog, license/NOTICE state, SBOM,
  checksums, provenance, signatures, protocol compatibility, and rollback path.

Pre-1.0 releases may change APIs, but every intentional break must be prominent
in the changelog and include a migration path when persisted data or external
adapters are affected.

## Selecting maintainers and reviewers

Existing maintainers may nominate a contributor who has demonstrated:

- Sustained, constructive participation over time.
- Sound judgment on compatibility, security, and operator experience.
- Reliable review of failure paths, not only happy paths.
- DCO-compliant contributions and respect for project policies.
- Capacity to triage and communicate decisions.

The nomination is public for at least seven days. A protected-change decision
then updates `MAINTAINERS.md`. The same process can scope a reviewer to a
specific subsystem.

Maintainers may step down at any time. A maintainer may be moved to emeritus
status after six months without project activity, after reasonable private
contact. Removal for misconduct, undisclosed conflicts, credential misuse, or
repeated unsafe action follows the Code of Conduct and requires non-conflicted
review.

## Conflicts of interest

Participants must disclose financial, employment, personal, or competitive
interests that a reasonable reviewer would consider relevant. A conflicted
person may provide technical context but must not be the deciding approval.
Paying for or operating a service does not buy control of public project
decisions.

## Open-core boundary

This governance covers the code, protocols, documentation, releases, and
community spaces in this repository. A separately operated managed control
plane may provide hosted UI, authentication, multi-tenant storage, billing,
policy, and support. Its private implementation and business operations are not
governed here.

Changes to public interfaces used by a managed service remain subject to the
same compatibility and review rules as every other Core change. The local Core
must remain useful without a hosted account.

## Governance changes

Changes to this file are protected changes. Proposals must explain the observed
governance problem, expected behavior, transition plan, and how minority or
conflicted participants are protected. The decision and effective date must be
recorded in the pull request and changelog.
