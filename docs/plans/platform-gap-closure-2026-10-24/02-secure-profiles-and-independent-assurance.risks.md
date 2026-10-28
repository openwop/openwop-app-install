# Section 02 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Secure deployment profiles and independent assurance](02-secure-profiles-and-independent-assurance.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S02-K1 | Profile migration locks out legitimate operators | M | H | High | Exercise bootstrap/recovery and staged compatibility before enforcing | Security / identity engineering | 2026-10-31 review; before profile rollout | Open |
| S02-K2 | Provenance mistaken for hostile-code isolation | M | H | High | Independent deployed-image escape/network probes plus dependency-alert triage/regression; claim only proven tier | Security / identity engineering | 2026-10-31 review; before untrusted execution advertisement | Open |
