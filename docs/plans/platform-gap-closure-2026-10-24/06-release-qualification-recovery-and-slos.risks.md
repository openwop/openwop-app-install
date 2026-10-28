# Section 06 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Release qualification, full recovery and measured reliability](06-release-qualification-recovery-and-slos.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S06-K1 | Fault rehearsal damages production or leaks backup keys | M | H | High | Disposable isolated accounts, scoped fault authority and redaction; never run against customer DB | Reliability / release qualification | 2026-10-31 review; before live fault execution | Open |
| S06-K2 | Green report does not describe the deployed artifact | M | H | High | Digest/signature/revision binding and independent verifier; refuse ambiguous provenance | Reliability / release qualification | 2026-10-31 review; before release claim | Open |
| S06-K3 | Unobserved failure/failover is reported passed | M | H | High | Observable/causability mapping and blocked dispositions; record independent operator evidence | Reliability / release qualification | 2026-10-31 review; before A-grade reliability statement | Open |
