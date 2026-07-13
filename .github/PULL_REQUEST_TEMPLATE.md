## Summary

Describe the user or ecosystem outcome and the smallest implementation that
achieves it.

## Evidence

- Tests or conformance commands run:
- Security, protocol, or compatibility impact:
- Generated artifacts changed, if any:

## Checklist

- [ ] I used synthetic fixtures and did not commit credentials or customer data.
- [ ] `npm run check` passes from a locked install.
- [ ] Protocol changes include schema, test-vector, and compatibility updates.
- [ ] Adapter changes preserve cancellation, redaction, recovery, and permission boundaries.
- [ ] Security-sensitive changes include negative tests and request CODEOWNERS review.
- [ ] Dependency changes ran `npm run deps:refresh-evidence` and pass license, provenance, registry-signature, and vulnerability review.
- [ ] Documentation and changelog impact has been considered.
- [ ] My commits include the required `Signed-off-by` line under the project's DCO policy.
