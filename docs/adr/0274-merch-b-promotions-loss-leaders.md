# ADR 0274 — MERCH-B: Promotions engine & loss-leader tooling

**Status:** implemented (status line corrected 2026-07-06 — shipped, route-tested, and packed in PRs #1316–#1331; the line had gone stale)
**Date:** 2026-07-05
**Program:** [ADR 0271](0271-commerce-merchandising-program.md) (Commerce Merchandising) — MERCH-B, Phase 0
**Depends on:** ADR 0177 (commerce — coupons, `createOrder`, inventory), ADR 0224 (`commerce/pricing.ts` `resolvePrice` + price lists), ADR 0225 (`commerceSummary`), ADR 0221 (commerce governance — approvals + `host.commerce.*` events + `policy.commerce.*`), ADR 0211 (CRM segments), ADR 0236 (`variantAssignment` — offer holdout), ADR 0058/0073 (chat). **RFC verdict: host-extension — no OpenWOP RFC** (promotions never projected to UCP in Phase 1; a promoted price is just the UCP catalog price).

## Why this exists

Today commerce has only **flat coupons** (%/fixed/free-ship) and per-account price lists;
`pricing.ts` states outright it is "NOT a rules engine … no stackable promos." The seed list wants
**loss-leaders** — which no platform supports as a single toggle but as three cooperating mechanisms
(anchor pricing + promote-the-SKU + attach-margin analytics). This ADR adds a `promotions` package:
a rules layer over the ONE price resolver, with **budget/quantity caps** (so a below-cost SKU can't
bleed unbounded) and **attach-rate / basket-margin analytics** (so a loss-leader is judged
net-positive) — the actual operational definition of a loss-leader.

## Boundaries audit (Step 3)

- **Route namespace:** `grep -rn "promotions" backend/typescript/src` → no owner. `/v1/host/openwop-app/promotions/*` is free. Coupons stay in `commerce` (ruling 1); promotions **compose** them, not replace them — a coupon is one promotion type.
- **Price resolver (ruling 2) — /architect correction:** `commerce/pricing.ts:166` `resolvePrice`
  returns the winning price + `source`; `createOrder` calls it at `commerceService.ts:538–541` and
  applies a single order-level `discount` scalar for a coupon at `:552–560`. A promotion computes a
  **discount delta *after* `resolvePrice`**, but it must **NOT** ride `unitPriceOverride` (`:507`,`:537`):
  that field is an *absolute* per-line price that stamps `source:'quote'` and **bypasses** the resolver
  (destroying explainability) and it is INTERNAL to quote conversion ("route callers never populate
  this") — reusing it would *create* the second pricing path ruling #2 forbids. The correct seam is an
  **additive discount representation**: a per-line `OrderItem.discountMinor` + `discountSource` and an
  **`Order.appliedPromotions[]` snapshot** (see the composition section). `resolvePrice` is never touched.
- **Coupon single-owner (ruling 1) — /architect correction:** `createOrder` **already** applies
  `couponCode → discount` at `commerceService.ts:552–560`. Since a coupon becomes `type:'code'`, the
  new engine and the legacy path would **double-apply the same coupon**. The coupon path is therefore
  **migrated into `applyPromotions`** as the single application point (the legacy scalar becomes the
  engine's `code`-type output); there is exactly ONE discount computation.
- **Inventory + budget choke point (ruling — loss-leader caps):** `casAdjustProductInventory` + the
  reservation/stock ledger are CAS/race-safe. A promotion budget/quantity cap is a **parallel CAS
  counter reserved-on-create in the SAME `try`/`rollback` block as stock** (`commerceService.ts:585–600`,
  mirroring `taken[]`) and **released by the reservation-expiry sweep** (`commerce/reservationSweep.ts`)
  when an unpaid order expires — so an abandoned cart never leaks loss-leader budget and equal-priority
  races never oversell the discount (never an advisory count).
- **Analytics owner:** `commerceSummary` (`commerceService.ts:1129`) already computes GMV/AOV/top-products per currency — attach-rate + basket-margin are **additive read-time projections** over the same orders, not a new store.
- **Governance (ruling 5 — /architect correction):** `host/approvalService.ts` `createCommerceSpendApproval` + `policy.commerce.*` (ADR 0221) already gate spend; a promotion over a discount-budget threshold parks in the **same** approvals inbox. The `commerce-order` approval **content-key** (`commerceService.ts:565`) currently hashes items+coupon+contact — it MUST be extended to include the **fired-promotion ids + the promoted total**, else a changed promotion resumes a stale approval at a different real total.
- **Experiment engine (ruling 3):** offer A/B reuses `variantAssignment` + the z-test — no second bucketer.

## Decision & data model

A `promotions` feature-package (`src/features/promotions/`), toggle `promotions` (OFF, `tenant`).

### Promotion model
`Promotion{promotionId, orgId, name, type, rule, reward, scope, schedule?, segmentId?, budget?, priority, stackable, active}`:
- **`type`** — `cart_threshold` (spend ≥ X ⇒ reward), `bogo` (buy N of A ⇒ M of B free/discounted),
  `tiered` / `volume` (buy-more-save-more bands), `product_discount` (catalog price change, no code),
  `code` (the existing coupon, subsumed), `loss_leader` (a `product_discount` with a mandatory
  `budget` + prominence flag).
- **`scope`** — products / categories / collections (MERCH-C) / all.
- **`schedule`** — `{startAt, endAt}` campaign window (scheduled sales).
- **`segmentId`** — live CRM-segment target (member-only offers).
- **`budget`** — `{maxDiscountMinor?, maxQuantity?}` — the **loss-leader guard**; enforced at the
  CAS choke point; when exhausted the promotion deactivates (evented).

  > **Correction (2026-07-18, PROMO-MAXQTY):** `maxQuantity` was persisted but
  > **not actually enforced** at apply-time (only `maxDiscount` was) — a
  > money-safety gap. Now enforced the SAME derived, leak-free way: the cap
  > bounds the cumulative **discounted-unit count**, summed from a new optional
  > `appliedPromotions.quantity` snapshot across non-canceled orders (no
  > counter). Applies to the **per-unit** reward types (bogo / product_discount /
  > loss_leader); N/A to the cart-level types (cart_threshold / tiered). See
  > `promotionsService.ts` `quantityUsed` / `capUnitsToQuantityBudget` +
  > `promotion-max-quantity.test.ts`.
- **`priority` / `stackable`** — deterministic resolution across concurrent promotions (highest
  priority wins; `stackable:false` is exclusive) — the "stackability/exclusivity" a naive coupon
  system lacks.

### The composition point (one resolver preserved) — /architect-hardened
At cart/order assembly, **after** every line is priced by `resolvePrice`, a **pure**
`applyPromotions(resolvedLines, context)` evaluates active promotions and returns:
- per-line **`discountMinor` + `discountSource`** deltas (additive on `OrderItem` — NOT a rewrite of
  `unitPrice`, so `priceSource` from the resolver survives), and
- an **`Order.appliedPromotions[]`** snapshot `{promotionId, type, amountMinor, lineIndex?}`.

`createOrder` folds the deltas into the existing `discount`/`total` computation (`commerceService.ts:552–560`)
— coupons flow through the SAME engine (no double-apply) — and persists `appliedPromotions[]` **onto the
Order** (snapshot, ruling 7). This makes three things correct that a scalar discount cannot:
**replay/`:fork`** (the promoted total is frozen, never re-resolved against a mutated promotion),
**partial refunds** (`partialRefundOrder` refunds the *discounted* line price via `discountMinor`), and
**basket-margin attribution**. **Determinism:** promotions are ordered `priority DESC → createdAt ASC →
promotionId ASC` (an explicit tiebreak — "highest priority wins" alone is ambiguous under equal
priority); `stackable:false` is exclusive of all lower-priority promotions on the same line/order.
`resolvePrice` is never touched.

### Loss-leader operationalization (the three mechanisms, made real)
1. **Anchor / promote the SKU** — a `loss_leader` promotion sets a below-margin price **and** flags
   the product for prominence; MERCH-C's pin/boost and MERCH-A's placements consume the flag
   (boost in search, feature on home, attach cross-sells).
2. **Budget cap** — `budget.maxDiscountMinor` / `maxQuantity` bounds the loss, enforced race-safe.
3. **Attach analytics** — `commerceSummary` gains `attachRate` (orders containing the leader that
   also contain a full-margin item) + `basketMarginMinor` (per-order margin using product cost),
   so success is judged on **basket margin, not SKU margin** — the actual loss-leader test.

## Phased plan
- **Phase 1 (engine + REST):** the `Promotion` model + pure `applyPromotions` + `createOrder`
  integration via the **additive `OrderItem.discountMinor` + `Order.appliedPromotions[]`** seam (NOT
  `unitPriceOverride`) + the budget CAS counter (reserve-in-the-stock-rollback-block + release-on-expiry)
  + promotions CRUD; **migrate the coupon path into the engine** as `type:'code'` (single application).
  Governance: over-budget promotions park in the ADR 0221 approvals inbox; the approval content-key
  includes the fired-promotion ids + promoted total.
- **Phase 2 (analytics + storefront):** `commerceSummary` attach-rate + basket-margin; storefront
  promotion display (badges, threshold progress "spend $X more for free shipping" — the cart AOV
  nudge); scheduled-window activation via a daemon tick (the `publishSweep` pattern).
- **Phase 3 — Core-app extension surface:**
  - **Node pack** `feature.promotions.nodes` — `promo.upsert`, `promo.apply` (preview), `promo.list-active`, `promo.attach-report`.
  - **Agent pack** `feature.promotions.agents` — the **Promotions Manager** agent (chat-drivable,
    ADR 0058), grounded closed-world on promotion types + budget/segment vocabulary; drafts offers,
    over-budget offers route to approval.
  - **`ctx.features.promotions`** — read (`list-active`, `apply` preview) + governed write behind
    toggle + RBAC, advertised at `/.well-known/openwop`.
  - **Envelopes:** `promotions.create` routed to the service.
  - **Holdout:** offer A/B via `variantAssignment` (which cohort sees the promotion) + z-test on
    conversion/RPV — offers become measurable, not assumed.

## Alternatives weighed
- **Extend coupons in `commerce` in place** — rejected: a rules engine is a distinct concern with its
  own agent/analytics; the Talon.One "decoupled incentives engine" model keeps promotions reusable
  and out of the pricing resolver. Coupons remain in commerce as the `type:'code'` primitive the
  engine composes.
- **Teach `resolvePrice` about promotions** — rejected (ruling 2): overloads the contract-pricing
  resolver and entangles two independent axes. Post-resolver delta keeps ONE resolver.
- **Advisory budget counter** — rejected: races oversell the discount; use the CAS choke point.

## Open questions
- [ ] Product **cost** source for basket-margin — a `costMinor` field on `Product` (additive, via the
  ADR 0257 FieldDef seam) vs a price-list cost tier. Default: additive `costMinor` on Product.
- [ ] Stacking model depth — priority + exclusive flag (Phase 1) vs a full stack-group DSL (deferred).
- [ ] Whether `free_shipping` (currently a stub) becomes a real reward composing the ADR 0250 carrier
  rate (default: yes, Phase 2).

## Feature Evaluation Matrix
1. **Package:** `src/features/promotions/`; reads commerce + CRM segments; never forks pricing. 2. **Toggle:** `promotions`, OFF, `tenant`. 3. **Workflow surface:** `ctx.features.promotions` (read + governed write). 4. **Node pack:** `feature.promotions.nodes`. 5. **Envelopes:** `promotions.create`. 6. **Agent pack:** Promotions Manager. 7. **Public surface:** promotion *display* on the public storefront (read, tenant-from-resource, active+scheduled only) — writes are authed-only. 8. **RBAC:** writes `workspace:write` + over-budget → approval (ADR 0221); IDOR + fail-closed. 9. **Replay:** fired-promotion list + deltas snapshot onto the Order; offer holdout deterministic. 10. **Frontend:** `promotionsClient.ts` + promotions admin (rule builder + budget + schedule + preview) + storefront badges + `ui/` cohesion.
