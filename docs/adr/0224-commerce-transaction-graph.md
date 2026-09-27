# ADR 0224 — Commerce transaction graph: price lists, reservations, quotes, storefront checkout

**Status:** implemented (2026-07-03 — ecommerce gap-analysis §5 Phase C, C2–C6)
**Date:** 2026-07-03
**Track:** A (Software & App Architecture) — extends `features/commerce/` (ADR 0177/0221).
**No OpenWOP wire change → no RFC** (all routes host-ext; the public storefront/quote
surfaces ride the established `public-store` prefix + the sharing capability-token
pattern; Stripe stays behind `billing/stripeApi.ts`).
**Composes (does NOT fork):** the C4 resolver is called by every seller path; the ONE
approval loop gates quote SEND (ADR 0221's `commerce-spend` kind + `spendIdemKey`
resume); the ONE sharing feature owns quote links (new `commerce_quote` resource type +
the exported `assertLiveLinkFor` capability proof); CRM `createContact` owns guest
identity (the Forms precedent + an email dedupe); `hostExtPersistence.compareAndSwap`
is the oversell guard; the CMS publishSweep pattern drives reservation expiry (no new
scheduler primitive).

## Decisions

1. **C4 — Price lists + ONE explainable resolver** (`commerce/pricing.ts`).
   `PriceList` = entries (product/variant → price) + explicit assignment
   (`contactIds`/`companyIds` — contacts have no companyId yet, the known CRM gap;
   resolution widens without an API change when linkage lands) + priority + active.
   `resolvePrice()` answers `{price, currency, source, priceListName?, priority?}`
   with precedence **contract entry > variant > list price**, same-currency only
   (no FX — skipped, never converted). Callers: order create (agent/REST/UCP/cart),
   quote pricing, the admin "view as buyer" preview (`GET …/price`), the
   `resolve-price` node. Order items stamp `priceSource` (the research doc's
   winning-rule criterion). Deliberately NOT a rules engine.
2. **C5 — Reserve-on-create + the stock ledger.** A PENDING order IS the
   reservation: lines are CAS-decremented at create (`compareAndSwap` retry loop —
   the #1189 posture; `insufficient` → 409 `out_of_stock` with rollback of
   already-taken lines), consumed at paid (no second decrement), restored on
   cancel/refund/expiry. `Order.reservationExpiresAt`
   (`OPENWOP_COMMERCE_RESERVATION_TTL_MS`, default 24 h) is swept by a
   feature-owned bounded interval (`commerce/reservationSweep.ts`, the cms
   publishSweep clone) that auto-cancels through the normal service path.
   **Back-compat:** a pre-C5 order (no reservation stamp) keeps legacy
   decrement-at-paid. Every inventory change lands an append-only `StockMovement`
   (reason-coded; `GET …/products/:id/movements`). Low-stock events now fire at
   the reserve moment. Multi-location/ATP stay non-goals.
3. **C3 — Quote-to-order** (`commerce/quotes.ts`). Snapshot-priced negotiation
   object: lines carry `listPrice` (the C4 answer) + negotiated `unitPrice`;
   post-`sent` edits pin an immutable `QuoteRevision`, bump `version`, and demote
   to draft (the protected-field re-approval discipline). **SEND is the gated
   moment** (`assertQuoteSendGate` — the ADR 0221 machinery keyed
   `commerce-quote-send:<id>:v<n>`); buyer acceptance converts ungated at the
   NEGOTIATED prices (`unitPriceOverride` → `priceSource:'quote'`), refusing
   loudly on staleness (`quote_stale` 409: product missing/archived) and expiry
   (lazy, the approval-gate pattern). Share links: `commerce_quote` joins the
   sharing resource types (sent quotes only); public accept =
   `POST /public-store/:orgId/quotes/:quoteId/accept {token}` with the LIVE link
   as capability proof (`assertLiveLinkFor` — sharing's gates enforced, no view
   consumed). Agent verbs: create/get/list/send-quote + resolve-price
   (packs v1.2.0; accept stays human/route-side).
4. **C2 — Public storefront + hosted checkout.** `GET /public-store/:orgId/
   products/:productId` (projected, active-only) +
   `POST /public-store/:orgId/checkout {lines, email, name?, couponCode?}`:
   guest → CRM contact (email-deduped, best-effort, never blocks), pending order
   (reserving stock), then — with the operator's Stripe key — a REAL hosted
   Checkout Session (`createStripeOrderCheckoutSession`, ad-hoc `price_data`
   lines; ONE aggregate line when a coupon applies so the charge equals the
   order total; `payment_intent` metadata lets the EXISTING commerce webhook
   flip `paid`). Keyless ⇒ honest `mode:'demo'`. No card datum ever touches the
   app. **No approval gate**: a customer's own purchase is not an agent
   committing merchant money. SPA: `/store/:orgId` renders in the bare
   PublicShell (the `/p/:slug` posture) — client-side cart, guest checkout form,
   paid/canceled return banners.
5. **C6 — Catalog depth (floor).** `Product.categories`/`tags` (bounded,
   lowercase, de-duped) + `q`/`category`/`tag` filters on admin and public
   lists. Product custom fields DEFERRED (generalizing CRM FieldDefs is the CRM
   branch's seam); `host.db.search` indexing deferred until the 5,000/org cap
   makes the in-memory filter dishonest.

## Alternatives considered
- A separate `reserved` counter beside `inventory` — rejected: two numbers drift;
  one CAS-guarded on-hand count with the order as the reservation is smaller and
  auditable via the movement ledger.
- Gating buyer quote-acceptance — rejected: the human commitment moment is SEND;
  gating the buyer's yes would park an approval invisible to them.
- Repricing quotes at conversion — rejected: honoring the negotiated snapshot is
  the point of a quote; staleness fails loudly instead.
- A quote-accept action on the generic sharing routes — rejected: sharing stays
  type-agnostic read-only; commerce owns the action, the token is only the proof.

## Test plan (landed)
`commerce-phase-c.test.ts`: C4 priority/currency/anonymous resolution + order
`priceSource`; C5 oversell 409 + rollback, consume-at-paid, cancel restore,
expiry sweep, movement reasons; C3 negotiated pricing, revision pinning, send
gate + approve resume, public accept via live token, bogus-token 404,
staleness; C2 public detail/facets, guest checkout demo mode + contact dedupe,
coupon totals; C9 summary math (see ADR 0225).
