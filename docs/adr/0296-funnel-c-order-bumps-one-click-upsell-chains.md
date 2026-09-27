# ADR 0296 — Funnel C: order bumps at checkout + one-click post-purchase upsell chains

**Status:** implemented (2026-07-06, Phases 1–4) — bumps priced into the single charge with route-derived `origin:'bump'` provenance (client-marked origins ignored; cap 5; promotions evaluate over the whole order); explicit-consent saved payment method (`savePaymentMethod:true` + CRM contact + the env gate) via Stripe Customer + `setup_future_usage`, captured by the webhook (idempotent, request-marker-gated), stored as references only (`commerce:saved-pm`), pruned on contact deletion via the crmRecordLifecycle seam; one-click chains: server-priced child orders (`parentOrderId`, `origin:'upsell'`, funnelRef inherited), off_session+confirm intents with deterministic `oneclick:<parent>:<product>` idempotency keys, SCA challenge → 202 + clientSecret on-session fallback, decline → child canceled (stock restored) + 402, chain depth ≤ 3, duplicate accepts return the existing child; analytics stamps ride P1/P3 wiring into the 0294 rollups. **Money movement stays operator opt-in: `OPENWOP_COMMERCE_OFFSESSION_ENABLED` defaults OFF and the §Compliance SCA/PSD2 review is the operator's gate before enabling it anywhere** — verified against a mock Stripe server (the LEAK-11 harness precedent), not live rails.
**Date:** 2026-07-06 · **Program:** [ADR 0293](0293-funnel-program.md) · **Closes:** FM-3
**Toggle:** extends `commerce` (bumps) + the `funnels` toggle (chains); one-click
charging additionally env-gated (`OPENWOP_COMMERCE_OFFSESSION_ENABLED`, default off) —
money movement stays operator-opt-in.
**Wire impact:** none — host-extension + public storefront routes.

## Context

MyndHyve's checkout monetization: **order bumps** (checkbox add-ons on the payment
step) and **one-click post-purchase upsell/downsell chains** (charge a saved payment
method off-session on the thank-you path, no re-entry of card details), modeled on
GoHighLevel. openwop-app has the *merchandising* halves shipped — order-bump-type
promotions (ADR 0274), post-purchase recommendation placements (0273), bundles (0276),
real hosted Stripe capture + refunds on the public storefront (0224/0225/0228) — but
**no saved-payment-method flow exists at all** (verified: zero
`off_session`/`setup_future_usage` hits in `src/features`).

## Decision

Extend `commerce` in place (the ADR 0276 precedent — no new package):

1. **Order bumps (Phase 1 — no new payment mechanics).** A checkout session gains
   `bumps: [{ productId, promotionId? }]` resolved through the EXISTING promotions
   engine (0274 order-bump type) and priced into the single PaymentIntent before
   capture. The public storefront checkout and the (0294) funnel checkout step render
   bump offers from recommendations placements (0273 `checkout` placement) or explicit
   funnel-step config. One charge, one order, line-items marked `origin: bump` —
   refund semantics unchanged (0228 refunds line-items as today).
2. **Saved payment method (Phase 2 — the consent gate).** During capture, an explicit,
   unticked consent checkbox ("save my payment method for one-click offers") sets
   `setup_future_usage: 'off_session'` on the PaymentIntent. The app stores ONLY
   `{ stripeCustomerId, paymentMethodId, consentAt, funnelId }` — no PAN data ever
   (Stripe holds the instrument; consistent with the no-avoidable-secrets doctrine).
   The stored consent is a `DurableCollection` row with a PII eraser registered
   (ADR 0077/0283 lane) and revocation on the storefront account surface.
3. **One-click upsell chains (Phase 3).** A funnel's post-checkout steps
   (`upsell`/`downsell` kinds, 0294) render an offer whose accept action calls
   `POST .../checkout/:orderId/one-click` → server creates a NEW PaymentIntent
   (`off_session: true, confirm: true`) against the saved PM, `amount` resolved
   server-side from the offer (never client-supplied — the LEAK-11 rule), creating a
   **child order** linked `parentOrderId` (the 0224 transaction graph). SCA challenge
   responses (`authentication_required`) fall back to an on-session confirm on the
   same page — the chain never silently drops revenue. Decline → the funnel routes to
   the downsell step (0294 routing).
4. **Chain integrity rules:** max chain depth (default 3) and a per-order idempotency
   key per step (`orderId:stepId`) so refresh/double-click cannot double-charge —
   rides the EXISTING idempotency table semantics (key-only, L1 response cache).
   Webhook parity: `payment_intent.succeeded` for chain intents flips the child order
   `paid` through the same 0177 webhook path (idempotent, HMAC).
5. **Analytics contract (with 0294):** every bump/upsell charge stamps
   `{ funnelId, stepId, origin }` into order metadata — the revenue join FM-2's
   rollups read. Recommendations holdouts (0273) apply to offer selection so lift is
   measurable.

## Alternatives considered

- **Stripe Checkout Sessions in redirect mode for upsells:** rejected — a redirect
  per chain step defeats "one-click" and loses the funnel context; PaymentElement +
  off-session intents is the pattern MyndHyve validated.
- **New `offers` package:** rejected — offer selection is recommendations (0273),
  offer pricing is promotions (0274), charging is commerce; a fourth owner would be a
  parallel system.
- **Auto-save the payment method (opt-out):** rejected outright — consent must be
  explicit and unticked; several markets treat silent PM storage as a violation.

## Compliance gates (blocking, Phase 2+)

- SCA/PSD2 posture review per market (off-session exemption handling, challenge
  fallback) — external review before the env gate ships enabled anywhere.
- Refund semantics across a chain (child orders refund independently; a parent
  refund does NOT cascade — documented on the storefront).
- Dispute/chargeback surface: one-click charges carry the funnel/step descriptor in
  the statement metadata for evidence packets.

## Phases

| Phase | Ships | Gate |
|---|---|---|
| 1 | Bumps in checkout composition + storefront/funnel UI + tests | route tests incl. price-tamper attempts |
| 2 | Consent + `setup_future_usage` + PM row + eraser + revocation UI | privacy review; DATA-ASSESSMENT row |
| 3 | One-click chain route + child orders + SCA fallback + webhook parity | Stripe test-clock e2e; idempotency tests |
| 4 | Analytics stamps + holdout wiring (with 0294 P3) | rollup join verified |

## Open questions

- Whether bumps apply to the UCP agentic checkout (0178) in v1 (leaning no —
  human-consent surface first; agents negotiate via mandates, not impulse offers).
- Downsell after SCA-challenge abandonment: route as decline or as its own outcome
  (leaning own outcome — the data will say which converts).
