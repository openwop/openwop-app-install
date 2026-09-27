# ADR 0279 — MERCH-E: Product subscriptions (subscribe-and-save) — commerce + billing extension

**Status:** implemented (status line corrected 2026-07-06 — shipped, route-tested, and packed in PRs #1316–#1331; the line had gone stale)
**Date:** 2026-07-05
**Program:** [ADR 0271](0271-commerce-merchandising-program.md) (Commerce Merchandising) — MERCH-E, Phase 2
**Depends on:** ADR 0177 (commerce `Product`/`Order`/`createOrder`), ADR 0176 (billing — Stripe subscriptions, `stripeApi.ts`, webhook processor), ADR 0224 (`resolvePrice`), ADR 0274 (promotions — subscribe-and-save discount). **RFC verdict: host-extension — no OpenWOP RFC.**

## Why this exists

Recurring billing exists only for **SaaS plans** in the `billing` package (Stripe subscriptions for
plan tiers). The commerce store has **no subscribe-and-save / recurring-order** product model — a
whole revenue category (Recharge/Ordergroove) is absent. This ADR adds product subscriptions by
**composing** the existing Stripe-subscription primitives with the commerce `Order` — no second
recurring engine, no second Stripe client.

## Boundaries audit
- **Ownership (ruling 1 + reuse):** extends **both** `commerce` (the `Order`) and `billing` (Stripe
  subscription primitives + webhook). **No new toggle** — rides `commerce`; billing must be enabled
  for live recurring charges (a `dependsOn`/`recommends` edge, ADR 0194).
- **Stripe (single owner):** `billing/stripeApi.ts` is THE Stripe client (ADR 0176). Product
  subscriptions create a Stripe subscription **through it** — never a second Stripe integration.
- **Recurring cadence:** the Stripe subscription **is** the clock; its `invoice.paid` webhook (already
  processed idempotently in `billing/billingService.ts`) drives each recurring order — **no host
  scheduler tick placing orders** (avoids a parallel recurrence engine).
- **Discount:** subscribe-and-save % is a **promotions reward** (ADR 0274), not a bespoke field.

## Decision & data model
- Additive on the commerce `Product`: `subscription?: { enabled, intervals: ('weekly'|'monthly'|…)[],
  savePercent? }` — a product opts into subscribe-and-save.
- New store `ProductSubscription{subscriptionId, orgId, contactId, productId, variantId?, interval,
  stripeSubscriptionId, status, nextOrderAt}` (buy-side recurring — a distinct *direction* from the
  billing plan subscription; keyed by commerce, not a fork of `billing`'s subscription).
- **Flow:** checkout of a subscribe-and-save line creates a Stripe subscription via `stripeApi`
  (recurring price built from `resolvePrice` × `savePercent`); each `invoice.paid` webhook →
  `createOrder` for that period (snapshot pricing, ruling 7) → fulfillment as normal. Subscriber
  self-service (pause/skip/cancel/change interval) reuses the Stripe **billing portal** already wired
  in `billing`.

## Phased plan
- **Phase 1:** `Product.subscription` opt-in + subscribe-and-save checkout → Stripe subscription +
  `ProductSubscription` store + `invoice.paid` → `createOrder`; storefront "Subscribe & save" toggle on
  the PDP.
- **Phase 2:** subscriber portal (reuse Stripe portal) + skip/pause via the portal; switch-to-subscription
  **upsell at cart** (composes MERCH-A placement + this opt-in — the Rebuy pattern).
- **Phase 3 — extension surface:** commerce node pack gains `subscription.list`/`subscription.cancel`;
  Store Assistant learns subscription vocabulary (no new agent); `ctx.features.commerce` subscription
  reads.

## Alternatives weighed
- **A host scheduler placing recurring orders** — rejected: duplicates recurrence + dunning that Stripe
  already does; the `invoice.paid` webhook is the single clock.
- **A new `product-subscriptions` package** — rejected (ruling 1): it's catalog + billing depth, not a
  new domain; extends commerce in place like bundles.
- **Reuse the billing plan-subscription store** — rejected: buy-side product subs are a distinct
  direction (like the UCP buyer's `UcpPurchase` vs the sell-side `Order`) — a separate store, same
  Stripe client.

## Open questions
- [ ] Demo-mode (no Stripe key) behavior — honest `not_configured` on the recurring charge, like the
  rest of commerce/billing (default: yes; the subscription is recorded but no live charge).
- [ ] Dunning/failed-payment — delegate fully to Stripe (default) vs surface a host notification.
- [ ] Prepaid vs pay-as-you-go intervals (default: Stripe recurring price only, Phase 1).

## Feature Evaluation Matrix
1. **Package:** extends `commerce` + composes `billing` — no new package. 2. **Toggle:** rides `commerce`; `recommends billing` (ADR 0194) for live charges. 3. **Workflow surface:** `ctx.features.commerce` subscription reads. 4. **Node pack:** `feature.commerce.nodes` + subscription verbs. 5. **Envelopes:** rides commerce. 6. **Agent pack:** existing Store Assistant. 7. **Public surface:** subscribe-and-save on the public storefront PDP (tenant-from-resource). 8. **RBAC:** commerce `workspace:write`; subscriber self-service via Stripe portal; IDOR + fail-closed. 9. **Replay:** each recurring order snapshots pricing at `invoice.paid`; idempotent per Stripe `event.id`. 10. **Frontend:** PDP subscribe toggle + subscriber management (Stripe portal link) + `ui/` cohesion.
