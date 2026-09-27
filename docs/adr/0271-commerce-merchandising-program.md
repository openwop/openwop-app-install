# ADR 0271 — Commerce Merchandising & Conversion Layer — composition program, not a monolith

**Status:** implemented — decomposed into ADRs 0273–0279 (MERCH-A…E), **all implemented** (`recommendations`/`discovery`/`promotions` packages + commerce bundles/subscriptions). *(Status-corrected 2026-07-21 — this umbrella header lagged its sub-ADRs.)*
**Date:** 2026-07-05
**Depends on:** ADR 0001 (feature-first packages), ADR 0177 (commerce package — catalog/order/cart/inventory), ADR 0224 (commerce transaction graph — price lists + `resolvePrice`), ADR 0225 (commerce surfaces & loops — storefront + `productGrid` + `commerceSummary`), ADR 0238/0250 (money completeness — tax/carrier rates), ADR 0257 (typed product FieldDefs), ADR 0058 (chat-drivability = agent + node pack), ADR 0073 (EmbeddedChatPanel), ADR 0211 (CRM segments live-resolution doctrine), ADR 0236 (page experiments — `host/variantAssignment.ts` extraction), ADR 0059/0060 (priority-matrix weighted scoring), ADR 0178 (UCP server projection). No OpenWOP RFC (host-extension).
**Companion analysis:** [`docs/research/commerce-merchandising-gap-analysis.md`](../research/commerce-merchandising-gap-analysis.md) (9-domain capability audit + best-in-class market deep-dive).

> **Numbering note (parallel-session race):** authored concurrently with the CDP program
> (ADR 0262–0270) and a `0272-sales-territory-management` ADR, both from other sessions.
> This program is the umbrella **0271** + sub-ADRs **0273–0279** — the gap at **0272** is the
> concurrent sales-territory ADR (left untouched: another session's unpushed work). Sub-ADRs
> are contiguous 0273–0279 (MERCH-A…E). If a later session collides again before this merges,
> renumber the affected block — cheap, all Proposed/uncommitted.

## Why this exists

A merchandising/conversion capability was requested against the seed list *product catalogs,
product listings, product feature options, upsells, cross-selling, loss-leaders*. A
code-grounded audit ([`commerce-merchandising-gap-analysis.md`](../research/commerce-merchandising-gap-analysis.md))
established the load-bearing fact: **openwop-app already has a mature transactional commerce
engine, and it is strong exactly where commerce is hard** — a real `Product` catalog with
variants/SKU + typed fields (`commerce/commerceService.ts`, `commerce/productFields.ts`), price
lists with ONE explainable resolver (`commerce/pricing.ts:166` `resolvePrice`), coupons, carts,
orders with a CAS lifecycle state machine + append-only stock ledger, quotes/CPQ, multi-provider
tax + carrier rates, real Stripe hosted checkout + refunds, a public storefront
(`features/commerce/StorefrontPage.tsx`), a CMS `productGrid`, and agentic UCP buy/sell.

**The thin part is the merchandising *product surface* — and it is exactly the seed list.** A
grep for `upsell|cross-sell|recommend|bundle|loss-leader` across `features/commerce/` returns
nothing (the one `BundleScope` hit is unrelated DI). There is no recommendation engine, no
upsell/cross-sell placements, no bundles/kits, no promotions engine, and no loss-leader tooling.
Categorization is a flat `categories[] + tags[]` bag; search is bare relevance ranking with no
facets/synonyms/merch-rules.

The wrong build is a monolithic "merchandising feature" that stands up parallel copies of the
catalog, the price resolver, the bucketing engine, or the scoring engine. That violates the repo's
"no parallel architecture" law and the "one AI chat, reuse never recreate" rule. **This ADR
records the decision that the merchandising layer is a composition *program* — a sequence of
feature-package ADRs (MERCH-A…E) extending existing owners — and fixes the boundary rulings that
keep it from drifting into a second stack.** It carries no code itself; each sub-ADR does.

## Decision

Deliver merchandising as **five sequenced sub-ADRs**, each a normal feature-package (or an
extension of the `commerce`/`billing` package) per the ADR 0001 lifecycle, riding the commerce
catalog + price resolver + bucketing + scoring + CRM-segment + chat seams **verbatim**. New
packages (`recommendations`, `promotions`, `discovery`) own only their decision/config surface;
catalog depth (bundles, subscriptions) extends the `commerce` package in place with **no new
product store and no new toggle**.

### Boundary rulings (binding on all sub-ADRs)

1. **Commerce owns the catalog, order, cart, and inventory.** The product record is the commerce
   `Product` (`commerce/commerceService.ts`); the order is the commerce `Order`. No sub-ADR forks
   a second product/order/cart store. Recs/promotions/discovery **read** commerce's model;
   bundles/subscriptions **extend the commerce package** (the ADR 0224/0238 in-place-depth
   precedent), never a parallel package.

2. **One price resolver.** `resolvePrice` / `resolveSellable` (`commerce/pricing.ts:166`/`:196`)
   stays the single price authority, always returning the winning `source`. The promotions engine
   (MERCH-B) is a discount **layer that composes** the resolved price — a promotion computes a
   delta against `resolvePrice`'s output, never a second pricing path. The existing internal
   `createOrder({lines:[{unitPriceOverride}]})` seam (`commerceService.ts:507`, used today for
   quote conversion) is the precedent for injecting a computed line price; promotions extend that
   seam rather than bypass the resolver.

3. **One bucketing / experiment primitive.** `host/variantAssignment.ts` (`bucketOf`,
   `assignWeightedVariant`) + the two-proportion z-test (`cms/pageExperimentsService.ts`) are the
   single A/B / holdout engine (extracted to shared for exactly this reuse, ADR 0236). Merch-rule
   holdouts, promotion experiments, and recommendation A/B all reuse it — **no second bucketer**.
   This makes "holdout-test the merch rule/offer" (a top-tier differentiator) nearly free.

4. **One ranking / scoring engine.** `priority-matrix/scoring.ts` (`computePriority` at `:39`,
   `rankByPriority` at `:84`) is the explainable weighted-scoring math. Recommendation ranking and
   merch pin/boost/bury reuse it **retargeted at products** (weighted criteria = co-purchase
   affinity, category match, margin, recency), yielding **margin-aware, explainable** ranking — a
   top-tier differentiator — with no new ML engine. Statistical/embedding ML (propensity) is a
   later, honestly-separate track, shared with CDP-C (ADR 0265) — do not duplicate it.

5. **CRM owns segments.** Segment-targeted recs/promotions reuse `crm/segmentsService` **live
   resolution** (the ADR 0211 "never materialize membership" doctrine). No second audience store;
   a merchandising rule references a segment id and resolves at read.

6. **Chat-drivability = agent pack + node pack, not a new chat.** Each authoring surface ships an
   agent pack + node pack driven through `EmbeddedChatPanel` scoped by agent id (ADR 0058),
   grounded closed-world against the real vocabulary (the `workflow-author` pattern): a
   **Merchandiser** agent (recs / collections / merch rules) and a **Promotions Manager** agent
   (offers / loss-leaders). No second chat.

7. **Order-affecting decisions are snapshot + replay-honest.** A promotion or rec that influences
   an `Order` records which rule/variant fired **onto the order** (like snapshot pricing already
   is), so basket-margin attribution and refunds are deterministic. A rule that influences a
   workflow run stamps `run.metadata` (read verbatim on `:fork`, ADR 0099 seam).

### Sub-ADR index

| ADR | Sub-program | Owner extended / created | Wire |
|---|---|---|---|
| **0273** (MERCH-A) | Recommendations + upsell/cross-sell + FBT — full-funnel placements (PDP/cart/checkout/post-purchase), margin-aware ranking, segment targeting, holdout | new `recommendations` package; reuses `priority-matrix/scoring` + `variantAssignment` + CRM segments; reads commerce catalog/orders | host-ext |
| **0274** (MERCH-B) | Promotions engine + loss-leader tooling — rules layer over `resolvePrice` (threshold/BOGO/tiered/scheduled/stackability) + budget/quantity caps + attach-rate/basket-margin analytics | new `promotions` package; composes `pricing.ts` resolver + `createOrder` seam + `commerceSummary` | host-ext |
| **0275** (MERCH-C) | Discovery — faceted + semantic product search + collections (manual + rule-based/dynamic) + taxonomy + pin/boost/bury merch rules with preview + holdout | new `discovery` package; extends `listProducts`; reuses `db.vector` + `scoring` + `variantAssignment` | host-ext |
| **0276** (MERCH-D) | Bundles / configurable composite products — component-weighted pricing + component inventory decrement | **extends `commerce`** (no new toggle); composes stock ledger + `resolvePrice` | host-ext (UCP-projection check) |
| **0279** (MERCH-E) | Product subscriptions — subscribe-and-save recurring orders | **extends `commerce` + `billing`** (no new toggle); composes Stripe subscription primitives + `Order` | host-ext |

### RFC gate

All five are non-normative host-extension under `/v1/host/openwop-app/*` — **no OpenWOP RFC.**
The only wire-adjacent risk is **projecting a new concept through the UCP surface** (ADR 0178): if
bundles (MERCH-D) or recommendations (MERCH-A) are exposed in the UCP catalog/cart projection so
external AI shoppers see them, that follows UCP's own conformance/`.well-known` path (a third-party
protocol the host speaks, like inbound MCP/A2A — the ADR 0178 precedent), **not** an OpenWOP wire
RFC. Kept host-internal to the storefront + admin, they need nothing. Each sub-ADR states its UCP
verdict; the default is "not projected to UCP in Phase 1."

## Phased delivery (phase boundaries at real gates only)

- **Phase 0 — The seed-list core (host-ext, no RFC, highest leverage), sequenced A → B:** first
  MERCH-A recommendations (FBT mined from order lines + upsell/cross-sell across PDP/cart/post-purchase
  — post-purchase settles via a **fresh Stripe checkout** in Phase 0, true 1-click no-reauth a logged
  fast-follow gated on saved-payment-method), then MERCH-B promotions engine + loss-leader budget caps
  + attach/basket-margin analytics. They are independent packages (B has no dependency on A), so A
  ships as a standalone win before B. These two *are* "upsells, cross-selling, loss-leaders."
  *(Sequence + upsell-settlement defaults confirmed with the requester 2026-07-05.)*
- **Phase 1 — Discovery & merchandising control:** MERCH-C faceted + semantic search + collections
  + pin/boost/bury merch rules with preview and holdout.
- **Phase 2 — Catalog depth:** MERCH-D bundles/composite products · MERCH-E product subscriptions.

## Open questions / decisions checklist

- [ ] **MERCH-A:** FBT co-occurrence — compute on the schedule daemon into a derived cache
  (recommended; the ADR 0211 "derived cache, never authoritative" label) vs live per-request join
  over orders. Default: nightly derived cache keyed by product pair, rebuilt incrementally.
- [ ] **MERCH-A:** post-purchase upsell settlement — a fresh Stripe checkout for the add-on
  (simple, works today) vs true 1-click no-reauth (requires saved-payment-method; deferred, logged).
  Default: fresh checkout in Phase 0; 1-click is a fast-follow gated on saved-PM support.
- [ ] **MERCH-B:** promotion↔price-resolver composition point — a post-`resolvePrice` discount
  delta at cart/order assembly (recommended, keeps ONE resolver) vs teaching `resolvePrice` about
  promotions (rejected — overloads the contract-pricing resolver). Default: post-resolver delta.
- [ ] **MERCH-B:** loss-leader budget-cap enforcement point — the CAS inventory/order choke point
  (recommended, race-safe like reservations) vs an advisory counter. Default: CAS choke point.
- [ ] **MERCH-C:** semantic recall — reuse the host `db.vector` + deterministic embedder (KB
  precedent) vs a dedicated product-embedding store. Default: reuse `db.vector`, product-scoped
  collection.
- [ ] **MERCH-D:** bundle as a new `Product.kind:'bundle'` with a `components[]` field (recommended,
  in-place on the commerce Product) vs a separate Bundle entity. Default: additive on `Product`.
- [ ] **MERCH-E:** recurring-order engine — Stripe subscription drives cadence (recommended, reuse
  billing) vs a host scheduler tick placing orders. Default: Stripe subscription + webhook →
  `createOrder`.
- [ ] Toggle strategy: `recommendations` / `promotions` / `discovery` ship OFF, `tenant` bucket;
  bundles + subscriptions ride the existing `commerce` toggle (catalog depth). No always-on
  graduation until proven.

## Consequences

The merchandising layer makes commerce *convert*, not just *transact* — recommendations grow
basket, promotions + loss-leaders drive traffic and attach, discovery makes the catalog findable,
bundles raise AOV, subscriptions add recurring revenue — each in its existing owner, replay-safe
and tenant-isolated. The cost is program coordination (five ADRs) and one reused ML track shared
with CDP-C. The benefit is four best-in-class differentiators landed cheaply: **margin-aware
ranking** (via the scoring engine), **full-funnel placement**, **segment targeting** (via CRM
segments), and **A/B/holdout of the merch rules themselves** (via the existing bucketing + z-test).
No parallel orchestration, pricing, catalog, or chat stack is created.
