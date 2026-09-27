# ADR 0177 — E-Commerce (product catalog + orders; payment demo-mode)

**Status:** implemented (Phases 1–3 — 2026-07-01). **P2** added: `ctx.features.commerce`
(products/orders reads + create-order) + `feature.commerce.{nodes,agents}` packs (create-order
/ list-products nodes + a Store Assistant agent) + a best-effort **order-confirmation** on
paid (composes the Notification seam — no new sender). **P3** added: **coupons**
(percentage/fixed, applied at order create → discount/total) + a **public storefront**
(`GET /public-store/:orgId/products`, unauthenticated, active-only, tenant-from-resource,
operational fields hidden). Real-Stripe capture (a commerce webhook → `markAsPaid`) is the
operator last-mile — the order already records an external payment intent (demo-mode).
Tests: `commerce-route.test.ts` (+2 — coupons, storefront). Original Phase 1 below.
`features/commerce/` (toggle OFF): Product
(physical/digital/service + variants/SKU; images/downloads = Media tokens) + Order with the
full lifecycle state machine (`pending→paid→fulfilled→refunded→canceled` + a separate
`pending→processing→shipped→delivered` fulfillment axis; `delivered`→`fulfilled`) on real
org-scoped persistence; inventory decrement-on-paid / restore-on-refund; customer = a CRM
`contactId` (validated same tenant); **payment demo-mode** (`markAsPaid(paymentIntentId)`,
external intent, no capture). Routes under `/commerce/orgs/:orgId/*`, `authorizeOrgScope` +
CTI-1. Test: `commerce-route.test.ts` (5 — CRUD, lifecycle guards, inventory math, IDOR,
contactId). **Sequenced follow-ons (P2/P3):** `ctx.features.commerce` + packs, order-
confirmation Email, public storefront/checkout (Sharing/Publishing pattern), real Stripe
capture + webhook (connections-inbound), coupons, affiliate/payout, multi-currency polish.
Pure host-ext — no wire, no RFC.
**Date:** 2026-07-01

> **§Deferred-work follow-on landed (2026-07-01):** server cart (+ checkout→order), multi-currency guard, the commerce Stripe webhook (→ markAsPaid, demo-verify), affiliate/commission/payout (advisory ledger), and the transactional order-confirmation email seam (mock-tested) shipped. Real Stripe capture remains operator last-mile.
**Track:** A (Software & App Architecture). **No OpenWOP wire change → no RFC**
(operator-private product/order data + host-side Stripe credentials).
**Reverses:** the ROADMAP "explicit cut" of E-Commerce ("CRM is decoupled from commerce
on purpose", `ROADMAP.md:605`) — **additively**. The cut's real invariant ("CRM ships
WITHOUT commerce") is preserved: `commerce` depends on CRM/Media/Email; the dependency
points the allowed direction (never the reverse).
**Owner:** a NEW feature-package `features/commerce/`.
**Toggle:** `commerce` (default **OFF**, `bucketUnit: tenant`).
**Composes (does NOT fork):** Media (ADR 0007/RFC 0055 — product images + digital-download
bytes = asset tokens; `/assets/:id/use` usageCount IS the download-limit primitive),
CRM (ADR 0008 — customer = a `contactId` link), BYOK/Connections (ADR 0024 — Stripe keys
+ the inbound-webhook seam), ADR 0015/0006 (tenant + RBAC), Email (ADR 0019 —
order-confirmation), Consent (ADR 0020), Sharing/Publishing (ADR 0013 — public storefront).
**MyndHyve baseline:** `src/features/commerce/` (`OrderService`, Product/Cart/Coupon +
schemas) + `campaign-studio/ecommerce/affiliate/AffiliateService.ts` (1,687 LOC) +
`campaign-studio/payments/PaymentService.ts` (payment **`not_configured`**, no capture).

> **Boundaries-audit headline (2026-07-01):** openwop-app has **zero** existing
> commerce/product/order/cart/coupon code — genuinely net-new. But every supporting
> concern already has an owner, and MyndHyve's own commerce is **client-side in-memory
> singletons** with payment **`not_configured`** (no `PaymentIntent` capture — a Cloud
> Function that was never built). The faithful port supplies **real org-scoped
> persistence** and keeps payment **demo-mode / external-intent** exactly as upstream —
> that is faithful, not a gap. **This is the largest single port on the roadmap; it
> ships phased, Phase 1 only.**

---

## Context — boundaries & composition audit (done first)

| Concern | Single owner (compose) | Note |
|---|---|---|
| Product images **+ digital-product bytes/download** | **Media (RFC 0055)** — `storeMediaAsset`→token, served by `/assets/:token` (public capability token, tenant-isolated); `POST …/assets/:id/use` already tracks `usageCount`/`lastUsedAt` | the **download-limit primitive already exists** — a digital product's download = a Media token with a use cap |
| Customer identity | **CRM Contact (ADR 0008)** — an Order carries a `contactId` (MyndHyve's own `customerId` is unused; it's email-only). May *link* a CRM **Deal** (which already holds `amount`/`currency`) but must **not** become its typeref | **do NOT invent a net-new Customer**; referencing CRM does not violate the "CRM decoupled from commerce" cut (dependency direction is allowed) |
| Coupons / discounts | **NET-NEW** (`commerce` package) | no discount concept exists anywhere (grep empty) |
| Payment secrets (Stripe) | **BYOK / Connections (ADR 0024)** | host-side; never wire/client |
| Stripe inbound webhook | **`connections/inboundWebhooks.ts`** (signature-is-credential, raw-body, RFC 0083 path) | `Stripe-Signature` slots into this seam — additive `InboundProvider`, **not a new endpoint class** |
| Tenant/org + RBAC | ADR 0015 + 0006 | products/orders org-scoped, every route RBAC-gated |
| Order-confirmation email | **Email (ADR 0019)** | compose the existing sender — no new one |
| Public storefront / checkout | **Sharing/Publishing public pattern** | `PUBLIC_PATH_PREFIXES` + `/public/:orgId/...`, org-in-URL, tenant host-resolved, published-only |

## Decision

A `commerce` feature-package (toggle OFF, tenant-bucketed) owning **Product**,
**Order** (+ its lifecycle state machine), and **Coupon** (net-new), composing Media
(images/downloads), CRM (customer), BYOK (Stripe), Email (confirmations). **Payment
ships demo-mode / external-intent** (record an externally-supplied `paymentIntentId`;
`not_configured` until an operator wires Stripe) — faithful to MyndHyve.

- **Order lifecycle** (ported onto real persistence): `pending → paid → fulfilled →
  refunded → canceled`, with a **separate fulfillment axis** (`pending → processing →
  shipped → delivered`; reaching `delivered` flips order `status → fulfilled`).
  **Inventory** decrements on `paid`, restores on `refund`; low-stock threshold alerts
  via Notifications.
- **`markAsPaid(orderId, paymentIntentId)`** records an external intent id (no capture
  fn) — the demo-mode contract; real Stripe capture + the webhook (`PaymentIntent
  succeeded → markAsPaid`) is a deferred phase on the connections-inbound seam.

### Port-not-clone corrections
- **Real persistence** (`DurableCollection`, tenant+org CTI-1) — MyndHyve's are in-memory
  Maps; that's a demo artifact, not a design.
- **Customer = CRM `contactId`**, never a net-new Customer entity.
- **Digital downloads = Media tokens** with a use cap — not a bare URL + counter.
- **Payment stays demo-mode** (external intent id) — do not fabricate a capture path
  MyndHyve never built; wire real Stripe as an explicit later phase.
- **Affiliate/commission/payout is deferred** (the 1,687-LOC subsystem — biggest surface,
  weakest coupling); never inherit it into Phase 1.

## Phased plan
- **Phase 1 — catalog + orders (payment demo-mode).** Product (physical/digital/service +
  variants/SKU, images via Media tokens); Order record + the full lifecycle state machine
  on org-scoped persistence; inventory decrement/restore + low-stock alerts; customer =
  CRM `contactId`; `markAsPaid(externalIntentId)` demo-mode (`not_configured`). Routes
  under `/v1/host/openwop-app/commerce/orgs/:orgId/*`, `authorizeOrgScope`-gated. Route
  tests (RBAC, IDOR, lifecycle guards, inventory math, digital-download token cap).
- **Phase 2 — extension surface.** `ctx.features.commerce` (read: products/orders;
  write: create-order/fulfill via node) + `feature.commerce.{nodes,agents}` (an order-ops
  node; a "storefront assistant" agent only if warranted — else honest "none"); order
  confirmation via Email (ADR 0019).
- **Phase 3 — public storefront + real Stripe.** Public product page + checkout via the
  Sharing/Publishing public pattern; real Stripe `PaymentIntent` capture + the webhook on
  the connections-inbound seam; coupons.
- **Deferred (logged):** affiliate/commission/payout; multi-currency polish; cart
  server-persistence (Phase-1 cart can be client-side → order on checkout).

## /prd five-architect compatibility pass

| Architect | Verdict |
|---|---|
| **Spec** | No new wire vocabulary. Products/orders/checkout are operator-private under `/v1/host/openwop-app/*`; public storefront rides the existing public-surface pattern. **N/A.** |
| **Schema** | No new/changed wire schema. Product/Order/Coupon are host-private stores; images/downloads are Media tokens; the Stripe webhook rides the existing inbound contract. |
| **Security** | Stripe keys host-side (BYOK); webhook = signature-over-raw-body on the connections-inbound seam; digital downloads = capability-token Media assets with a use cap (tenant-isolated, no enumerable URLs); public storefront is published-only + org-from-resource; customer PII gated by Consent (ADR 0020). |
| **Conformance** | Nothing advertised → no scenario; `OPENWOP_REQUIRE_BEHAVIOR` unaffected. Demo-mode `not_configured` is an honest operator state, not a false capability. |
| **Compatibility** | **Additive.** New `commerce` package, toggle OFF ⇒ byte-identical when off; no existing feature imports commerce; the CRM/Media/Email dependency direction preserves the "CRM ships without commerce" invariant. |

**RFC gate: none.** Pure host-extension; the two public surfaces (storefront, Stripe
webhook) compose existing seams (PUBLIC_PATH_PREFIXES / connections-inbound).

## Alternatives considered
1. **Ship the full MyndHyve surface in one ADR.** Rejected — largest port on the roadmap
   (catalog+cart+orders+inventory+coupons+**affiliate/payout**+multi-currency+Stripe);
   Phase 1 = catalog + order record + demo-mode payment, the rest sequenced.
2. **A net-new Customer entity.** Rejected — CRM Contact is the customer; commerce links a
   `contactId` (MyndHyve's own `customerId` is unused).
3. **Fabricate a Stripe capture path.** Rejected — MyndHyve's is `not_configured` with no
   capture; ship demo-mode/external-intent faithfully, real Stripe as a later phase.
4. **A parallel blob store for product images / digital downloads.** Rejected — Media
   owns bytes; the `/assets/:id/use` cap is the download-limit primitive.

## Open questions
- [ ] **Cart persistence** — Phase-1 client-side cart → order on checkout, vs a server
  `commerce:cart` store; start client-side unless a consumer needs saved carts.
- [ ] **Order ↔ CRM Deal** — auto-create/link a Deal on `paid` (pipeline visibility) vs
  keep Orders separate; decide with the CRM owner (link, don't merge typerefs).
- [ ] **Tax/shipping** — Phase 1 = flat/manual; a tax provider is a later Connections
  integration.

## Correction note — payment verification (2026-07-03, LEAK-11 / ADR 0195 Phase 4)

`markAsPaid` previously recorded an EXTERNALLY-supplied `paymentIntentId` with
zero verification. Now: when the operator's Stripe key is configured
(`STRIPE_KEY_REF`, shared with ADR 0176), the intent is verified via
`GET /v1/payment_intents/<id>` — it must be `succeeded`, its **currency must
match the order exactly** (a currency swap is never benign), and its **amount
must equal the order total in Stripe minor units** (zero-decimal-currency
aware). Any mismatch 409s and the order stays `pending`. Keyless mode keeps the
honest demo posture; the pay route's response now carries
`paymentVerification: 'stripe' | 'none'` so the caller knows which happened.
Tests: verified-success / not-succeeded / amount-mismatch / currency-mismatch /
keyless legs in `test/stripe-live-payments.test.ts`.
