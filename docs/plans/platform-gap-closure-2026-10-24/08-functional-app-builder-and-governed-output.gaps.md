# Section 08 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Functional app-builder output and governed deployment](08-functional-app-builder-and-governed-output.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S08-G1 | Which adapter/stack is first and which credentialed environment qualifies it? | App-builder + infrastructure owners | Accept ADR 0348/0349 amendment and provide isolated target | live backend/deploy implementation |
| S08-G2 | How are custom action bindings declared and constrained without arbitrary unreviewed code? | App-builder/security owners | Review closed operation catalog/adapter semantics and schema | backend action implementation |
| S08-G3 | Which targets need platform-specific equivalents rather than identical CSS/runtime behavior? | Generator owners | Define target parity matrix and executable fixtures | per-target A grade |

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.
