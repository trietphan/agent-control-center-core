# Publication sign-off evidence - 2026-07-13

Repository: `trietphan/agent-control-center-core`
Approved commit under review: `80fb3ba8d528f001ec2a6ee3fa8a7e1965090ca9`
Repository visibility during this drill: private
Prepared by: ToDaMoon

This record collects the evidence available for public-readiness sign-off. It
does not replace owner, legal, IP, patent, license, or trademark approval.

## Technical evidence completed

- Local clean checkout: `/Users/trietphan/.openclaw/workspace/agent-control-center-core`
- `npm ci`: passed on Node `v25.8.0`; npm reported engine warning because the
  package supports Node `^20.19.0 || ^22.13.0 || ^24.0.0`.
- `npm run check`: passed on Node `v25.8.0`.
- Test result: 140 tests passed, 0 failed.
- License policy: passed; 151 production packages reviewed.
- Third-party license report: current; 150 packages.
- Action pin check: passed; 16 immutable remote action references.
- Dependency graph SBOM API: returned 368 packages.
- Dependabot alerts API: returned 0 alerts.
- Fresh clone onboarding drill:
  - Directory: `/tmp/acc-clean-clone.rSKSoo/repo`
  - Commit: `80fb3ba8d528f001ec2a6ee3fa8a7e1965090ca9`
  - `npm ci`: passed with the same Node `v25.8.0` engine warning.
  - `npm run check`: passed with 140 tests passed, 0 failed.

## GitHub controls configured

- Branch ruleset `main-public-readiness`, id `18898359`, is active for
  `refs/heads/main`.
- The branch ruleset blocks deletion and non-fast-forward updates.
- The branch ruleset requires pull request review before updating `main`.
- The branch ruleset requires these status checks:
  - `supply-chain`
  - `secret-scan`
  - `verify`
- Tag ruleset `semver-release-tags`, id `18898360`, is active for
  `refs/tags/v*`.
- The tag ruleset blocks deletion and non-fast-forward updates.
- Repository private-readiness variables were temporarily set to `true` to test
  private entitlement, then reset to `false` after CodeQL and dependency-review
  proved unavailable on the current private-repository plan.

## GitHub workflow evidence

- CI success for PR #4:
  `https://github.com/trietphan/agent-control-center-core/actions/runs/29269564892`
- CodeQL private-run dispatch:
  `https://github.com/trietphan/agent-control-center-core/actions/runs/29294089530`
  - Result: failed after scanning all files because code scanning is not
    enabled/accessible for this private repository.
- Dependency-review private rerun:
  `https://github.com/trietphan/agent-control-center-core/actions/runs/29269565307`
  - Result: failed because dependency review is not supported on this private
    repository without GitHub Advanced Security.

## Blockers that remain before public visibility

- CodeQL scanned 73 TypeScript files, 9 JavaScript files, and 4 GitHub Actions
  files, then failed to upload/report because code scanning is not enabled or
  accessible on the current private-repository plan.
- Dependency review is not supported on this private repository without GitHub
  Advanced Security. The rerun failed with: "Dependency review is not supported
  on this repository. Please ensure that Dependency graph is enabled along with
  GitHub Advanced Security."
- Private vulnerability reporting could not be enabled through the GitHub API;
  the endpoint returned 404 for this repository/token/plan.
- A signed tag release drill is blocked because this machine has no available
  GPG secret key or SSH signing key configured for Git signing.
- The current GitHub token is missing `admin:ssh_signing_key` and
  `admin:public_key`, so it cannot upload a GitHub SSH signing key.
- No signed release tag exists yet.
- The root commit is not cryptographically signed. The recommended decision is
  not to rewrite the root commit unless a human reviewer explicitly requires
  it; require signed annotated release tags going forward instead.
- Owner/legal sign-off is still required for copyright, contributor authority,
  IP, patent, license, trademark, and final visibility approval.

## Owner approval template

Use this section only after the blockers above are resolved or consciously
accepted by the repository owner and legal reviewer.

```text
I approve changing trietphan/agent-control-center-core from private to public.

Approved commit: 80fb3ba8d528f001ec2a6ee3fa8a7e1965090ca9
Release drill tag: <signed verified tag>
Approval record: docs/publication-signoff-evidence-2026-07-13.md
Approver: Triet Phan
Date: 2026-07-13

I have reviewed the legal/IP checklist, provenance, export inventory, Apache-2.0
license posture, NOTICE, third-party notices, SBOM/dependency evidence, secret
scan evidence, GitHub protection settings, signing evidence, and contributor
onboarding evidence. I accept the remaining recorded risks or confirm they have
been resolved.
```

## Owner approvals recorded - 2026-07-16

Repository owner Triet Phan explicitly approved all three remaining hard gates
on 2026-07-16:

1. Legal/IP/patent/license/trademark and contributor-authority approval.
2. Creation and use of a dedicated cryptographic release-signing key and a
   signed private release drill. The root commit will not be rewritten; signed
   annotated release tags are required going forward.
3. Changing `trietphan/agent-control-center-core` from private to public after
   the signed release drill is verified.

The open-core export boundary was merged in the private source repository as
`trietphan/agent-control-center` PR #5, merge commit
`a4bafbb408d0bdc919c97f2e4ff699093b843af8`.

A dedicated Ed25519 signing key was generated on 2026-07-16 with fingerprint
`SHA256:bWKsl0W8rv/9pwzmxZs/7o9izSuApsecIJZghd7vEP0`. GitHub verification and the
signed release drill must be recorded before the final signing checklist item
is checked and before repository visibility changes.
