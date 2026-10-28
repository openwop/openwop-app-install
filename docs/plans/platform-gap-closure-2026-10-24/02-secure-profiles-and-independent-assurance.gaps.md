# Section 02 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Secure deployment profiles and independent assurance](02-secure-profiles-and-independent-assurance.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S02-G1 | Which controls are mandatory in each supported production tier? | Security + infrastructure owners | Approve minimum-control matrix and migration policy (decided 2026-10-26: [ADR 0981](../../adr/0981-secure-production-profile.md), Accepted) | strict-profile rollout |
| S02-G2 | Which assessor, budget, confidential scope and retest capacity are approved? | David Tufts / security sponsor | Commission scoped engagement; do not fabricate certification | SEC-02 independent closure |
| S02-G3 | Which isolation adapter claims are actually enabled in each released image? | Runtime security owner | Read advert/config and perform containment probes | untrusted pack claim |

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.

Additional verified input: dependency-alerts.json captures 28 open GitHub matches (4 high). Per-package reachability and compatible upgrade choice remain part of S02-R4/SEC-02 implementation assessment, not a claim that the audit is complete.
