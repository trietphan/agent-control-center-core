# Dependency license decisions

The automated production dependency policy accepts common permissive SPDX
identifiers. Compound or unfamiliar expressions are reviewed explicitly here
and rechecked whenever the lockfile changes.

| Package | Locked expression | Distribution decision | Rationale |
| --- | --- | --- | --- |
| `expand-template@2.0.3` | `MIT OR WTFPL` | Select MIT | The package offers MIT as an alternative; retain its license text in generated attribution. |
| `rc@1.2.8` | `BSD-2-Clause OR MIT OR Apache-2.0` | Select MIT | The package offers multiple permissive alternatives; retain its license text in generated attribution. |

These engineering decisions remain part of the legal publication gate. New
compound expressions fail CI until added here with an owner and rationale.
