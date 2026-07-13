# Open-source readiness status

The repository is intentionally private while publication gates are incomplete.
Passing code checks means the export is technically healthy; it does not imply
legal approval or authorize a visibility change.

## Implemented in the clean repository

- [x] New Git history with no private monorepo history (created at first commit).
- [x] ACCP schemas, generated schema digest, UUIDv7 identifiers, and
  language-neutral valid/invalid/canonical/signed test vectors.
- [x] Provider-neutral out-of-process adapter SDK and executable conformance
  fixture.
- [x] Local SQLite/task/worktree/verifier/evidence execution kernel and CLI.
- [x] Outbound node runtime and structural MCP control-client boundary.
- [x] Credential-free verified-outcome demo with exact review revision.
- [x] Apache-2.0 text, NOTICE, provenance, community, security, support,
  governance, compatibility, and trademark documentation.
- [x] SHA-pinned CI, gitleaks, CodeQL, dependency review, SBOM/checksum/
  attestation release workflow, Dependabot, and action-pin checks.
- [x] npm publication interlock requires a completed legal checklist, an
  approval record, and the exact approved Git commit.

## Evidence required on the initial private GitHub repository

- [ ] All local checks green from a clean clone on the supported Node matrix.
- [ ] Full clean history passes gitleaks and provider-pattern scanning.
- [ ] Dependency licenses, registry signatures, vulnerabilities, and SBOM
  manually reviewed.
- [ ] CodeQL and dependency review green on GitHub.
- [ ] Private vulnerability reporting enabled and tested.
- [ ] Branch and tag rulesets enabled with required reviews/checks.
- [ ] Private signed-tag release drill produces checksums, SBOM, and provenance.

## Human gates before public visibility

- [ ] Legal/IP/patent/license review signed.
- [ ] Trademark/name policy signed; no third-party brand assets included.
- [ ] Copyright and contributor authority confirmed.
- [ ] Security, incident, and release owners accept their roles.
- [ ] Signed release key ownership and recovery procedure verified.
- [ ] External contributor completes onboarding from a clean machine.
- [ ] Repository owner records a separate visibility-change approval.

See `docs/legal-release-checklist.md` and `docs/releasing.md`. Any unchecked
human gate means the repository stays private.
