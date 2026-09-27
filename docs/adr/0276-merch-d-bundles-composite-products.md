# ADR 0276 — MERCH-D: Bundles & configurable composite products (commerce extension)

**Status:** implemented (status line corrected 2026-07-06 — shipped, route-tested, and packed in PRs #1316–#1331; the line had gone stale)
**Date:** 2026-07-05
**Program:** [ADR 0271](0271-commerce-merchandising-program.md) (Commerce Merchandising) — MERCH-D, Phase 2
**Depends on:** ADR 0177 (commerce `Product`/`Order`), ADR 0224 (`resolvePrice` + stock ledger), ADR 0274 (promotions — bundle discount as a reward type), ADR 0257 (typed FieldDefs). **RFC verdict: host-extension — no OpenWOP RFC.** *UCP note:* if a bundle is projected into the UCP catalog (ADR 0178) it is a UCP-side concern (a composite offer), not an OpenWOP wire change — flagged for the UCP conformance check, deferred in Phase 1.

## Why this exists

There is no bundle/kit/composite product today (`BundleScope` in code is unrelated DI). Bundles raise
AOV and are the platform-native floor of the "configurable products" spectrum (fixed kit →
mix-and-match → configurator → visual/3D CPQ). This ADR adds **fixed and mix-and-match bundles** with
**component-weighted pricing** and **component inventory decrement** — the correctness bits a naive
"just a discounted group" build gets wrong.

## Boundaries audit
- **Ownership (ruling 1):** this **extends the `commerce` package in place** (the ADR 0224/0238 depth
  precedent) — **no new package, no new toggle.** A bundle is a `Product`, not a parallel entity.
- **Pricing (ruling 2):** bundle price composes `resolvePrice` per component; a bundle discount is a
  **promotions reward** (ADR 0274 `type`), not a second discount path.
- **Inventory:** the CAS stock ledger (`casAdjustProductInventory` + `StockMovement`) already supports
  atomic multi-decrement — a bundle sale decrements each component; no new inventory model.
- **CPQ overlap:** `commerce/quotes.ts` is B2B negotiation, not a self-serve bundle — distinct; a
  configurator (constraints) is deferred, logged.

## Decision & data model
Additive on the commerce `Product`: `kind: 'simple' | 'bundle'` (default `simple`, back-compat) and
`components?: { productId, variantId?, quantity, fixed: boolean }[]`.
- **Fixed bundle** — all components `fixed:true`; one PDP, one add-to-cart, one line that expands to
  component decrements at order creation.
- **Mix-and-match** — components with `fixed:false` + a `chooseFrom`/`chooseCount` selection group
  (build-your-own-box floor); the buyer picks within the group at PDP.
- **Component-weighted pricing** — the bundle's effective price (or a bundle-discount reward)
  **allocates to components by their resolved-price weight** (the Shopify Cart-Transform model), so
  refunds/partial-refunds and revenue attribution are correct per component (ruling 7 — snapshot the
  allocation onto the order line).
- **Component inventory decrement** — `createOrder` on a bundle line decrements each component via the
  CAS ledger (all-or-nothing under the reservation guard); a bundle's sellability = min component
  availability (`resolveSellable` extended).

## Phased plan
- **Phase 1:** `kind:'bundle'` + `components[]` on `Product`; `createOrder` bundle expansion +
  component decrement + weighted allocation; storefront bundle PDP (fixed); admin bundle builder in the
  commerce ProductForm.
- **Phase 2:** mix-and-match selection groups; bundle discount as a promotions reward (ADR 0274);
  bundle sellability in discovery/facets (ADR 0275).
- **Phase 3 — extension surface:** commerce node pack gains `product.bundle.upsert`; the Store
  Assistant agent (existing `feature.commerce.agents`) learns bundle vocabulary — **no new agent**;
  `ctx.features.commerce` bundle reads. Configurator with option-constraints = a logged, honestly
  separate future track (not this ADR).

## Alternatives weighed
- **Separate `Bundle` entity** — rejected (ruling 1): a bundle *is* a sellable product; a second entity
  forks the catalog, storefront, and UCP projection. Additive `kind` keeps ONE product store.
- **Bundle discount as a bespoke field** — rejected: reuse the promotions reward (ADR 0274), one
  discount engine.

## Open questions
- [ ] Nested bundles (a bundle containing a bundle) — reject in Phase 1 (flatten-or-refuse at write).
- [ ] Per-component images / variant selection depth for mix-and-match (default: component variant
  pick, no new image model).
- [ ] Whether bundle appears in the UCP catalog projection (default: no in Phase 1; UCP-side follow-up).

## Feature Evaluation Matrix
1. **Package:** extends `commerce` (in-place depth, ADR 0224 precedent) — no new package. 2. **Toggle:** rides `commerce` (no new toggle). 3. **Workflow surface:** `ctx.features.commerce` bundle reads/writes. 4. **Node pack:** `feature.commerce.nodes` +`product.bundle.upsert`. 5. **Envelopes:** rides commerce envelopes. 6. **Agent pack:** existing Store Assistant (no new agent). 7. **Public surface:** bundle PDP on the existing public storefront. 8. **RBAC:** commerce `workspace:write`; IDOR + fail-closed. 9. **Replay:** component allocation + decrement snapshot onto order lines; refund-deterministic. 10. **Frontend:** bundle builder in the commerce ProductForm + storefront bundle PDP.
