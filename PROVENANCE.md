# Source provenance

## Extraction record

This repository began as a clean-history, allowlisted extraction from an
original private Agent Control Center codebase. `EXPORT-INVENTORY.json` records
the selected source paths and publication-safe exclusion categories. The exact
private allowlist remains in the private repository so unrelated path names are
not exposed as public metadata. No Git objects,
branches, tags, issues, screenshots, user data, credentials, brand assets,
managed-cloud implementation, donor-repository files, or strategy documents
were imported.

The extraction boundary was reviewed against production imports and tests. The
only runtime dependency on the private managed-cloud implementation was a
dynamic CLI command registration; that entire command group is absent here.
Outbound ACCP node support remains as an interoperable client boundary.

## Authorship classes

- `src/**` and the selected `test/**` files are original Agent Control Center
  implementation and tests exported under Apache-2.0 by the repository owner,
  subject to the legal publication gate.
- `protocol/**` is generated from public Zod schemas and synthetic fixtures.
- `examples/**`, public documentation, governance files, and workflows were
  authored specifically for the clean repository.
- `LICENSE` is the Apache License 2.0 text. Third-party dependencies are not
  copied into source control; their locked metadata and attributions are
  generated and reviewed separately.

## Required verification

Before any visibility change or release, maintainers must:

1. regenerate the file hash inventory from the exact commit;
2. run full-history gitleaks plus the repository provider-pattern scan;
3. generate and review third-party license inventory and CycloneDX SBOM;
4. confirm no file matches the explicit private exclusions;
5. complete copyright, patent, and trademark review; and
6. record reviewer identity and date in the release evidence.

This document records engineering provenance. It does not replace legal review.
