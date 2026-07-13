# Third-party notices

The authoritative dependency inventory is generated from the locked production
dependency tree:

```bash
npm ci
npm run license:report
```

`third-party-licenses.generated.json` records package name, installed version,
license expression, repository, and local license-file paths. The release
workflow regenerates this inventory and the CycloneDX SBOM from a clean lockfile
install.

Apache-2.0, MIT, BSD, ISC, 0BSD, BlueOak-1.0.0, CC0-1.0, and Python-2.0
dependencies are accepted by the automated policy. Copyleft, source-available,
unknown, compound, bundled-asset, MPL, LGPL, and CC-BY findings require a
documented maintainer and legal review before distribution.

This file is not a substitute for the generated inventory or legal review.
