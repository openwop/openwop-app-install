# ADR 0275 — MERCH-C: Discovery — faceted + semantic search, collections & merchandising rules

**Status:** implemented (status line corrected 2026-07-06 — shipped, route-tested, and packed in PRs #1316–#1331; the line had gone stale)
**Date:** 2026-07-05
**Program:** [ADR 0271](0271-commerce-merchandising-program.md) (Commerce Merchandising) — MERCH-C, Phase 1
**Depends on:** ADR 0177/0224/0225 (commerce catalog + `listProducts` + storefront), ADR 0257 (typed product FieldDefs — the facet source), ADR 0011 (KB/RAG + host `db.vector` — semantic recall), ADR 0059/0060 (`priority-matrix/scoring.ts` — ranking), ADR 0236 (`variantAssignment` — merch-rule holdout), ADR 0211 (CRM segments), ADR 0058/0073 (chat). **RFC verdict: host-extension — no OpenWOP RFC** (search/collections are storefront-internal; a collection could later be a UCP catalog category via ADR 0178's own path, not a wire RFC).

## Why this exists

Search today is `listProducts(tenantId, orgId, q?, {category, tag})` (`commerceService.ts:244`) — bare
relevance ranking, filter only by one category/tag, no facets, no synonyms, no semantic recall, no
merchandiser control. Categorization is a flat `categories[]`+`tags[]` bag with no collections or
taxonomy. This ADR adds a `discovery` package: **faceted + semantic** product search, **collections**
(manual and rule-based/dynamic), a category **taxonomy**, and a **pin/boost/bury merchandising rule**
layer over ranking — with a **preview** and **holdout** so a merch rule is proven before rollout (the
Algolia-Merchandising-Studio pattern).

## /architect pre-implementation corrections (2026-07-05)

A Track-A review before coding hardened six points (folded into the design below):

1. **Lexical↔semantic fusion (not a third ranker).** `listProducts` lexical `scoreOf`
   and the `db.vector` cosine ranking are merged by an explicit **weighted/RRF fusion**
   (the ADR 0113 hybrid-retrieval pattern); the pin/boost/bury merch-rule layer then
   re-orders that ONE fused candidate set — a post-ranking transform, never a second ranker
   (ruling 4).
2. **Vector namespace = tenant+org** — product embeddings live under
   `commerce:product:${tenant}:${org}` in the shared `host.db.vector`; queries filter to that
   namespace (cross-tenant recall would be an IDOR at the vector layer). Mirrors
   `host/subjectMemory.ts` (`buildHostSurfaceBundle().db.vector` + `embedText`). NO second
   embedding store / engine.
3. **Honest O(n) scale ceiling** — the default `host.db.vector` is brute-force cosine over an
   in-memory Map (`inMemorySurfaces.ts`); `host/vector/pgVectorVector.ts` is the Phase-2 scale
   engine. Semantic product search is bounded to small catalogs unless pgvector is configured —
   logged, per the ADR 0239 search-honesty precedent.
4. **The product vector index is a DERIVED cache** — re-upsert `embedText(name+desc+tags)` on
   product create/update, delete on product delete (+ a rebuild path); never authoritative,
   always rebuildable from `listProducts`.
5. **Dynamic-collection membership resolves at read** (ADR 0211) — a dynamic collection stores
   only its facet-predicate rule; membership is computed live from `listProducts`, never
   materialized. Manual collections store curated `productIds[]`. Neither is a second product store.
6. **Public facets over ACTIVE products only** — a facet value present only on a draft product
   must not leak its existence; the public search/facets derive from the active set.
   The Phase-2 CMS `productGrid`←collection integration resolves via a seam/public route, never a
   `cms`→`discovery` import (no cycle).

---

## Boundaries audit
- **Route namespace:** `/v1/host/openwop-app/discovery/*` — collision-free (`grep -rn "discovery"` no route owner).
- **Catalog ownership (ruling 1):** extends `listProducts` reads; no product store. Facets read the typed `productFields` (ADR 0257) + `attributes`.
- **Semantic engine (ruling — reuse):** the host `db.vector` + deterministic embedder already power KB/RAG (ADR 0011). A product-scoped vector collection reuses it; **no dedicated product-embedding store.**
- **Ranking (ruling 4):** `rankByPriority`/`computePriority` supply base relevance weighting; merch rules re-order the ranked set (pin/boost/bury).
- **Experiment (ruling 3):** merch-rule A/B reuses `variantAssignment` + z-test.

## Decision & data model
`discovery` feature-package, toggle `discovery` (OFF, `tenant`).
- **Facets:** `GET /discovery/orgs/:orgId/search?q&filters&sort` returns products + **facet counts**
  over category/tag + typed FieldDefs (enum/number ranges). Filters compose (AND across facets, OR
  within). Keyword relevance keeps `listProducts` scoring; **semantic recall** adds vector neighbors
  from the product `db.vector` collection when `q` is non-trivial (the "warm jacket → insulated
  jackets" recall a naive build misses).
- **Collection:** `Collection{collectionId, orgId, name, slug, type, rule?, productIds?, sortMode}`
  where `type ∈ {manual, dynamic}`. A **dynamic** collection carries a `rule` (facet predicate over
  attributes/price/tag) resolved **live** (the ADR 0211 discipline — a virtual/dynamic category);
  a **manual** collection is a curated `productIds[]` with a merchandiser `sortMode`. Taxonomy = a
  one-level parent on `Collection` (a category tree; strict at write, silent-ungroup at read).
- **Merchandising rules:** `MerchRule{ruleId, orgId, scope, actions[], holdoutPct?, active}` where
  `scope ∈ {query:<term>, collection:<id>, category:<id>}` and `actions[] ∈ {pin(productId,pos),
  boost(predicate,factor), bury(predicate), hide(predicate)}`. Applied over the ranked result set for
  the matching scope; a **preview** endpoint returns the ruled order **before activation**; a holdout
  splits treatment/control via `assignWeightedVariant` so lift is measurable.

## Phased plan
- **Phase 1:** faceted search over FieldDefs + collections (manual + dynamic) + taxonomy CRUD + the
  storefront browse/facet UI (extends `StorefrontPage`/`CatalogView`).
- **Phase 2:** product `db.vector` semantic recall + the MerchRule layer with preview + holdout;
  merchandiser console (visual pin/boost/bury with live preview) on `/commerce` or `/merchandising`.
- **Phase 3 — extension surface:** node pack `feature.discovery.nodes` (`discovery.search`,
  `collection.upsert`, `merch-rule.upsert`); the **Merchandiser** agent (shared with MERCH-A —
  collections/rules are the same persona's remit); `ctx.features.discovery.search` (read); envelope
  `discovery.curate`. CMS `productGrid` gains a `collectionId` source (curated grids).

## Alternatives weighed
- **Buy Algolia/Bloomreach via a connector** — possible later behind a `SearchProvider` seam; the
  native build is margin/attribute-aware over our own catalog and needs no egress. Reject as the
  primary.
- **A dedicated search index (Elastic/OpenSearch)** — deferred; `listProducts` + `db.vector` covers
  Phase-1 scale. Log the scale ceiling honestly (ADR 0239 "search honesty" precedent) rather than
  claim unbounded search.

## Open questions
- [ ] Product-embedding freshness (re-embed on product write vs batched). Default: on-write enqueue.
- [ ] Facet config — auto-derive facetable fields from FieldDefs vs an explicit facet allowlist.
  Default: allowlist (avoids leaking every field as a facet).
- [ ] Taxonomy depth — one level (Phase 1) vs nested tree (deferred).

## Feature Evaluation Matrix
1. **Package:** `src/features/discovery/`; extends commerce reads. 2. **Toggle:** `discovery`, OFF, `tenant`. 3. **Workflow surface:** `ctx.features.discovery.search`. 4. **Node pack:** `feature.discovery.nodes`. 5. **Envelopes:** `discovery.curate`. 6. **Agent pack:** Merchandiser (shared with MERCH-A). 7. **Public surface:** search + collection reads on the public storefront (tenant-from-`:orgId`, active only, rate-limited). 8. **RBAC:** reads `workspace:read`, curation `workspace:write`, IDOR + fail-closed. 9. **Replay:** merch-rule holdout deterministic from session key; dynamic collections resolve live. 10. **Frontend:** `discoveryClient.ts` + facet browse + merchandiser console (preview) + `ui/` cohesion.

## Correction note (2026-08-14 — PD2-4 / PD2-7, UX_UPGRADE-product-discovery R2)

Two claims in this ADR's decision text were found overstated by the R2 source
audit; per the correct-don't-rewrite rule they are corrected here rather than
edited above:

- **"Semantic recall" ships only as semantic RE-RANKING.** `rrfFuse` keeps
  only products already present in the lexical candidate set, and that set
  comes from strict-AND substring matching — the vector layer contributes
  zero RECALL (a "Winter Parka" can never surface for "coat"). Honest recall
  requires unioning semantic ids into the candidate set (resolved against the
  live active catalog) — a ranking change deserving its own review, tracked
  as PD2-4 in the feature tracker. Until it lands, the wire behavior is
  faceted lexical search with semantic re-ordering.
- **"Preview before activation" does not exist for merch rules.** Rules go
  live on create; the console's preview panel previews SEARCH results, not
  pending rules, and `appliedRuleIds` is returned by the route and discarded
  by the client (PD2-7). A true staged-rule preview is future work.
