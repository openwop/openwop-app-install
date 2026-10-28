# Section 03 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Distributed admission and resource budgets](03-distributed-admission-and-resource-budgets.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S03-K1 | Reservation leak or double release over-admits work | M | H | High | Atomic state transitions, fencing and crash matrix on real DB | Runtime / storage engineering | 2026-10-31 review; before hard-ceiling claim | Open |
| S03-K2 | Shared-counter DB saturation makes admission unavailable | M | H | High | Reuse pool, bounded contention, measured hot-key and overload load tests | Runtime / storage engineering | 2026-10-31 review; before scaled release | Open |
