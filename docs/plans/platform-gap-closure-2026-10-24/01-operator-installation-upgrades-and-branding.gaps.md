# Section 01 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Operator installation, upgrades and complete branding](01-operator-installation-upgrades-and-branding.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S01-G1 | Which historical release paths are contractually supported? | Release owner | Enumerate published artifacts and migration reachability; approve explicit matrix | upgrade planner implementation |
| S01-G2 | Which six test accounts/regions and native signing toolchains are available? | Infrastructure owner | Provision isolated fixtures and budget; mark unavailable tier blocked | per-tier qualification |
| S01-G3 | What settings are runtime-safe versus rebuild/maintenance only? | Brand/auth owners | Trace each current consumer and approve field matrix | config handoff |

> **2026-10-24 (Wave A2):** `scripts/upgrade-plan.mjs` now plans every pair of the eight published releases mechanically, and S01-T2 runs all 28. That is what the manifest SAYS each path needs, not a decision that a path is supported. S01-G1 stays open; the planner no longer waits on it, but a published support matrix does.

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.
