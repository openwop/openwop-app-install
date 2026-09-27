# ADR 0299 — CDP-E: Cross-journey priority arbitration at the enrollment CAS

**Status:** Accepted
**Date:** 2026-07-06
**Depends on:** ADR 0222 (journeys-are-workflow-chains; the enrollment guard + eligibility composite this rides), ADR 0267 (CDP-E journey runtime — the sibling depth work: timers, segment triggers, holdouts), ADR 0262 (CDP program + rulings), `host/hostExtPersistence.ts` (`DurableCollection.compareAndSwap`, the cross-instance CAS primitive)
**Part of:** CDP program (ADR 0262). CDP-E.
**Single owner:** `features/campaign-journeys/journeyService.ts` — the existing enrollment compare-and-swap. **No wire change; no RFC** (host-internal; the enrollment ledger is a host-ext store, never a protocol surface).

## Why this exists

A contact can qualify for several journeys at once — a VIP win-back and a generic
nurture, a churn-save and a cross-sell. Today (ADR 0222) each journey enrolls
independently: the guard is "one enrollment per **(journey, contact)**", so a
contact lands in *all* of them and gets several competing streams of sends. CDP
operators need the opposite for lifecycle-critical flows: **at most one active
journey per contact within an exclusivity group, and the highest-priority one
wins** — a churn-save must pre-empt a promo, deterministically, even when both
qualify in the same instant.

The correctness trap is concurrency. Two triggers can fire for the same contact
in the same millisecond (event redelivery, a segment-diff daemon, a manual
re-fire). A naive "read current enrollments, pick the winner, write it" arbiter
is a read-then-write **race**: both readers see the other absent and both enroll
→ two active journeys in a group that must hold one. ADR 0222 already solved this
exact shape for same-journey redelivery with an atomic `compareAndSwap`; this ADR
extends that guard to span journeys **without adding a second arbiter that could
race the first**.

## Decision

Arbitrate **at the existing enrollment CAS chokepoint** in `journeyService.enroll`.
The CAS stays the sole atomicity guard; the priority comparison happens **inside**
its retry loop.

### 1. Journey config: `priority` + `exclusivityGroup`

Two optional inputs carried alongside the `(journey, contact)` enroll
(`EnrollOptions` on the service, surfaced as node inputs on the enroll node so a
journey chain supplies them from its config):

- **`priority`** — integer, higher wins. Default `0`.
- **`exclusivityGroup`** — a string; a contact holds at most one active journey
  per group. **Absent ⇒ the exact ADR 0222 behavior** (per-(journey, contact)
  guard, no arbitration). This is the backward-compatibility guarantee: the
  "one enrollment per contact per journey" non-goal is preserved verbatim for
  every journey that does not opt in.

### 2. One slot row per (group, contact), guarded by the SAME CAS

An exclusivity group is represented by a **single enrollment row** per
`(tenant, group, contact)`, keyed `${tenantId}::@grp::${group}::${contactId}` — a
distinct 4-segment `@grp` shape that can never collide with the 3-segment
ungrouped `${tenantId}::${journeyId}::${contactId}` key. That row's `journeyId`
field **is** the current group winner; the row is both the ledger and the
arbitration slot ("enrollment state IS the ledger", ADR 0222). Because all
challengers for a group write the **same key**, they serialize through one
`compareAndSwap` — the linearization point that makes cross-journey exclusivity
atomic. (A per-journey key could not: two different keys both succeed, yielding
two winners.)

### 3. Arbitration INSIDE the CAS retry (TOCTOU-safe)

`enrollArbitrated` loops:

1. **Read** the current slot row (or `null`).
2. **Arbitrate** against it:
   - same journey already holds the slot → idempotent re-fire, return
     `enrolled:false, reason:'already_enrolled'` (stop the chain);
   - incumbent out-ranks the challenger → return `enrolled:false,
     reason:'superseded'` (skip, honestly);
   - challenger out-ranks the incumbent (or the slot is empty) → fall through to
     take the slot.
3. **CAS** with `expected = the exact row just read` (or `null`). If a concurrent
   enroll moved the slot between the read and the write, the byte-compare fails,
   `won` is false, and the loop **re-reads and re-arbitrates against the new
   incumbent** — the TOCTOU re-check. Retry budget is bounded (fail-closed `409`
   under pathological contention).

So two challengers racing the same group serialize: exactly one slot row exists,
and its `journeyId` is deterministically the highest-priority challenger,
**regardless of arrival order** — no double-enroll. The write is never a
separate read-then-write; the comparison lives inside the CAS retry.

### 4. Deterministic tie-break (replay/fork stable)

`outranks(aId, aPrio, bId, bPrio)` = `aPrio > bPrio`, tie-broken by **smaller
`journeyId` wins** (`aId < bId`). A total order independent of arrival order, so a
replayed or `:fork`ed journey — and either interleaving of a concurrent race —
picks the SAME winner every time.

### 5. Scoping unchanged

The slot key embeds `tenantId` and `contactId`, so arbitration never crosses a
tenant or a contact. A different contact, or the same group in a different
tenant, is fully independent. Live reads only (no `run.metadata` stamp; ADR 0243
doctrine — a journey re-evaluates against current state).

## Alternatives weighed

- **A separate arbiter service / a second collection with its own CAS.** Rejected:
  it races the ADR 0222 enrollment CAS (two atomicity guards for one invariant) —
  exactly the "separate arbiter" the single-owner ruling forbids. Serializing on
  the existing CAS with a shared slot key is strictly simpler and correct.
- **Per-journey rows + a derived/"status" active flag.** Rejected: the winner
  writes its row and the displacer marks the loser superseded — two writes, not
  one CAS, reopening a leak window (loser's row lands active after the displacer
  already ran). Collapsing the group to one slot row makes "exactly one active"
  a structural invariant, not a reconciliation.
- **A distributed lock around the arbitration.** Rejected: the CAS already gives
  us optimistic serialization for free at the one hot key; a lock adds a failure
  mode (held lock, timeout) the CAS retry doesn't have.

## Trade-offs / risks

- **Displacement is slot-level, not run-level.** When a higher-priority journey
  wins the slot, the displaced journey's already-running workflow **run** is not
  cancelled — only its hold on the group is lost. A well-behaved journey re-checks
  eligibility/enrollment before each send (ADR 0222 nodes already fail-closed on
  `enrolled:false`); cancelling live runs is out of scope here and belongs to the
  ADR 0267 runtime work if wanted.
- **Ledger retains superseded challengers only as the slot's prior state**, not as
  a history log. That matches the "state IS the ledger" model; an audit trail of
  every arbitration decision is a separate (deferred) concern.
- **Retry budget.** Bounded at 8 attempts → `409 conflict` under pathological
  same-(group, contact) contention. Fail-closed and effectively unreachable at
  real fan-out (only distinct journeys for one contact contend).

## Implementation

| Piece | Where |
|---|---|
| `priority` / `exclusivityGroup` config, `EnrollOptions`, `EnrollResult` | `features/campaign-journeys/journeyService.ts` |
| Arbitration inside the CAS retry (`enrollArbitrated`, `outranks`), `activeInGroup` read | same file — the ONE owner |
| Node passthrough (`priority`, `exclusivityGroup`; `superseded` honest stop) | `packs/feature.campaign-journeys.nodes/index.mjs` (enroll node) |
| Surface wiring (`enrollOpts`) | `features/campaign-journeys/surface.ts` |
| Tests | `test/campaign-journeys.test.ts` — higher-priority wins; concurrent → exactly one active (CAS holds); ungrouped unchanged (regression); deterministic tie-break; per-tenant/per-contact scoping; idempotent re-fire |

## Open decisions

- [x] Arbitrate at the existing CAS, not a new arbiter (single-owner ruling).
- [x] One slot row per (group, contact) as the serialization key.
- [x] Deterministic tie-break (priority, then smaller journeyId).
- [x] Backward-compatible: no `exclusivityGroup` ⇒ ADR 0222 verbatim.
- [ ] Cancel a displaced journey's live run (deferred to ADR 0267 runtime).
- [ ] Arbitration-decision audit log (deferred).
