# ADR 0431 — Paid coached cohorts: seat products, held reservations, and refund-driven seat release

Status: **implemented** (P1–P5, 2026-07-19; record below)

**Requirements source:** `docs/kicktodo-prd.md` §11 Wave 2 revenue ("Paid coached cohorts with limited capacity"; "One-to-one or small-group coaching offerings, with explicit cancellation/refund terms"), §12 Wave 2 ("Cohort capacity, start/end dates, and scheduled sessions"), §13 Commerce.
**Depends on / extends:** **ADR 0420 `kicktodo-commerce`** (the money adapter — order observers, entitlements, the enroll-guard inversion) + **ADR 0419 `kicktodo-accountability`** (the cohort primitive — capacity CAS, grants, conversation binding). EXTENSION of both; toggle ids unchanged. Preserves ADR 0176/0385 Stripe invariants verbatim.
**Surface:** host-extension. **NO new RFC.**

## Why this exists

Wave 2's revenue line has no implementation path: cohorts exist (`cohortService.ts` — capacity, seats, CAS join) and challenge entitlements exist (`entitlementService.ts` — product links, per-buyer grants), but **nothing connects a cohort to a Commerce product** (verified: `grep -rin "price\|paid\|product" kicktodo-accountability/cohortService.ts` → zero hits). A *cohort seat* cannot be sold today.

This is not a toggle flip. It is the one place in KickTodo where **two scarce resources must agree**: money (an order, already paid) and capacity (a seat, finite). Getting that ordering wrong oversells a coached cohort — which, unlike an oversold digital product, cannot be fixed by shipping another copy.

## Boundaries audit (verified against live code)

- **Money owner is `kicktodo-commerce`, seat owner is `kicktodo-accountability`.** Neither absorbs the other: commerce never learns cohort semantics; accountability never learns Stripe. The join is an **observer**, exactly the ADR 0420 P1 inversion (`registerOrderPaidObserver`/`registerOrderRefundObserver`) — commerce notifies, the seat lane derives.
- **Capacity CAS is already the seat authority** (`joinCohort`, a bounded 4-attempt compare-and-swap on `seatsTaken`). This ADR must *use* it, never a second counter.
- **Consent stays ADR 0419's** — buying a seat grants a seat; it does not grant visibility. The grant/accept flow is unchanged, which is what keeps the PRD §6.6 rule ("membership is the wrong abstraction") intact even when money is involved.
- **No new Stripe surface.** One client, one webhook URL, two signing secrets (ADR 0176/0385) — a seat purchase is an ordinary order whose fulfilment observer happens to be a seat grant. **No second commerce-connect route, ever.**
- **Route namespace:** the reserved-namespace guard forbids `/kicktodo/commerce`; seat routes join `/kicktodo/entitlements/*` (the existing ADR 0420 prefix) — `grep "kicktodo/seats"` → 0 registrants, but a new prefix is unnecessary.

## Decision + data model

```text
CohortSeatProduct            // the link, keyed ${tenant}::${productId} (the linkChallengeProduct precedent)
  tenantId, productId, circleId, createdBy, createdAt

SeatHold                     // the reservation — keyed ${tenant}::${circleId}::${buyerSubject}
  heldAt, expiresAt          // bounded TTL; ONE hold per buyer per cohort
```

### The ordering decision (the hard part)

**Reserve → pay → confirm**, not sell-then-reconcile:

1. **Checkout start** takes a `SeatHold` and increments the CAS'd `seatsTaken` — a held seat is an occupied seat, so two buyers cannot both see the last seat.
2. **Order paid** (the existing observer) converts the hold into a real grant + `joinCohort` acceptance. Idempotent by `(circleId, buyerSubject)` — a replayed webhook converges.
3. **Hold expiry** (no payment inside the TTL) releases the seat via the same CAS. Expiry is evaluated **lazily on read/join** — no new reaper, no new poller.
4. **Paid-but-no-hold** (expired hold, then a late webhook): if capacity is free, grant; if genuinely full, **fail closed and flag for refund** — never silently oversell, never silently swallow money. The order is marked with a terminal operator error (the PRD §14 reconciliation rule: "durable phases, retry counters, terminal operator errors, forward repair").
5. **Refund/dispute** releases the seat (CAS decrement) and revokes the grant, but **does not delete completed history** (PRD §13 Commerce, verbatim).

**Money truth stays toggle-independent** (the ADR 0420 rule): paid/refund observers register unconditionally, so a refund releases a seat even with the feature toggle OFF. Only the *linking/discovery* routes are toggle-gated.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | `CohortSeatProduct` link (org/coach-owner gated) + the seat-aware `enrollGuardVerdict` sibling; link/unlink routes under the existing entitlements prefix. |
| **P2** | `SeatHold` with TTL + lazy expiry, held-seat CAS accounting; concurrency tests (two buyers, one seat — exactly one hold wins). |
| **P3** | Order-paid observer → hold-to-grant conversion (idempotent, replay-safe); the paid-but-full fail-closed path with the terminal operator error; refund observer → seat release + grant revoke with history preserved. |
| **P4** | Frontend: seat availability + "held for you, N minutes" on the cohort surface, refund-terms disclosure at purchase; i18n ×4; manual-test rows. |
| **P5** | `ctx.features.kicktodo-commerce` seat read + node (pack bump + pin lockstep); LLM-EXCHANGE row. |

## Feature matrix

1. Package: EXTENDS `kicktodo-commerce` + `kicktodo-accountability` ✔. 2. Toggle: none new; money effects apply toggle-independently (ADR 0420 rule preserved). 3. `ctx` surface: P5 read-only. 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none — money surfaces are not agent-writable. 7. Public surface: none. 8. RBAC: linking is coach/owner-gated; holds are buyer-subject-scoped; uniform 404. 9. Replay/fork: webhook conversion is idempotent by `(circleId, buyer)`; holds carry explicit timestamps (no clock re-read at replay). 10. Frontend: cohort surface extension, no new nav.

## Implementation record

| Phase | Landed |
|---|---|
| P1 — `CohortSeatProduct` link (`kicktodo-cohort-seat-products`, keyed `${tenant}::${productId}` — the `linkChallengeProduct` precedent) + link/reserve/availability routes under the EXISTING `/kicktodo/entitlements` prefix (the reserved-namespace guard forbids `/kicktodo/commerce`) | kicktodo/0431-seats |
| P2 — `SeatHold` with a 15-minute TTL incrementing the **SAME `seatsTaken` CAS** `joinCohort` uses (a second counter would drift): a held seat is an occupied seat, re-holding EXTENDS rather than double-counting, and expiry is reaped LAZILY on read/hold — no reaper, no new poller. Test-pinned: the last seat cannot be double-held; an expired hold frees it | kicktodo/0431-seats |
| P3 — `confirmSeat` consumes a live hold WITHOUT re-incrementing and is idempotent by `(circleId, buyerSubject)` (a replayed webhook converges); **paid-but-full FAILS CLOSED** with a terminal operator log (`kicktodo_seat_oversold_needs_refund`) — never a silent oversell, never silently-kept money. `releaseSeat` frees the seat on refund BEFORE `startDateLocal` only (no mid-cohort backfill) and never deletes history. Both observers register UNCONDITIONALLY (the ADR 0420 money-truth rule: a refund releases a seat with the toggle OFF) | kicktodo/0431-seats |
| P5 — `ctx.features.kicktodo-commerce.seatAvailability` + the `seat-availability` node; pack **v1.12.0** pin-lockstepped across all six kicktodo features | kicktodo/0431-seats |
| P4 — the seat-purchase page at `/kicktodo/seats/:productId`. **The deferral is withdrawn, but the marketplace is still NOT built**: discovery showed the buyer route already keys off a **productId** (`GET .../cohort-seats/:productId`), so a coach-shared link is sufficient — and a link is how coached cohorts actually sell, which makes inventing a browse surface the wrong move rather than merely a deferred one. Deliberately **no nav entry** (advertising a destination with no catalog behind it would be dishonest chrome). The page states FULL plainly and hides the action, shows a REAL remaining-minutes countdown on a live hold (ticking only while one exists), and discloses refund terms BEFORE the reserve action. `seatAvailability` was extended with the challenge title, start date and `seatsLeft`/`holdExpiresAt` — a purchase surface showing only counts asks someone to pay for an unnamed thing. i18n ×4 | kicktodo/d-seat-purchase |

**Architect finding that shaped it:** do NOT edit `checkoutCart` — commerce is the money owner and a seat hold is a seat-owner concern. The hold is taken by the seat owner's own route BEFORE checkout and the paid-observer converts, which keeps the ADR 0420 inversion intact (commerce notifies, the seat lane derives). A buyer who skips the reserve step lands in the paid-but-no-hold path, which this ADR already specifies.

**Correction note (2026-07-19, architect review of the KTFULL-B12 remediation).**
Two decisions above needed amending, and the reasoning trail matters more than
the original text:

1. **"Capacity CAS is already the seat authority" was true, and the B12
   remediation briefly broke it.** That fix routed `confirmSeat`'s no-hold
   branch through a `seatsTaken` pre-check followed by an unguarded increment —
   reintroducing on the MONEY path the exact check-then-increment race
   KTFULL-B10 had removed from `joinCohort`. Corrected: `confirmSeat` now calls
   the same `claimSeat` CAS. The arithmetic adjuster is **deleted**, so this
   ADR's "never a second counter" rule is now structurally enforced rather than
   observed by convention — there is no longer a function that can increment
   without re-checking capacity.

2. **`seatsTaken` is no longer the sole record of WHO holds a seat.** The B12
   repair needed to recompute occupancy after a partial failure, and its first
   attempt derived that from active grants. That is the wrong set in both
   directions: a coach accepts a grant through the generic accept route without
   ever claiming a seat, and that route also lets an invitee bypass
   `joinCohort`. A grant conveys ACCESS; a seat is a CAPACITY claim. An explicit
   `kicktodo-cohort-seats` ledger now records the claim, and occupancy is the
   INTERSECTION of that ledger with live access — which additionally frees a
   seat whose grant was revoked out-of-band. This does not add a second
   *counter* (the ADR's actual concern); `seatsTaken` remains the one CAS'd
   number, and the ledger is what it is derived FROM during repair.

**Implementation note:** `createCohortDetail` starts `seatsTaken` at **1** — the coach occupies a seat — so a cohort with N buyer seats is created with capacity N+1. Test-pinned; a first draft of the tests assumed otherwise and failed.

## Alternatives weighed

- **Sell first, reconcile later (no holds)** — rejected: oversells a capacity-limited human service. The refund is not a remedy when a coach's cohort is the scarce good; the reputational cost lands on the coach.
- **Capacity check only at the webhook** — rejected: that IS sell-first with extra steps; the race window is the whole checkout duration.
- **A seat as a `ChallengeEntitlement` variant** — rejected: an entitlement is unbounded (any number of buyers unlock the same challenge); a seat is scarce and revocable-on-refund with a capacity side effect. Overloading the type would smuggle scarcity into a type that has no CAS.
- **A new `kicktodo-cohort-commerce` package** — rejected: it would put a third owner between two existing ones and duplicate the observer wiring.

## Open questions

1. Hold TTL: recommend **15 minutes** (long enough for a real Stripe checkout including 3DS, short enough that a browsing abandon doesn't strand a seat). Operator-configurable; not per-cohort (per-cohort TTLs invite misconfiguration).
2. Does a refund after the cohort has *started* release the seat back to the pool? Recommend **no** — release only before `startDateLocal`; a mid-cohort backfill disrupts a coached group. Refund still revokes access; the seat simply isn't resold.
3. Coach payouts for seat revenue ride the existing commerce-connect lane (ADR 0385) — the creator-payout path already exists; this ADR does not add a second payout model.

## RFC verdict

**Host work, no new RFC.** Composes existing commerce, Connect, and cohort owners; nothing on the wire.
