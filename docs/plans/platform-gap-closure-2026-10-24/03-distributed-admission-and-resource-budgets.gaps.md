# Section 03 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Distributed admission and resource budgets](03-distributed-admission-and-resource-budgets.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S03-G1 | Do waiting approvals/queued runs count toward which resource ceiling? | Runtime + product owners | Measure resource consumption and approve state-by-scope table (decided 2026-10-27: [ADR 0987](../../adr/0987-durable-run-admission.md), Accepted) | reservation semantics |
| S03-G2 | Which monthly budgets are contractual hard limits versus availability-oriented reporting? | Billing + runtime owners | Trace current lanes and record explicit failure posture/correction (decided 2026-10-27: [ADR 0987](../../adr/0987-durable-run-admission.md), Accepted) | strict policy migration |
| S03-G3 | Which shared transaction/constraint shape works on both supported DBs? | Storage owner | Prototype real Postgres/SQLite absent-key and atomic admission races (decided 2026-10-27: [ADR 0987](../../adr/0987-durable-run-admission.md), Accepted) | schema implementation |

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.
