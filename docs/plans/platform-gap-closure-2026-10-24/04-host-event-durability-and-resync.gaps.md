# Section 04 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Host-event durability, fan-out and resynchronization](04-host-event-durability-and-resync.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S04-G1 | Which retention interval and privacy/tenant-delete exceptions are supportable? | Storage + privacy owners | Resolve RFC 0250 G2 and capacity/erasure tests | strict facet advertisement |
| S04-G2 | How are producer ordering and atomic backlog/live handoff implemented? | Event/storage owners | Choose one internal log order and prove multi-producer races (ADR 0973 D2 chose the per-tenant CAS sequence; the remainder is decided in [ADR 0988](../../adr/0988-host-event-internal-repair-remainder.md), Accepted 2026-10-27) | durable guarantee |
| S04-G3 | How does each affected entity view reconcile without an atomic snapshot API? | Frontend + entity owners | Inventory revision semantics and test buffered resync | client gap recovery |
| S04-G4 | RFC 0250 governance, SDK owners and gated test conditions | Protocol maintainers | Review Draft plus registers and complete ordinary acceptance process | new public semantics |

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.
