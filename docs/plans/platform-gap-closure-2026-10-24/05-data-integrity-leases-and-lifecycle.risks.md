# Section 05 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Data integrity, lease fencing and lifecycle completeness](05-data-integrity-leases-and-lifecycle.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S05-K1 | Expired holder commits money/identity mutation after replacement | M | H | High | Fencing checked at authoritative write or one DB transaction; prove delayed-holder fixture | Storage / data integrity engineering | 2026-10-31 review; before lease rollout | Open |
| S05-K2 | Migration/erasure drops replay or legally retained evidence | M | H | High | Field-level lineage, exemption review, old-run tests and coherent restore | Storage / data integrity engineering | 2026-10-31 review; before data migration release | Open |
