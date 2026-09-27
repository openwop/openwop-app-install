# ADR 0273 — MERCH-A: Recommendations, upsell & cross-sell (full-funnel)

**Status:** implemented (status line corrected 2026-07-06 — shipped, route-tested, and packed in PRs #1316–#1331; the line had gone stale)
**Date:** 2026-07-05
**Program:** [ADR 0271](0271-commerce-merchandising-program.md) (Commerce Merchandising) — MERCH-A, Phase 0
**Depends on:** ADR 0177/0224/0225 (commerce catalog/orders/storefront), ADR 0059/0060 (`priority-matrix/scoring.ts` weighted scoring), ADR 0236 (`host/variantAssignment.ts`), ADR 0211 (CRM segments live resolution), ADR 0058 (chat-drivability), ADR 0073 (EmbeddedChatPanel), ADR 0018 (analytics events). **RFC verdict: host-extension — no OpenWOP RFC** (UCP not projected in Phase 1).

## Why this exists

The seed list's core — *upsells, cross-selling* — has zero code today. This ADR adds a
`recommendations` package that turns the existing catalog + order history into full-funnel product
suggestions: **upsell** (a better/pricier variant on the PDP), **cross-sell** (a complementary
item at cart/checkout/post-purchase), and **frequently-bought-together** (co-purchase-mined),
ranked **margin-aware** and targetable by **CRM segment**, with every placement **holdout-testable**
for incremental lift.

## Boundaries audit (Step 3)

- **Route namespace:** `grep -rn "recommendations" backend/typescript/src` → no route owner. New
  prefix `/v1/host/openwop-app/recommendations/*` is collision-free.
- **Catalog/order ownership (ruling 1):** the package **reads** `commerce/commerceService.ts`
  (`listProducts:244`, `getProduct`, `Order` line data) — it creates **no** product/order store.
- **Ranking engine (ruling 4):** `priority-matrix/scoring.ts` already exports `computePriority`
  (`:39`) + `rankByPriority<T>` (`:84`) — an explainable weighted-criteria ranker. Recs reuse it
  with product-affinity criteria; **no new ML.** (Embedding/propensity ML is the shared CDP-C track,
  not forked here.)
- **Experiment engine (ruling 3):** `host/variantAssignment.ts` (`bucketOf:35`,
  `assignWeightedVariant:46`) + `cms/pageExperimentsService.ts` two-proportion z-test already exist
  — recs reuse them for holdout, no second bucketer.
- **Segments (ruling 5):** `crm/segmentsService` resolves membership live — recs reference a segment
  id, never a copied audience.
- **Placement surface:** the storefront (`StorefrontPage.tsx`) + CMS `productGrid` (ADR 0225) are
  the DOM; recs add slot components, not a new storefront.
- **Analytics:** `analytics` (ADR 0018) already records `conversion` events; rec impressions/clicks
  ride the existing beacon, no new telemetry store.

## Decision & data model

A `recommendations` feature-package (`src/features/recommendations/`), toggle `recommendations`
(OFF, `tenant`). Three composable pieces:

### 1. Recommendation sources (algorithms) — read-time, over existing data
- **`bought-together`** — a derived co-occurrence cache (`RecoAffinity{tenantId, orgId, productId,
  relatedId, coScore, computedAt}`), rebuilt incrementally by a schedule-daemon tick mining `Order`
  lines (a clearly-labeled **derived cache**, ADR 0211 discipline — never authoritative).
- **`upsell`** — same-category products of a higher resolved price than the anchor (via
  `resolvePrice`), ranked by margin + rating signals.
  *(/architect cross-link: the **margin** criterion needs `Product.costMinor`, which **MERCH-B
  (ADR 0274)** introduces. MERCH-A **degrades gracefully** — if `costMinor` is absent the `margin`
  weight is dropped and ranking falls back to affinity/category/recency; it never blocks on MERCH-B.)*
- **`cross-sell`** — complementary items by co-occurrence + category-adjacency.
- **`similar`** — attribute/category overlap over typed `productFields` (and, in Phase 1, semantic
  neighbors once MERCH-C wires `db.vector`).
- **`trending` / `recovery`** — top-conversion recent products; used for out-of-stock / 404 / empty
  slots (a top-tier placement most builds omit).

Each source returns candidate product ids; **`rankByPriority`** scores them against a configurable
`RecoWeights{affinity, margin, categoryMatch, recency, rating}` — this is the **margin-aware**
differentiator, explainable via the scoring engine's per-criterion breakdown.

### 2. Placements (the funnel)
`RecoPlacement{placementId, orgId, slot, source, segmentId?, holdoutPct?, active}` where
`slot ∈ {pdp, cart, checkout, post_purchase, category, home, oos_404}`. A placement binds a slot to
a source + optional segment target + optional holdout. `GET /recommendations/orgs/:orgId/resolve?
slot&productId?&sessionKey?` returns ranked products for a slot, applying:
- **segment targeting** — resolved live via CRM segments for the caller's resolved contact;
- **holdout** — `assignWeightedVariant(sessionKey, placementId, salt)` splits treatment/control so
  lift is measurable (the z-test reports `insufficientSample` below threshold, ADR 0236 honesty).

**/architect invariants (public-surface safety + replay):**
- **No client-supplied `contactId` on the public resolve (IDOR).** Personalization identity comes from
  the **authenticated session** or the signed `owx`/session-link token (ADR 0226) on the public
  storefront — **never a raw `contactId` query param** (which would let an anonymous caller harvest
  another contact's segment-targeted recs or probe segment membership). The public route surfaces
  **active products only** and leaks no inactive/draft product through a rec slot.
- **Run-surfaced recs are stamped for replay.** When `resolve` runs inside a workflow (the Phase-3
  email-node case), the **holdout assignment + returned product ids** are recorded into
  `run.metadata`/output and read verbatim on `:fork` — the reco cache is mutable, so live
  re-resolution on replay would drift (ruling 7, extended from order-affecting to run-affecting recs).

### 3. Post-purchase upsell
On the order-confirmation surface, a `post_purchase` placement offers an add-on; acceptance opens a
**fresh Stripe checkout** for the add-on line (Phase 0 — reuses the existing checkout;
true 1-click no-reauth is a logged fast-follow gated on saved-payment-method support). The offer
decision is **snapshot onto the originating order** (ruling 7) for attribution.

## Phased plan

- **Phase 1 (REST + engine):** the five sources + `rankByPriority` retarget + `RecoPlacement` CRUD +
  `resolve` route; the co-occurrence daemon tick; holdout + segment wiring. RBAC:
  read=`workspace:read`, placement writes=`workspace:write`, IDOR-guarded.
- **Phase 2 (storefront + CMS):** slot components on `StorefrontPage` (PDP upsell, cart cross-sell,
  post-purchase) + a `recoSlot` CMS section (composes `productGrid`); admin console tab on
  `/commerce` (or a `/merchandising` page) to configure placements with a **live preview**.
- **Phase 3 — Core-app extension surface:**
  - **Node pack** `feature.recommendations.nodes` — `reco.resolve`, `reco.rebuild-affinity`,
    `reco.placement.upsert` (read + governed write).
  - **Agent pack** `feature.recommendations.agents` — the **Merchandiser** agent (persona =
    `agentProfile`), chat-drivable per ADR 0058, grounded closed-world on the real slot/source
    vocabulary; drafts placements, never auto-activates a holdout without review.
  - **`ctx.features.recommendations`** — read-only `resolve` surface for workflows (e.g. an email
    campaign node fetching per-contact recs), behind the same toggle + RBAC, advertised at
    `/.well-known/openwop`.
  - **Envelopes:** `recommendations.configure` routed to the placement service (optional, if chat
    authoring wants a typed envelope beyond the agent tools).

## Alternatives weighed

- **Buy a recs vendor (Nosto/Rebuy) via a connector** — rejected as the *primary* build: it fragments
  the catalog and can't be margin-aware over our own cost data; a connector remains possible later as
  an alternate source behind the same `RecoSource` seam.
- **A new ML/embedding recommender now** — deferred: `rankByPriority` gives explainable,
  margin-aware recs immediately; embedding similarity arrives free with MERCH-C's `db.vector`, and
  statistical propensity is the shared CDP-C track (don't fork it).
- **Materialize per-contact rec lists** — rejected (ADR 0211): resolve live; only the product↔product
  co-occurrence is a labeled derived cache.

## Open questions
- [ ] Co-occurrence rebuild cadence + incrementalism at catalog scale (default nightly + incremental).
- [ ] 1-click post-purchase (saved-PM) — fast-follow; needs a Stripe SetupIntent path.
- [ ] Whether the Merchandiser + Promotions Manager agents are one persona or two (default: two —
  distinct vocabularies).

## Feature Evaluation Matrix
1. **Package:** `src/features/recommendations/` appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; reads commerce (never the reverse). 2. **Toggle:** `recommendations`, OFF, `tenant`. 3. **Workflow surface:** `ctx.features.recommendations.resolve` (read). 4. **Node pack:** `feature.recommendations.nodes`. 5. **Envelopes:** optional `recommendations.configure`. 6. **Agent pack:** Merchandiser. 7. **Public surface:** the `resolve` read is reachable on the public storefront route (tenant from `:orgId` resource, active products only, rate-limited) — same posture as `/public-store`. 8. **RBAC:** reads `workspace:read`, writes `workspace:write`, IDOR + fail-closed. 9. **Replay:** post-purchase offer snapshot onto the order; holdout assignment deterministic from `sessionKey`. 10. **Frontend:** `recommendationsClient.ts` + placement admin + storefront slots + `ui/` cohesion.
