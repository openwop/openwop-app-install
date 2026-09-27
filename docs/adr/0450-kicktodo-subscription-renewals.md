# ADR 0450 — KickTodo subscription renewals (cohorts/tiers that recur)

| | |
|---|---|
| **Status** | **implemented (OQ1 RESOLVED)** — 2026-07-21 |
| **Feature** | EXTENDS `kicktodo-commerce` + `commerce/subscriptions`. No new package. |
| **Source** | KickTodo leverage map (`docs/kicktodo-leverage-map.md`) #1 — cohorts and KickBot-Plus are one-shot orders; they should renew via the existing subscription engine. |
| **RFC verdict** | Host work, no RFC. |

## Decision (intended)
Point a renewing challenge/cohort at a commerce `Product.subscription = { enabled,
intervals, savePercent }` and sell via `subscribeToProduct`; each `invoice.paid` fires
`runSubscriptionCycle` → a fresh Order that should ride the entitlement/seat observers
KickTodo already registers (`kicktodo-commerce/feature.ts:27-37`). KickBot Plus becomes a
sellable plan tier (a `planLimits` value) or an ADR 0419 bundle.

## OQ1 — BLOCKING (found at the /architect pre-phase gate, 2026-07-20)
`subscribeToProduct` (`commerce/subscriptions.ts:94`) and `runSubscriptionCycle` (`:137`)
create the period Order as **`pending`** and **neither calls `markAsPaid`**. KickTodo's
entitlement/seat observers fire on the `markAsPaid` CAS (`commerceService.ts:1083`) — so on
this evidence a subscription renewal Order **never fulfils** the KickTodo entitlement. Before
this ADR can be scoped, resolve: **how does a subscription Order get marked paid today?**
(Does a separate Stripe charge/payment_intent webhook mark it, is there an unshown demo
auto-pay, or do subscription products simply not fulfil via the paid observer?) This is a
COMMERCE question, not a KickTodo one, and it gates the whole "subscriptions is near-free"
premise. Do not implement until answered.

## OQ1 RESOLUTION (2026-07-21) — the subscription orders simply weren't fulfilling
The investigation confirmed the blocking hypothesis was **real, not an unshown auto-pay**:
subscription period Orders were created `pending` and **nothing ever marked them paid** — so
the `markAsPaid` CAS (`commerceService.ts:1083`) never fired, and neither the KickTodo
entitlement/seat observers nor `accrueCommission` ran. Not a KickTodo bug; a commerce
subscription-fulfilment gap.

**Resolution (the answer to "how does a subscription Order get marked paid"): it now does,
at the confirmed-payment seam.**
- **`runSubscriptionCycle` marks the renewal Order paid** — it is invoked IN RESPONSE to a
  confirmed payment: the LIVE Stripe `invoice.paid` (already webhook-signature-verified before
  the hook fires) or a trusted demo/operator trigger. `markAsPaid(…, {})` runs with **no Stripe
  re-verification** (the invoice is the payment authority; the period Order carries no
  paymentIntent), firing the paid-observers — the **entitlement RE-GRANT on renewal** (the
  whole point). Marked BEFORE advancing `lastInvoiceId`, so a mid-way failure re-runs rather
  than stranding a `pending` Order; `markAsPaid` is idempotent.
- **`subscribeToProduct` marks the first Order paid in DEMO mode** (a demo subscribe has no
  invoice to drive it — the operator subscribe IS the confirmation → initial entitlement grant).

Implemented in `commerce/subscriptions.ts`; `test/subscription-recurrence.test.ts` pins that a
demo subscribe AND a renewal cycle both flip the Order to `paid` and fire the paid-observer.
All commerce/subscription/entitlement tests green (modulo the pre-existing `commerce-ucp`
MCP-sandbox env failure). With this, a renewing KickTodo cohort/tier product now fulfils on
subscribe and re-fulfils on renewal through the existing observers — the "subscriptions is
near-free" premise holds.

## Open questions
- OQ2: `ProductSubscription` has no `paused` state (only active/canceled) — does a KickTodo
  cohort need pause? If so, that is a commerce-subscription extension, sequenced first.
- **OQ3 (follow-on, pre-existing):** in LIVE mode `subscribeToProduct` places a first Order
  AND the Stripe subscription's first `invoice.paid` fires a *second* period Order via
  `runSubscriptionCycle` — a redundant `pending` first Order plus a paid cycle Order. The
  entitlement grant is unaffected (the cycle Order fulfils), but the live-mode first-Order vs
  first-invoice reconciliation (mark it paid, or don't place it in live mode) is a commerce
  cleanup beyond the renewal-fulfilment blocker resolved here.
