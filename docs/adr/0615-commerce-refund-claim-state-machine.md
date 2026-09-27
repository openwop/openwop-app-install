# ADR 0615 — The partial-refund claim is a state machine, not a row that exists

Status: implemented

## Context

`partialRefundOrder` (`features/commerce/commerceService.ts`) claims a ledger row,
calls Stripe, folds the amount into the order, then finalizes the row. The `catch`
deletes the claim so a **thrown** failure re-drives — which is correct, and was the
whole of the design.

A process that dies between the provider call and the fold runs no `catch`:

- the ledger row survives, still `provider:'none'` with no `refundId`;
- `order.refundedAmount` was never updated;
- the same-key retry hits `if (existing) return getOrder(...)` and is **swallowed as
  "idempotent — already applied"**.

Money left the account, the order says it did not, and the retry that should have
repaired it is the thing that hides it.

### The root cause is an overloaded field, not a missing sweep

The row had no state. `provider:'none'` did double duty — *"a manual/demo order, no
money to move"* **and** *"claimed, but we have not finished"* — and those two are
indistinguishable on a stored row. Any detection predicate written against that
field is therefore guessing. That ambiguity, not the crash, is the defect: the crash
is just what makes it observable.

### Bound, stated honestly

For a Stripe order this is not unbounded loss: a later refund under a *different*
key is rejected by Stripe's own over-refund check, which the code already relies on.
The record is still wrong and the second attempt still fails confusingly. For a
manual/demo order no money moved at all, so a stranded claim merely blocks that
`refundKey` forever.

### What was considered and rejected

- **A sweep over `provider:'none' && !refundId && age > timeout`.** Rejected: it is
  a predicate over the very ambiguity described above, so it cannot distinguish a
  crashed claim from a completed manual refund. It also adds a second owner of
  "what happened to this refundKey" beside the ledger row.
- **Reusing the RFC 0151 `manual_intervention_required` seam** (`host/compensation*`).
  Rejected on inspection: `markManual` is module-private, keyed to a
  `CompensationObligation`/`inverseActionId`, and emits a **run** event through
  `UnwindDeps.appendEvent`. An HTTP-driven refund has no run. Routing it there would
  mean minting a fake obligation and a runless run event — abusing the seam, not
  extending it.
- **The obligation ledger** (`host/obligationLedger.ts`, ADR 0447). Rejected: it is a
  payables ledger (accrue / payee / paid, used by `affiliate.ts` for commissions).
  Wrong concept; "an effect committed that we failed to record" is not a payable.
- **Making the fold retryable and rethrowing.** Rejected: the provider call has
  already committed. The one outcome worse than an unrecorded fold is a second
  charge-back while trying to record it.

## Decision

Give the claim an **explicit state**, owned by the row that is already the SSoT for
a `refundKey`. This completes a state machine that was previously implicit; it does
not stand up a second system.

```
state: 'pending' | 'applied' | 'manual_intervention_required'   (+ leaseUntil)
```

- **`pending`** — claimed, effect not folded. Carries `leaseUntil`
  (`REFUND_CLAIM_LEASE_MS`, 120s — comfortably longer than the Stripe call plus the
  8 CAS attempts, so a *slow* owner is never mistaken for a dead one).
- **`applied`** — the fold landed. Terminal, and **the only state that may answer a
  retry idempotently**.
- **`manual_intervention_required`** — the provider took the money and this host
  could not record it. Terminal for the code; a human decides. Named for the
  operational fact, and deliberately a state no projection can quietly map back to
  a cheerful "refunded".

Retry semantics, keyed on state rather than on mere existence:

| existing row | same-key retry does |
|---|---|
| none | claim and proceed |
| `applied` (or legacy, see below) | return idempotently — unchanged behaviour |
| `pending`, lease **live** | return idempotently — that is a concurrent caller, not a corpse |
| `pending`, lease **expired** | **reclaim** — CAS from that exact row and re-drive |
| `manual_intervention_required` | throw `conflict` 409, naming the reason |

Re-driving a reclaimed claim is safe because the provider call carries a
deterministic idempotency key (`commerce-partial-refund:<orderId>:<refundKey>`), so
Stripe returns the *same* refund rather than issuing a second one.

The failure paths are split, because they were never the same failure:

- **No money moved** (provider rejected it, or there was no provider leg) → delete
  the claim, exactly as before. A corrected retry re-drives cleanly.
- **Money moved and the fold failed** → do **not** delete; park the row at
  `manual_intervention_required`, keep the `refundId` so a human can reconcile it,
  and record an `order.refund-stranded` audit action.

### Migration: legacy rows read as `applied`

`state` is optional. Rows written before this ADR carry none and are read as
`applied` (`refundClaimState`). This is the conservative direction: it preserves the
answer those rows already gave and never re-drives a historical refund on the
strength of an ambiguity we cannot resolve. The cost is that a claim stranded
*before* this ADR is not auto-repaired — it stays invisible to the new machinery and
needs the same manual reconciliation it always did. No backfill is possible, because
the information required to classify those rows is precisely what was never recorded.

### The marker has to be visible, or it is not a fix

A durable state no projection surfaces is the same defect one layer up. `OrderDetailPage`
rendered every ledger row as a completed refund, and its `provider === 'none'` chip
reads *"Recorded only — no money returned"* — which on a crashed `pending` row (stored
`provider:'none'`) is an outright lie, since the provider may already have taken the
money. So the state is surfaced:

- `manual_intervention_required` → `chip--danger`, `refundNeedsAttention`
- `pending` → `chip--warning`, `refundUnconfirmed`
- the `refundStateOnly` chip is suppressed for both, and unchanged for `applied`

## Implementation record

| Phase | Change | Test |
|---|---|---|
| P1 | `RefundClaimState`, `leaseUntil`, `refundClaimState`, `refundLeaseExpired` | — |
| P2 | State-keyed retry guard + lease-gated reclaim (CAS from the stale row) | `commerce-refund-crash-window.test.ts` CRW-1/2/3 |
| P3 | Split failure paths; `order.refund-stranded` audit action | CRW-4 |
| P4 | Disclose non-applied rows in `OrderDetailPage` (+ 4 locales) | `refundHonesty.test.tsx` (ADR 0615 block) |

**Each guard was verified able to fail** — a green suite is otherwise
indistinguishable from one whose assertions never run:

| sabotage | tests that went red |
|---|---|
| `refundClaimState` always `'applied'` | CRW-3, CRW-4 |
| drop the `!refundLeaseExpired(...)` gate | CRW-2 only |
| `catch` deletes the claim even after money moved | CRW-4 only |

## Open questions

- **The lease is a timeout, not a fence.** A pathologically slow owner that exceeds
  120s can still be reclaimed while alive. Both then call Stripe, which dedupes on
  the idempotency key, and only one wins the ledger CAS — so the *money* is safe and
  the *fold* is single — but the losing owner sees a claim it no longer holds. A true
  fence needs a token compared at write time, which is RFC 0150 §A's pending-lease
  machinery, still unlanded. When it lands, this window is the first thing to test
  against it.
- **Nothing yet alerts on a `manual_intervention_required` row.** It is durable,
  audited and visible on the order screen; it is not pushed anywhere. An operator
  finds it by looking.
