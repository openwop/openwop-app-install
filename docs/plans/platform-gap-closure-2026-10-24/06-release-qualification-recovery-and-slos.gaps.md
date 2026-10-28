# Section 06 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Release qualification, full recovery and measured reliability](06-release-qualification-recovery-and-slos.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S06-G1 | What buyer-approved SLO, RPO/RTO and capacity bounds apply per topology? | Product + reliability owners | Translate declared objectives/customer needs into workload/threshold manifest | claim and pass criteria |
| S06-G2 | What isolated infrastructure, provider fixtures, budget and fault authority are available? | Infrastructure/security owners | Provision disposable resources; approve destructive fault boundaries and limits | live qualification execution |
| S06-G3 | Who operates independent restore and cross-host exchange? | Release/security sponsor | Assign non-author reviewer/operator and obtain host participation | independent evidence |
| S06-G4 | How are 28 days of SLIs collected before a new release claims attainment? | Reliability owner | Start measurement on qualified baseline; separate elapsed evidence from code delivery | SLO attainment closure |

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.
