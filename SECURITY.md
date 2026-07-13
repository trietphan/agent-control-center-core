# Security policy

Agent Control Center Core executes developer tools against source repositories.
Treat findings involving process isolation, path handling, credentials,
signatures, authorization, evidence integrity, or recovery as security-sensitive.

## Supported versions

This project is pre-1.0. Only the latest published release receives security
fixes. Older alpha versions are unsupported unless a release advisory says
otherwise.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/trietphan/agent-control-center-core/security/advisories/new).
Do not open a public issue, discussion, or pull request containing vulnerability
details, proof-of-concept code, credentials, private repository material, or
customer data.

If private vulnerability reporting is temporarily unavailable, contact the
repository owner through their GitHub profile and request a private channel.
Do not include vulnerability details in that initial public message.

Include, when safe:

- the affected release and component;
- impact and required attacker access;
- a minimal reproduction using synthetic data;
- whether credentials, signatures, filesystem boundaries, or external effects
  are involved; and
- suggested mitigations or disclosure constraints.

## Response targets

These are response objectives, not warranties:

- acknowledgement within three business days;
- initial severity and scope assessment within seven business days;
- an update at least every seven days while remediation is active; and
- coordinated disclosure after a fix or mitigation is available.

Release timing depends on severity, exploitability, compatibility risk, and the
ability to verify a safe fix. Maintainers may request additional time before
public disclosure when users need a coordinated upgrade window.

## In scope

Examples include:

- ACCP signature, replay, identity, workspace-binding, or canonicalization flaws;
- command injection, unsafe environment propagation, or cancellation escape;
- worktree, symlink, path traversal, or artifact boundary bypass;
- credential, prompt, log, or evidence disclosure;
- authorization confusion between user, node, adapter, and managed service;
- idempotency or recovery defects that duplicate an irreversible effect; and
- release, dependency, or provenance controls that allow artifact substitution.

General bugs without a security impact belong in the public bug template.
Reports that rely only on unsupported versions, already-public findings without
new impact, or denial of service requiring control of the local machine may be
closed as out of scope.

## Disclosure and credit

We prefer coordinated disclosure and will credit reporters who request it.
Do not access data you do not own, degrade third-party systems, or retain real
credentials while researching. This policy does not grant authorization to
test systems or repositories that you do not control.
