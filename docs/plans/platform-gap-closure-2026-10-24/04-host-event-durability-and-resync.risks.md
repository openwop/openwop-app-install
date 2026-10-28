# Section 04 — Risk register

Status: Proposed mitigation plan; no risk is closed. Parent: [Host-event durability, fan-out and resynchronization](04-host-event-durability-and-resync.prd.md).

Likelihood/impact are qualitative judgments, not observed frequencies. High-risk review target **2026-10-31** is a proposed planning checkpoint, not a delivery commitment; staffing and review date need sponsor confirmation. David Tufts is the proposed accountable sponsor; the named functional role below is the proposed mitigation owner, not an assertion of assignment.

| ID | Risk | Likelihood | Impact | Priority | Mitigation | Proposed mitigation owner | Target / gate | State |
|---|---|---|---|---|---|---|---|---|
| S04-K1 | Persistent replay leaks removed workspace/member data | M | H | High | Apply current authority and lawful erasure; foreign/unknown response equivalence | Event runtime / storage engineering | 2026-10-31 review; before replay rollout | Open |
| S04-K2 | New wire contract shipped before acceptance | M | H | High | Separate internal repair and opt-in work; RFC gate and claims check | Event runtime / storage engineering | 2026-10-31 review; before strict public advertisement | Open |
