# Section 05 — Planning gaps

Status: Open inputs/decisions; these are not extra product defects. Parent: [Data integrity, lease fencing and lifecycle completeness](05-data-integrity-leases-and-lifecycle.prd.md).

| ID | Missing input / decision | Proposed owner | Resolution path | Blocks |
|---|---|---|---|---|
| S05-G1 | Which invariants need serializability versus bounded compensation? | Data + domain owners | Review invariant inventory with precise failure windows | implementation choice |
| S05-G2 | Which delayed writes and effects must honor a fencing token? | CRM/seed/runtime owners | Trace actual call graph, database transaction and provider boundaries | lease repair |
| S05-G3 | Which retention exemptions are legally required and who approves them? | Privacy/security owners | Record scope/owner/duration and test permitted erasure outcome | privacy closure |

An input closes only with linked evidence or a recorded decision. Rejected alternatives and explicit non-goals cannot silently erase an original audit requirement.
