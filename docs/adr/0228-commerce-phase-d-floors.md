# ADR 0228 — Commerce Phase D floors: order-status links, UCP buyer, assortments, refunds & shipping

**Status:** implemented (2026-07-03 — ecommerce gap-analysis §5 Phase D, D1–D4)
**Date:** 2026-07-03
**Track:** A (Software & App Architecture) — extends `features/commerce/`
(ADR 0177/0221/0224/0225) and implements **ADR 0188**'s Phases 1–3 floor + packs.
**No OpenWOP wire change → no RFC.**

## Decisions

1. **D1 — Customer-identity FLOOR** (deliberately not accounts): a
   `commerce_order` sharing resource type whose resolver renders a **PII-free
   markdown status view** (status/fulfillment/items/total — no emails, no
   addresses, no payment ids), so the generic `/shared/:token` viewer needs
   zero new frontend. The order-confirmation email mints a 90-day link
   (best-effort — sharing off never blocks the email). Shopper accounts,
   address books, and saved payment methods remain §6 non-goals (Stripe hosts
   payment credentials).
2. **D2 — UCP buyer (ADR 0188 Phases 1–3 floor + Phase 4 packs).**
   `commerce/ucpBuyer/`: typed AP2 mandates (`ap2Mandates.ts` — Intent→Cart→
   Payment with ceiling integrity), a distinct `UcpPurchase` store (buy-side ≠
   sell-side `Order`), discover/search/cart/checkout/track over the
   egress-policy-gated fetch, routes under `…/ucp-buyer/*` behind the new
   `commerce-ucp-buyer` toggle (OFF), and packs
   `feature.commerce.buyer.{nodes,agents}` (6 nodes; the Procurement Concierge
   on the ONE chat, checkout node `mcpApproval:'always'`). **The money gate is
   not a floor**: checkout requires (a) the fail-closed per-org cap
   (`OPENWOP_UCP_BUYER_ORG_CAP_MINOR` — unset ⇒ ZERO ⇒ deny) AND (b) an
   APPROVED `commerce-spend` sign-off (ALWAYS — real money has no free
   threshold), keyed `ucp-buy:<purchaseId>`; placement is idempotent (a placed
   purchase never re-posts). Two floor deviations recorded on ADR 0188:
   merchant identity = an egress-gated base URL (Connections provider
   manifests arrive with the first credentialed merchant); MCP transport + VC
   signing deferred (mandates carry an explicit not-VC-signed warning).
3. **D3 — Account-native assortments.** `PriceList.exclusiveAssortment` +
   ONE `resolveSellable()` beside `resolvePrice()`: a buyer matching any
   active exclusive list may buy/quote ONLY products those lists carry
   (409 `not_sellable`); buyers without one, and anonymous shoppers, see
   everything. Enforced at order create + quote pricing; the admin price
   preview answers `{sellable, sellableReason}` — the "view as account"
   explanation.
4. **D4 — Refund + shipping floor.** `refundOrder` issues a **REAL Stripe
   refund** (through the single Stripe owner; full-amount) when the payment
   was a real intent and the operator's key is configured — a refund failure
   keeps the order `paid` (no silent money loss); demo/manual intents keep
   the state-only posture, and the audit row records `refundProvider` +
   `refundId` honestly. Agent-path refunds stay state-only (the operator
   issues money movement). `Order.shippingAddress` (bounded lines) is captured
   from REST + public checkout; tax stays flat/manual and rate/tax provider
   packs remain the deferred RFC 0095 seam.

## Alternatives considered
- Shopper accounts for D1 — rejected: capability links deliver order-status
  value at a fraction of the auth/PII surface; accounts stay a scope decision.
- Attaching buyer spend to `managedBalanceHook` — rejected (ADR 0188's own
  correction): that is AI-token metering, not money.
- Threshold-gated buyer checkout — rejected: autonomous external spending is
  the app's highest-risk action; ALWAYS-approve + cap, both fail-closed.

## Test plan (landed)
`commerce-phase-d.test.ts`: D1 email link + PII-free shared view; D2 discover/
search via the egress gate, intent-ceiling refusal, cap-unset denial, approval
park → approve → placed, idempotent re-checkout, tracking; D3 in/out-of-
assortment orders + quotes + anonymous pass-through + preview reasons; D4
state-only refund honesty + bounded shipping capture.
