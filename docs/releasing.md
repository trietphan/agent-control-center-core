# Releasing Agent Control Center Core

Releases are evidence-bearing source/package candidates. The workflow does not
publish to npm, change repository visibility, approve a license decision, or
turn an unchecked legal gate into an approval.

## One-time repository configuration

Before enabling release access:

1. Create a GitHub environment named `release` and configure required human
   reviewers. Merely naming an environment in YAML does not create an approval
   policy.
2. Protect `main` with pull requests, CODEOWNERS review, conversation
   resolution, no force-push/delete, and required checks `secret-scan`,
   `verify (Node 20.19.0)`, `verify (Node 22.13.0)`,
   `verify (Node 24.0.0)`, `supply-chain`, `dependency-review`, and CodeQL where
   available.
3. Protect `v*` tags so only release maintainers can create or delete them.
4. Enable immutable releases, dependency graph, Dependabot alerts and security
   updates, native secret scanning, and push protection.
5. Restrict Actions to approved actions and retain the repository's
   full-commit-SHA pin check.
6. Enable private vulnerability reporting before inviting outside users.

CodeQL and dependency review run automatically for public repositories. While
the repository is private, set `CODEQL_PRIVATE_ENABLED=true` and
`DEPENDENCY_REVIEW_PRIVATE_ENABLED=true` only after confirming the account has
the required licensed GitHub features. Otherwise those jobs intentionally skip.

GitHub artifact attestations are available to public repositories and eligible
private repositories. A private release is blocked unless eligible access was
verified and the repository variable `ATTESTATIONS_PRIVATE_ENABLED=true` was
set. This prevents an unattested private candidate from being presented as a
complete release.

## Publication boundary

Complete and record every item in
[`legal-release-checklist.md`](legal-release-checklist.md) before changing the
repository to public. The visibility change is a separate human action outside
all workflows. The release workflow rechecks that the checklist has no open
boxes when the repository is public and requires a publication approval record
as workflow input.

Do not import private repository history. Start the reviewed export with a
signed commit, run a history-aware secret scan, and rotate any real credential
found even if history is later rewritten.

## Prepare a candidate

From a clean checkout with the supported Node.js runtime:

```bash
npm ci
npm run check
npm audit --audit-level=moderate
npm audit signatures
npm run security:secrets
# CI also runs the checksum-pinned TruffleHog provider detector over history.
npm run license:report
npm run sbom
```

Review the generated third-party inventory and CycloneDX SBOM. Generated files
are release evidence; they are not a substitute for the legal review of bundled
native libraries, assets, license expressions, or missing license metadata.

Update the package version and changelog through a reviewed pull request. After
that exact commit is on `main`, create a signed annotated tag. The signing key
must also be registered as a signing key on the maintainer's GitHub account so
the GitHub tag API reports it as verified.

```bash
git switch main
git pull --ff-only origin main
git tag -s v0.1.0-alpha.1 -m "Agent Control Center Core v0.1.0-alpha.1"
git verify-tag v0.1.0-alpha.1
git push origin refs/tags/v0.1.0-alpha.1
```

SSH signing is acceptable when Git and GitHub are configured for the same
registered SSH signing key. Lightweight and unsigned tags are rejected.

## Run the release workflow

Start the workflow manually so invocation and environment approval are explicit:

```bash
gh workflow run release.yml \
  --repo trietphan/agent-control-center-core \
  -f tag=v0.1.0-alpha.1 \
  -f public_approval_record=https://github.com/trietphan/agent-control-center-core/issues/123
```

Omit `public_approval_record` for an eligible private readiness candidate. For
a public release it must identify the recorded human publication decision; the
workflow records the value but does not pretend to evaluate its legal substance.

The workflow verifies the annotated tag through GitHub, matches the tag to the
checked-out commit and `package.json` version, runs all quality and supply-chain
checks, then creates:

- the npm-compatible `.tgz` package without publishing it;
- a CycloneDX production-dependency SBOM;
- deterministic third-party license metadata;
- `LICENSE`, `NOTICE`, and third-party notices;
- release evidence and `SHA256SUMS`;
- GitHub/Sigstore build-provenance attestations for release files; and
- an SBOM attestation bound to the package archive.

Private candidates are marked prerelease. Public releases are blocked while the
legal checklist is incomplete. npm publication, if ever approved, must use a
separate reviewed workflow and npm Trusted Publishing/OIDC; it must never be
silently added to this release workflow. The package lifecycle also fails
closed unless `ACC_PUBLICATION_APPROVED=true`, `ACC_PUBLIC_APPROVAL_RECORD`
identifies the recorded decision, `ACC_PUBLICATION_COMMIT` matches the exact
40-character Git commit, and the legal checklist contains no open box. These
variables are an execution interlock, not a substitute for the approvals.

## Verify as a consumer

Download all release assets into one directory, then run:

```bash
sha256sum --check SHA256SUMS
gh attestation verify agent-control-center-core-0.1.0-alpha.1.tgz \
  --repo trietphan/agent-control-center-core
npm install ./agent-control-center-core-0.1.0-alpha.1.tgz
./node_modules/.bin/acc --help
```

Verification links an artifact to its workflow and source commit; it does not
prove that the code is vulnerability-free. Consumers should still review the
SBOM, notices, release evidence, and security advisories. The runtime depends
on the pinned `sqlite3` native binding, so `npm install --ignore-scripts` is
useful only for static package inspection; it intentionally leaves the CLI
unable to open SQLite. Review the install-script policy and package provenance
before allowing the normal install.
