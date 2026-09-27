# ADR 0225 — Commerce surfaces & loops: admin back office, storefront SPA, CMS product blocks, chain packs, revenue floor

**Status:** implemented (2026-07-03 — ecommerce gap-analysis §5 Phase C, C1/C7/C8/C9)
**Date:** 2026-07-03
**Track:** A (Software & App Architecture) — the surface/loop half of Phase C
(ADR 0224 is the transaction-graph half).
**No OpenWOP wire change → no RFC.**

## Decisions

1. **C1 — Commerce admin (`/commerce`, workspace tier).** One feature page
   (`frontend/react/src/features/commerce/`) with per-org tabs — Products,
   Orders, Quotes, Pricing (price lists + "view as buyer" resolver preview +
   coupons), Reports (the ONE C9 read), and Assistant. Every action calls the
   ADR 0177/0221/0224 routes, so audit, host events, and approval thresholds
   are inherited; a 409 `approval_required` surfaces as a
   check-the-reviews-inbox notice. The AI surface is the shared
   `EmbeddedChatPanel` scoped to `feature.commerce.agents.store-assistant`
   (ADR 0073 — static import allowed, no second chat). ui/ cohesion layer
   throughout (surface-card, chip--success/warning status semantics, StateCard
   empty states, canonical confirm). i18n: the auto-registered `commerce`
   namespace ships en/es/fr/pt-BR.
2. **C7 — CMS `productGrid` section.** New section kind (backend
   `buildSectionData` case: bounded `productIds` + `storeOrgId`, structural
   validation — existence is a render-time concern since products churn under
   pages) + SPA rendering (`SectionRenderer`): the public renderer resolves
   LIVE name/price/image through the public-store read and links to the
   storefront; an unresolvable ref renders nothing (the fallback), never stale
   copied data. Editor preview shows the ref count.
3. **C8 — Commerce chain pack** (`core.openwop.workflows.commerce`, RFC 0013
   through the built loader — auto-discovered, zero wiring): Post-Purchase
   Thank-You (bind to `host.commerce.order.paid`; the governed email-send node
   + the ADR 0193 sent-ledger dedup), Low-Stock Reorder Draft (bind to
   `host.commerce.inventory.low-stock`; approval-gated supplier email +
   owner notification), Order Exception Digest (scheduled; read-only
   summary → notification). No wait node exists in the chain vocabulary, so
   time-based behavior rides triggers/schedules — honest, not a new primitive.
   Bindings stay an explicit operator act (no auto-binding).
4. **C9 — Revenue floor.** `markAsPaid` writes an analytics `conversion`
   event (`commerce.order.paid`, order value in props) — FIRST-PARTY merchant
   ledger data, not visitor tracking: the beacon's consent gate governs
   visitor sessions, so the server-side write is deliberate and documented
   here. One projection read (`GET …/reports/summary`: GMV, net-of-refunds,
   AOV, status counts, top products, coupon usage, low stock) feeds the C1
   Reports tab in a single fetch (the rate-limit fan-out gotcha). This gives
   campaign attribution (campaign plan C5) a revenue signal to join against.
5. **Public storefront SPA route.** `/store/:orgId` hand-matched in `App.tsx`
   beside `/p/:slug` and `/shared/:token`, rendered in the bare PublicShell;
   the shared-quote viewer (`SharedQuoteView`) renders `commerce_quote` share
   links as an offer (lines/totals/validity + Accept → the ADR 0224 public
   accept route).

## Alternatives considered
- A bespoke commerce dashboard app / parallel read model — rejected (the
  `/insights-suite` lesson): tabs over report endpoints, the ONE chat.
- Auto-creating host-event bindings at pack install — rejected: enrollment in
  automated behavior is an operator opt-in.
- Copying product data into CMS sections — rejected: validated references
  resolved live, per the research doc's content-reference posture.

## Test plan
Backend behavior is covered in `commerce-phase-c.test.ts` (ADR 0224) — the
summary math leg covers C9. The admin/storefront pages ride the frontend build
gate (tsc + token/CSS/i18n) and the manual-test suites; the chain pack loads
through the existing loader validation at boot.
