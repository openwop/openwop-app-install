# ADR 0455 — Sell a paid challenge through the storefront + funnel (surface the price)

| | |
|---|---|
| **Status** | implemented (P1 + P2 + P3) — 2026-07-20 · COMPLETE (Stripe-landing = a deferred polish) |
| **Feature** | EXTENDS `kicktodo-commerce` + the KickTodo Discover/Detail frontend. Reuses the commerce `/public-store` + funnels. No new toggle, no new money path. |
| **Source** | KickTodo leverage map #6 — re-scoped after audit (see correction). |
| **RFC verdict** | Host work, no RFC (rides the existing `/public-store` checkout + Stripe; ADR 0176/0385). |
| **Composes** | ADR 0420 (kicktodo-commerce entitlements on order.paid), ADR 0009 (funnels→CMS page), ADR 0449 (buyer→contact bridge already fires on paid checkout) |

## Boundaries audit (verified file:line) + leverage-map correction

- **A paid challenge is ALREADY a Product with a working charge path.** `kicktodo-commerce/entitlementService.ts:70` `linkChallengeProduct(tenant, productId, challengeId, version, …)` binds one Product to one published challenge version; `getLinkByProduct` (`:85`) grants the `ChallengeEntitlement` on `reprocessOrder` at order.paid (`:111-143`). The money last-mile is the generic commerce `/public-store` checkout.
- **The public storefront exists and is correctly ungated for buyers.** `commerce/routes.ts:411` `GET /public-store/:orgId/products` (filters `p.active`, `:425`), `:433` detail, `:452` `POST /public-store/:orgId/checkout` → pending order + best-effort `ensureContact` + hosted Stripe Checkout. Buyer checkout is deliberately NOT approval-gated (`:450-451` — a customer buying is not an agent committing the merchant's money); the approval gate is agent/UCP-only (`commerceService.ts:700-704`).
- **CORRECTION to the map's "Discover/Detail is free-only… a paid challenge has no storefront":** the *storefront path exists* (the linked Product sells via `/public-store`). What is missing is that **KickTodo Discover/Detail never surfaces the price or a buy CTA** — `kicktodo-core/routes.ts` has zero `price`/`stripe`/`checkout`; `listPublished` returns bare challenge rows with no price (`challengeService.ts:201,220`); the participant only discovers the paywall at *enroll time* via `enrollGuardVerdict` → "This challenge requires a purchase" (`entitlementService.ts:224-232`). So the gap is **surfacing + a post-purchase enroll bridge**, not a new storefront.
- **Funnels sell a Product only via a CMS page.** `funnelsService.ts:31-42` steps bind a `pageId` (not a `productId`); the order carries a `funnelRef{funnelId,stepId}` provenance stamp (`commerce/routes.ts:476-478`). A challenge's Product can already be sold from a funnel's checkout step today — the entitlement grant fires on paid regardless of funnel provenance.

## Decision

Make a paid challenge **visibly purchasable at the point of discovery**, reusing the existing storefront/checkout — no new money code.

1. **Surface the price + buy CTA on the KickTodo Detail page.** Add a read that, for a challenge with a linked active Product (reverse of `getLinkByProduct` — a `productForChallenge(tenant, challengeId, version)` lookup), returns `{ productId, price, currency, active }`. The Detail page shows the price and a **Buy** CTA that deep-links the commerce `/public-store/:orgId/checkout` for that product, with the Stripe success URL routed back to a KickTodo **enroll-and-start** landing.
2. **Post-purchase enroll bridge.** The entitlement is already granted on paid (`reprocessOrder`); the success landing resolves the buyer's fresh `ChallengeEntitlement` and completes `enroll()` (or presents "Start now"), closing the discover→buy→enroll loop that today dead-ends at the enroll wall.
3. **Funnel-sellable (documentation + a template).** A challenge's Product can be sold from a funnel checkout step today; ship a funnel **template** (landing→sales→checkout→thankyou) whose checkout step targets a challenge Product, so operators get a turnkey paid-challenge funnel. No funnel code change.

## PRD-vs-architecture corrections
- **No new "KickTodo storefront."** The map implied building a storefront; the correct move is to *surface the existing Product* on the existing storefront/checkout. Standing up a second storefront would fork the Stripe/approval invariants (ADR 0176/0385) — forbidden.
- **Approval-gating:** the paid-listing approval gate (ADR 0385) applies to *seller onboarding*, not to a buyer purchasing — the buy CTA rides the already-ungated buyer checkout. No new gate.

## Data model
No new store. A read-only reverse lookup `productForChallenge` (may reuse the existing `${tenant}::${productId}`→link collection with a secondary index by challengeId, or a bounded scan — see OQ1). Frontend: price/CTA on Detail + an enroll-and-start landing.

## Phased plan
| Phase | Ships | Gate |
|---|---|---|
| P1 | ✅ **implemented 2026-07-20** — `entitlementService.productForChallenge(tenant, challengeId, version)` → `{ productId, orgId, price, currency, active }` or null (free). Reverse of `getLinkByProduct`; multi-tier ⇒ lowest ACTIVE price (OQ2). Added `commerce.getProductInTenant` (tenant-scoped read — the link carries no org). `test/kicktodo-product-for-challenge.test.ts` green (free→null, linked→price+org, tiers→lowest-active). | /architect: tenant-scoped (no cross-tenant leak); free path returns null; org resolved from the product row |

> **P1 note:** `getProduct` requires an `orgId` but the challenge↔product link is
> tenant-scoped and carries none, so P1 adds a small tenant-scoped `getProductInTenant`
> read helper (the product row carries its own `orgId`, returned so the FE can deep-link
> the org-scoped `/public-store/:orgId/checkout`). OQ1 (secondary index vs scan): P1 reuses
> the `isChallengePaid` tenant-prefix scan (link counts per tenant are small); an index is
> a later perf note.
| P2 | ✅ **implemented 2026-07-20** — backend `GET …/entitlements/challenges/:id/:version/price` (gated, tenant-scoped, `null`=free) + `kicktodoClient.getChallengePrice` (swallows failure → null; additive, never breaks Discover) + `ChallengeDetailPage` renders the price chip + a **Buy CTA → `/store/:orgId`** (the storefront owns checkout) with an "already purchased? start" enroll fallback and an honest "not buyable" notice when inactive. `formatCurrency` (no raw money formatting); 4-locale keys. FE build green; /ux-review clear. **The Stripe-success → enroll-and-start landing is deferred** to a P2-followon (needs the checkout-success URL round-trip). | P1; /ux-review |
| P3 | ✅ **implemented 2026-07-20** — the operator playbook (`docs/kicktodo-marketing-commerce-playbook.md` §1): the funnel recipe (landing→sales→checkout→thankyou with the checkout step selling the challenge's Product; `?ref=` referral attribution rides through). No template-registration code exists (funnels bind a `pageId`, not a `productId`), so the deliverable is the operator recipe + the shipped Detail Buy CTA. |

## Alternatives weighed
- **Add a bespoke Stripe checkout inside KickTodo**: rejected — a second checkout/Stripe client violates the ONE-client invariant (ADR 0176). Reuse `/public-store`.
- **Render the challenge Product only through `commerce.product` public-entities**: deferred — the storefront read intentionally stays the commerce `/public-store` route in v1 (kernel-flag convergence not flipped, `commerceService.ts:281-284`); this ADR rides `/public-store`, not the kernel public read.

## Open questions
- OQ1: reverse lookup productForChallenge — add a secondary index (challengeId→productId) to the link store, or bounded per-tenant scan? Prefer the index (hot on Detail render); confirm the link collection's key/index shape in P1.
- OQ2: multiple Products selling the same challenge version (tiers) — Detail shows the lowest active price / a tier chooser? Start lowest-active; tier chooser is follow-up.
- OQ3: currency/locale formatting of the price on Detail — reuse the FE `format.ts` money helper (no raw formatting); confirm in /ux-review.
