# ADR 0222 — Campaign Journeys: lifecycle automation as chains on the ONE engine

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | NEW `campaign-journeys` feature (enrollment ledger + eligibility composite, surface, routes), `feature.campaign-journeys.nodes` pack, `core.openwop.workflows.campaign-journeys` chain pack; retires `vendor.myndhyve.campaign-sequence{,-integration}` |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C6** — the single highest-leverage item: converts the already-owned runtime into the research doc's "Must Have" journey epic at chain-pack cost |
| **Depends on** | ADR 0208 (host-event → workflow bindings — the trigger), ADR 0217 (suppression), ADR 0020 (consent), ADR 0203 CRM verbs (`create-task` etc.), `core.flow.wait` (durable suspend), `core.openwop.integration.email-send` (idempotent per-recipient send), ADR 0152 (chain loader) |
| **RFC gate** | **None** — rides RFC 0013 chains + implemented host seams. |
| **ADR numbering note** | Renumbered 0221 → 0222 at rebase: the commerce session's governance ADR took 0221 on main first (duplicate-number policy). |

## Context

The gap analysis graded journey orchestration **C**: the platform owns the research doc's hardest substrate (engine, triggers, durable waits, HITL, replay) but no contact-level journey *product* existed — and the lifted MyndHyve sequence packs sat unwired ("pack shells present, engine absent"). The §6 non-goal stands: **no journey engine, no canvas, no second sender.**

## Decision

**Journeys ARE workflow chains.** The only net-new primitives are the two guards chains cannot express:

1. **Enrollment idempotency** (`campaign-journeys:enrollment`, key `${tenant}::${journey}::${contact}` — the gap plan's `journey:<id>:contact:<id>`): the `enroll` node succeeds once per (journey, contact) and fails `already_enrolled` on any re-fire — event redelivery and manual re-runs can never double-send. Enrollment state is the run itself; re-enrollment is an explicit `DELETE /campaign-journeys/enrollments` (operator intent, never implicit).
2. **Eligibility composite** (`eligibility` node): contact-exists + has-email + marketing consent (ADR 0020) + suppression (ADR 0217) in ONE verb, so no chain can forget a gate; outputs the address (`to` rides the edge into the send node's port). Re-checked after every wait — consent revoked mid-journey stops the next send.

Everything else composes shipped pieces: **trigger** = `core.trigger.event` + an ADR 0208 binding (e.g. `host.crm.contact.created` → welcome-series; `host.campaign.*`/email-engagement events equally bindable); **wait** = `core.flow.wait` (durable suspend); **send** = `core.openwop.integration.email-send` (deterministic idempotency key — replay-safe); **approve** = `core.chat.approvalGate`; **log/task** = the ADR 0203 CRM verbs. Runs surface in the existing run feed — that IS the journey monitor.

Shipped chains: `welcome-series` (trigger → enroll → eligibility → **sign-off gate** → email → wait 1d → re-check → email) and `re-engage-contact` (enroll → eligibility → **sign-off gate** → email → CRM task). Both declare `side-effectful` and gate their sends per the repo-wide vendored-chain convention (the `workflow-chain-knowledge-inbox` gate); hands-off operation = an approval policy that auto-clears the gate (ADR 0070 machinery), never an ungated example.

**Retired:** `vendor.myndhyve.campaign-sequence{,-integration}` — the unwired MyndHyve step-executor shells. Their wait/tag/condition semantics are now covered by `core.flow.wait`, CRM verbs, and chain edge conditions (ADR 0207); keeping two homes for sequence steps would be the parallel-path smell.

## Deferred (explicit)

- **Segment-wide sweeps** (winback over a whole segment) need per-member fan-out — expressible with `core.dispatch` once a per-member supervisor shape is designed; the single-contact chains ship the pattern now.
- **Behavioral branching on engagement** (send B only if A clicked) — the C4 engagement rows are queryable, but a read verb + edge-condition recipe is a follow-on.
- **Frequency caps** beyond one-run-per-journey — a per-contact send-count verb over the send ledger, when a real cadence need appears.

## Verification

`campaign-journeys.test.ts`: enrollment idempotency + reset + tenant isolation; eligibility composite (each reason); route reads; node guard behavior (`already_enrolled`, `not_eligible`, trigger-payload contact resolution); chain packs load (the chain suites' zero-errors gate).
