# Dependency install-script policy

Install scripts are denied unless the exact locked package version is recorded
in `package.json#allowScripts`. This is an executable-code review boundary,
separate from license and vulnerability checks.

| Package | Decision | Why |
| --- | --- | --- |
| `sqlite3@6.0.1` | allow | Runtime database binding; installs a registry-signed prebuild or compiles the pinned source. |
| `esbuild@0.28.1` | allow | Pinned development compiler used by `tsx`; its postinstall selects and verifies the platform binary. |
| `libxmljs2@0.37.0` | allow | Pinned development-only transitive dependency of the license inventory tool. |
| `fsevents@2.3.3` | deny | Optional file-watcher optimization is not required by build, test, conformance, or release paths. |

Any version change reopens review. CI lists pending install scripts and fails if
the allowlist does not cover the clean lockfile install.
