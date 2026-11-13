# ADR 1110 — Commerce catalog at scale: a counted cap, a paged product read, then a configurable limit

Status: implemented (2026-11-12). All five phases and the round fixes merged together in train 252 (main `7aa763d11b`): P1 #5803, P2 #5804, P3 #5811, P4 #5812, P5 #5815, round fixes #5820. They ship in one deploy (see the correction under P5).

Requested in #5801 by a white-label adopter (CasaVoga ADRs CV-0160 and CV-0164), whose firms
license trade catalogs of about 500,000 products. Extends [ADR 0410](0410-commerce-product-catalog-onto-the-content-kernel.md)
(products are `commerce.product` rows of the content kernel), [ADR 0386](0386-entities-headless-content-modeling.md)
§Indexing (which deferred "promoting hot filter fields to an indexed projection"), [ADR 0239](0239-commerce-scale-and-search-honesty.md)
DEF-3 (in-memory relevance search) and [ADR 0868](0868-durable-surface-bounded-scans.md) (`kvListPage` / `kvCount`).
Host storage and host-extension routes only, so no wire RFC is involved.

## Context

`features/commerce/commerceService.ts` caps a catalog at `MAX.perOrg = 5000`. The number cannot
simply be raised, because every read under it assumes the whole catalog fits in one request:

| Finding | Where |
|---|---|
| `createProduct` counts by listing: `assertCap((await listProducts(t, o)).length, 'products')`. An import of N products does N whole-catalog reads, so it is quadratic. | `commerceService.ts:498` |
| `listProducts` reads the whole **tenant's** product rows (`products.listForTenant` → `listSystemEntities` → `records.listByPrefix('<typeId>|')`), every row the full `ext.product` object, then filters by org, scores and sorts in memory. | `commerceService.ts:446`, `entities/kernelAdapter.ts:96`, `entitiesService.ts:945` |
| The kernel itself caps a type at `ENTITY_ROW_CAP_PER_TYPE = 10_000` rows per tenant, and its drift self-heal at the cap recounts with a whole-type `listByPrefix`. So 500,000 is refused by the kernel before commerce is reached. | `entitiesService.ts:48`, `:390` |
| 26 non-test call sites take the whole list: 13 on request paths (the cap and the summary included), 3 jobs, 10 in seeders (inventory below). | `grep -rn 'listProducts(' src` |
| The order cap counts the same way (`listOrders(...).filter(status !== 'canceled').length`). | `commerceService.ts:939` |

Storage is one key-value table (`host_ext_kv`, `k TEXT PRIMARY KEY, v TEXT`) on both Postgres and
SQLite. What it serves well is an ordered key-range scan: `kvListPage(prefix, {after, limit})`
reads exactly one page through `host_ext_kv_k_pattern` (ADR 0868, plan verified), and
`kvCount(prefix)` counts in the database. It has no index over a JSON field. A kernel row's key is
`hostext:entity:record:<typeId>|<entityId>`: the org is not in the key, so "this org's products,
filtered" has no range to scan today.

At 5,000 products a request reads a few megabytes. At 500,000 it would read about a gigabyte, on
every one of the nine request paths.

## Decision

### D1 — The kernel row stays the source of truth; the kernel maintains declared indexes beside it

Every product keeps its `commerce.product` kernel row exactly as ADR 0410 writes it: the CAS money
path, the `entity.written` events, erasure and the integrity gauges are unchanged. What is new is
a **kernel-owned** mechanism, `features/entities/systemIndex.ts`: a system type may declare
**index families** and a **projection** through `KernelAdapterConfig.indexes`. The kernel
maintains them inside `putSystemEntity`, `casSystemEntity` and `deleteSystemEntity`, which every
write of the type already passes through (the façade, migrate, the straggler re-sweep).
Commerce supplies only the declaration. `crm.deal` and `cms.page`, under the same 10,000-row cap,
can declare theirs later with no second mechanism (the KERNEL-5 lesson: four façades had already
drifted once).

The markers live in one `DurableCollection`, `entity:sysidx`. Its ids put the query dimensions in
the key, so each query is a key-range scan of only the matching slice. For `commerce.product`:

| Family | Id after `<tenant>:` | Serves |
|---|---|---|
| `n` (name order) | `n:<org>:<nameKey>:<id>` | the default list, paging, the whole-catalog iterator, drift counts |
| `c` (category) | `c:<org>:<category>:<nameKey>:<id>` | `?category=`, rule collections by category |
| `t` (tag) | `t:<org>:<tag>:<nameKey>:<id>` | `?tag=`, rule collections by tag |
| `w` (search token) | `w:<org>:<token>:<nameKey>:<id>` | text search (D3) |
| `low` (low stock) | `low:<org>:<id>` | the summary's low-stock list |
| `m` (manifest) | `m:<id>` | the marker keys and projection hash this row currently has |
| `pend` (intent) | `pend:<id>` | a sync that has started and not finished |

The tenant and org segments are raw on purpose: tenant ids contain `:` (`anon:…`, `user:…`), and
an encoded one would not match the fold's `from`, which is how a fold orphans an index. Every other
segment is `encodeURIComponent`'d, so a `:` in a name, category or tag cannot split a key and a name
equal to a tenant id cannot be rewritten by the fold. The family comes before the org so that
`kvCount('<tenant>:n:')` is directly comparable with the kernel's `<typeId>|` count. `nameKey` is
the name lower-cased, NFKD-folded and cut to 80 characters.

Each marker's value is a projection carrying `tenantId` and `orgId`, so the fold's content rewrite
and the org-cascade scans (`listForOrg`, `countRowsFor`, which match on JSON fields) see it. The
`n`/`c`/`t` projection is `productId, name, active, unlisted, type, price, currency, categories,
tags, updatedAt` (about 300 bytes). The `w` projection is slim (`productId, name, tags, active,
unlisted`, about 120 bytes). Neither carries `createdBy`, because the DSAR eraser (`erasure.ts`)
rewrites only the kernel row, nor `inventory`, which would turn every checkout into an index write.

Because the index is a `DurableCollection` whose tenant segment is raw and colon-bounded, it
self-registers with tenant teardown (ADR 0284) and the anon→user fold moves it with the generic
`rekeyTenantSegment`. grade-data Step 3.5 classes 1, 5 and 6 hold by construction. It needs no
migration and no per-backend SQL.

**Write path and crash ordering.** For one row the kernel:

1. computes the desired marker set and projection hash from the row it is about to write, and
   **returns at once if they equal the manifest's** (a checkout that does not cross the low-stock
   threshold writes no index row);
2. writes `pend:<id>` (the intent);
3. writes the kernel row (the source of truth; a lost CAS leaves the intent, which is harmless);
4. re-reads the stored row, computes the desired set from it, and CASes the manifest to it, so two
   concurrent syncs of one row serialise on the manifest and the last one reflects the stored row;
5. writes the new markers, then deletes the manifest's previous markers that are not desired;
6. deletes `pend:<id>`.

A crash at any step leaves either `pend:<id>` or a manifest that agrees with the markers. A sync is
idempotent because it always recomputes from the stored row. An index failure after step 3 never
fails the write: on the money path a paid order is never failed by an index row; the intent stays
for the repair.

**Repair.** `repairSystemIndex(tenant, type, {limit})` drains `pend:` rows (oldest first, bounded).
It runs from commerce's existing reservation-sweep tick (100 per tick) and from the ADR 1104 daily
gauge. The gauge also compares `kvCount('<tenant>:n:')` with the kernel row count per tenant and
reports `systemIndexDrift`; on drift it rebuilds that tenant's index by streaming the kernel rows
(D4) in pages. Every repair re-derives from the stored rows, so there is no one-shot sentinel that
could block a later repair. On first deploy the same rebuild backfills each tenant's existing
products.

### D2 — A maintained per-org counter for the cap

`createProduct` checks a per-org counter row (`entity:count` gains `<typeId>|<org>` rows) with
`bumpCount`'s semantics: CAS on every create and delete, a `+N` bump for a batch import, and at the
cap boundary only a recount with `kvCount('<tenant>:n:<org>:')`, so drift can never block the cap.
Not `kvCount` on every create: it is an index-range count, so an import of 500,000 products would
count about 10¹¹ index entries in total, which is the original quadratic import moved into the
database.

The kernel's own per-type cap becomes declarable: a system type may set `rowCap` on
`mintSystemType`, used in place of `ENTITY_ROW_CAP_PER_TYPE`. User types keep 10,000.
The host has no cap on workspaces per tenant, so the kernel cannot derive a tenant bound from
commerce's per-org cap. `commerce.product` therefore declares a sanity ceiling of 5,000,000 rows
per tenant, and the per-org cap (D2, D5) stays commerce's. The
kernel's boundary recount uses `kvCount` instead of `listByPrefix`, for every type.

### D3 — A paged, filtered product read replaces the whole-list read on request paths

```ts
listProductsPage(tenantId, orgId, {
  q?, category?, tag?, listedOnly?, activeOnly?, limit? /* 1..200, default 50 */, cursor?,
}): Promise<{ products: ProductRow[]; nextCursor?: string; total?: number; ranked?: { window: number } }>
```

- **Without `q`:** one family's range (`n`, or `c`/`t` when filtered), read with `kvListPage` from
  the cursor (the last key read, base64url), in name order. `listedOnly` and `activeOnly` filter the
  projections. A page reads at most `limit × 4` markers before returning with a cursor, so a
  sparse filter cannot read the catalog to fill one page. `total` comes from the D2 counter and is
  returned only for the unfiltered read.
- **With `q`:** at most 4 tokens, each of at least 2 characters (a one-character query is a name
  prefix on `n`). Each token is matched as a **prefix** of the `w` tokens. The rarest token is
  chosen by a bounded read (`kvListPage` with limit 2,001 per token), not by `kvCount`. Its slice
  is read in pages and the other tokens are checked on the projection (AND semantics, as ADR 0239).
  Ranking keeps 0239's weights (name 3, tag 2) and phrase bonuses over a window of the first 2,000
  matches. Pages inside the window are ranked; past it, paging continues unranked in name order.
  The response says which (`ranked.window`).
- **Changed (Q1):** the `w` tokens come from the name, tags, categories and variant names. The
  description is no longer searched, at every catalog size: indexing up to 4,000 characters per
  product would multiply the keyspace about tenfold at 500,000 products, and keeping the old
  in-memory search below a threshold would make results differ either side of it. The change goes
  in the CHANGELOG.

`getProduct` stays a point read. A new `getProducts(tenant, org, ids)` reads up to 200 by id.

### D4 — One named whole-catalog iterator for the jobs that need every product

`iterateCatalog(tenantId, orgId)` is an async iterator over the `n` family in pages of 500, followed
by a kernel read of each page's full rows (a new `getSystemEntities`: point reads, 16 at a time; the
storage layer has no multi-get today). It holds one page in memory. The unbounded `listProducts` is
**deleted**, and a ratchet test fails on a new whole-list read of `commerce.product` outside
`iterateCatalog`.

### D5 — The cap becomes a setting

`OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG` (deployment env), default **5,000**, hard ceiling
**500,000**. A value outside 1..500,000 fails the boot config check, and the cap error names the
setting. Nobody's behaviour changes until an operator sets it. A per-plan cap is not part of this
ADR (Q2).

### D6 — Orders follow the same shape (last phase)

`commerce.order` is a plain `DurableCollection`, not a kernel type, so it gets its own small index
collection, `commerce:order-idx`: `<tenant>:live:<org>:<orderId>` for non-canceled orders and
`<tenant>:at:<org>:<createdAt>:<orderId>` for the paged list, with the same intent-then-manifest
ordering, plus a per-org live-order counter for the cap. `commerceSummary` then aggregates from order
pages and resolves product names with `getProducts`.

## Caller inventory and where each one goes

| Caller | Today | After |
|---|---|---|
| Admin list route `routes.ts:123` | whole list + `q` | `listProductsPage` with cursor (the SPA list pages) |
| Storefront `routes.ts:514` | whole list, facets, `isPubliclyListed` | `listProductsPage({listedOnly, q, category, tag})`; the storefront SPA pages |
| Agent tool `agentTools.ts:161`, surface `surface.ts:74` | whole list | `listProductsPage`, `limit` ≤ 50, cursor passed back. A tool-contract change: an `LLM-EXCHANGE-AUDIT` row, schema text pinned (`promptCatalogParity`) |
| UCP catalog `ucp/routes.ts:145` | whole listed list | `listProductsPage({listedOnly})`. UCP is an external protocol: follow its catalog paging if it has one; otherwise a bounded first page, recorded as a P2 gate. No invented page token |
| Reference UCP merchant `referenceUcpMerchant.ts:87` | whole list + `q` | `listProductsPage` |
| Discovery search `discoveryService.ts:435`, `:438` | whole list + `q` | `listProductsPage({q, listedOnly})` |
| Collections `discoveryService.ts:223` | whole list, then filter | manual: `getProducts(ids)`; rule: the narrowest facet family, then the price/currency check on the projection, paged |
| Recommendations `recommendationsService.ts:364` | whole listed list | `getProducts(affinity ids ∪ trending ids)`; the anchorless fallback reads one page |
| Promotions `promotionsService.ts:668` | whole list per order | `getProducts(the order's line ids)` |
| Summary `commerceService.ts:1925` | whole list + whole orders | `low` family for low stock; names by `getProducts` (with D6) |
| `createProduct` cap `commerceService.ts:498` | whole list `.length` | the D2 counter |
| Data export `dataExport.ts:14` | whole list per org, arrays in memory (`collectPerOrg`, `host/featureDataExport.ts`) | `iterateCatalog`, and the export door streams sections (P3 changes the door's contract) |
| Catalog feed `catalogFeed.ts:80`, embedding index `productEmbeddingIndex.ts:57` | whole list | `iterateCatalog`, streamed. Embedding cost at 500,000 products is out of scope and stated |
| Seeders (`commerceShowcaseSeed` ×3, `demoCommerceDepthSeed` ×3, `demoMerchandisingSeed` ×2, `demoContentMarketingSeed`, `referenceUcpMerchant:49`) | whole list, filter `createdBy` | `iterateCatalog` over full rows (`createdBy` is not in the projection) |
| Entities erasure `erasure.ts` | `records.listForTenantIndexed` (every row of the tenant) | paged per type (P3) |
| Kernel `bumpCount` boundary, `countEntityNamespace` | `listByPrefix(...).length` | `kvCount` (P1) |

## Alternatives weighed

- **A SQL side table** (`commerce_product_index` with btree, GIN and `pg_trgm`). The fastest search
  and real filters. Teardown and the fold are not the obstacle: a table with `tenant_id` and
  `org_id` columns is covered by their schema introspection. The costs are two search shapes
  (`pg_trgm` on Postgres, FTS5 on SQLite for every white-label adopter), migrations on both
  backends, and a test harness (pg-mem) that supports neither. **Falsifier:** if search p95 on
  Postgres exceeds 300 ms in P1's 50,000-product test, the `w` family moves to such a table and the
  other families stay.
- **An index owned by commerce.** The first draft of this ADR. Rejected in review: it misses kernel
  writers commerce does not call, and the next façade to need it would build a second copy.
- **Re-key the kernel rows by org** (`<typeId>|<orgId>|<entityId>`). An org range for free, but it
  rewrites every system row of every type and every reader of `recordKeyOf`.
- **`kvCount` on every create** for the cap. The first draft's choice. Rejected in review: an
  index-range count per create keeps the import quadratic, in the database.
- **Keep the in-memory search below a threshold.** Two search paths whose results differ at the
  threshold (see Q1).
- **Raise only the number.** Rejected for the reasons in the context table.

## Architect review (2026-11-11, before P1)

Track A only (host storage and host-extension routes; no wire). Findings, all applied above:

| # | Finding | Applied in |
|---|---|---|
| 1 | The index belongs in the kernel, the one writer every system row passes through | D1 |
| 2 | "Write markers before deleting stale ones" did not prevent a missing marker if the process died after the kernel write, and two syncs could interleave | D1 intent + manifest ordering |
| 3 | A `kvCount` per create kept the import quadratic | D2 counter |
| 4 | The family must come before the org (drift count) and markers must carry `tenantId`/`orgId` (fold, org cascade) | D1 |
| 5 | `createdBy` in the projection would escape DSAR erasure | D1 projection |
| 6 | `inventory` in the projection would add index writes to every checkout | D1 projection, write step 1 |
| 7 | The SQL-table rejection cited teardown, which introspection covers; the real costs are SQLite parity and pg-mem | Alternatives, with a falsifier |
| 8 | The agent-tool cursor is a tool-contract change | Caller table |
| 9 | UCP paging must follow the external protocol | Caller table, P2 gate |
| 10 | Export, erasure, `countEntityNamespace` and `bumpCount` were missing from the inventory | Caller table |
| 11 | Search work must be bounded (tokens, rarest-token choice, past-window paging) | D3 |

## Phases

| Phase | Ships | Gate |
|---|---|---|
| P0 | This ADR | architect review (above) |
| P1 | Kernel `systemIndex.ts` (families, manifest, intent, repair, drift gauge); declarable `rowCap`; the `kvCount` boundary recount; the per-org counter; `commerce.product`'s declaration and backfill; `listProductsPage`, `getProducts`, `iterateCatalog`; the counted product cap | unit tests per family; a crash test at each write step; concurrent-sync test; fold and teardown tests through the real writers; a 50,000-product test (a page reads ≤ limit × 4 markers; search p95 recorded against the falsifier) |
| P2 | The request-path callers moved; admin list and storefront paging in the SPA; the LLM-exchange row; the UCP decision | per-caller tests; sabotage of the page bound |
| P3 | Jobs and seeders on `iterateCatalog`; the export door streams; erasure paged; `listProducts` deleted; the ratchet | ratchet red on a reintroduced whole-list read |
| P4 | `OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG` | boot check; cap at the setting |
| P5 | `commerce:order-idx`, the order counter, paged orders, the summary | as P1, for orders |

## Implementation record

### P1 (kernel declared index, counted cap, paged read, iterator)

| Piece | Where | Test |
|---|---|---|
| `listByPrefixPage`, `countByPrefix` on `DurableCollection` | `host/hostExtPersistence.ts` | via the suite below |
| Declared indexes: markers, manifest, intent lease, repair, rebuild, counter | `features/entities/systemIndex.ts` | `test/adr1110-system-index.test.ts` |
| Kernel hooks in `putSystemEntity` / `casSystemEntity` / `deleteSystemEntity`; `rowCap`; `kvCount` boundary recount; `iterateSystemEntities`, `getSystemEntities`, `countSystemEntities` | `features/entities/entitiesService.ts` | same |
| commerce.product's declaration | `features/commerce/productIndex.ts` | same |
| `listProductsPage`, `getProducts`, `iterateCatalog`, the counted cap, `repairCatalogIndex`, `catalogIndexGauge` | `features/commerce/commerceService.ts`, `reservationSweep.ts`, `feature.ts` | same |

Sabotage, each restored, each red: a rebuild that does not force markers (1), the fold
tenant override removed (1), no full-row recheck on hydrate (1), no scan budget (1),
`updatedAt` back in the projection (1), stale markers not deleted (3), the lease released
while dirty (1).

**Corrections found while building P1** (the decisions above stand except as noted):

- **Keys carry the type** after the tenant: `<tenant>:<type>:<family>:<org>:…`, so two
  system types of one tenant cannot share a family slice.
- **The `w` projection** also carries `categories` and `variantNames` (the AND check and
  ranking read them); the `low` projection carries no stock figure; **no projection
  carries `updatedAt`**, which changes on every write and would have made every checkout an
  index write.
- **`listProductsPage` returns full products**, hydrated by point reads, not projections,
  so callers keep their shape; the projection is only for filtering and ranking.
- **The counter** lives in `entity:sysidx-count` and is moved by the sync itself (counted
  family membership), not in `entity:count`.
- **Repair runs from the commerce sweep tick, not the gauge.** ADR 1104 gauges are
  read-only by contract. The tick drains intents (100 per tick) and, under a UTC-day lease
  (`commerce:catalog-index-day`), rebuilds any tenant whose counted family disagrees with
  the kernel. The gauge (`commerce-catalog-index`) reports `driftTenants` and
  `pendingIntents`.
- **A pre-existing fold defect, fixed here.** The anon→user fold rewrites a row's
  top-level fields only (`tenantMigration.rewriteRowContentTenant`), so after a fold
  `ext.product.tenantId` still named the anon tenant and `getProduct` refused every folded
  product. `kernelToProduct` now takes the tenant and org from the row.
- **Deploy skew.** While an older revision still serves, its product writes land without
  markers. The daily drift check sees the counted family short of the kernel count and
  rebuilds that tenant; until then the cap reads low by those rows and the paged read
  (P2) would not list them. P2 must not ship in the same deploy as P1 for that reason.
- **Markers are read through validators** (`readRowProjection`, `readSearchProjection`):
  a malformed marker is skipped like a corrupt row, never cast.
- **The 50,000-product test is not run yet.** P1 was built while the shared machine was
  short of memory (one test file at a time). The page bound is witnessed with 301 products
  (a sparse filter reads one 50-row page and returns a cursor); the 50,000 measurement and
  the search-latency falsifier run in the P2 window.

### P2 (request-path callers, the SPA, the shared Combobox)

| Caller | Now | Test |
|---|---|---|
| Admin list route | `listProductsPage` + `?ids=` by-id read + `type`/`state` filters on the server | `test/adr1110-p2-routes.test.ts` |
| Storefront route | one listed page + `nextCursor` | same |
| UCP catalog | UCP cursor pagination: `limit`, `cursor` in; `pagination: {has_next_page, cursor}` out (the Search capability's shared contract, ucp.dev) | same |
| Agent tool `list-products` | 50 per page, `cursor` input, `nextCursor` + `truncated` out | `test/commerce-agent-tools.test.ts` |
| Workflow surface `listProducts` | the first 200 matches (the node takes `q` to narrow; the pack is unchanged) | `test/commerce-*` suites |
| Reference UCP merchant search | `listProductsPage` (50) | existing |
| Discovery search + collections | a bounded candidate set (`DISCOVERY_CANDIDATE_LIMIT` = 1,000) with `candidatesTruncated`, the console saying "more than N"; manual collections by id, rule collections from their narrowest facet slice | `test/adr1110-p2-services.test.ts` |
| Recommendations | the anchor's category and tag slices (500) plus affinity and trending ids by point read | `test/recommendations*` |
| Promotions | the order's own line products by point read | `test/promotions*` |
| Summary low stock | the `low` slice, decided on the full row (unchanged rule), at most 200 | `test/adr1110-p2-services.test.ts` |
| SPA | Products tab pages (server search and filters, "Showing X of Y", Load more, deep link by id); quote, price-list, price-preview pickers are the new `ui/Combobox` (`ProductPicker`); campaign product chooser searches and pages; storefront pages and checks a refused line by id | `ui/__tests__/Combobox.test.tsx`, `commerce/__tests__/productsPaging.test.tsx`, updated `reloadHonesty`, `paymentsNotice`, `storefrontRefusals`, `campaignDetailPage` |

Sabotage, each restored, each red: Combobox sequence guard, `aria-activedescendant`, a
failure shown as "No matches", arrows choosing (1 each); Load more without the cursor,
search filtered in the browser, the deep link without the by-id read (1 each); semantic
recall without the description-only products (1).

**Corrections and residue found in P2:**

- **Search by description comes back through semantic recall.** Over the whole listed
  catalog (no collection scope), discovery adds products that only recall found, scored on
  their recall rank alone, so a description match still reaches the storefront search where
  the vector store runs. Inside a collection the set stays the collection's.
- **A page that ends at the slice's last row returns no cursor**, so a caller never pages
  into an empty page (found by the route test).
- **The ADR 1098 reader census matched the old reader names only**, so files reading through
  the new readers escaped classification. It now matches `listProductsPage`, `getProducts`
  and `iterateCatalog` too.
- **Residue, stated:** the storefront's category chips come from the products loaded so far
  (a facet read would list them all); recommendations still read the org's trending rows
  from the affinity cache whole (`affinity.listForTenantIndexed`), which grows with products
  that have sold, not with the catalog; orders are still read whole until P5.

### P3 (jobs and seeders on the iterator; `listProducts` deleted)

Decided at the start of P3 (architect pass on the remaining whole-catalog readers):

- **The export door gains a cursor form.** It used to call the exporter for every page and
  slice the whole result, so walking a 500,000-product export read the catalog once per
  page. A feature may now register `registerFeatureDataPagedExporter` (`cursor` in,
  `nextCursor` out); the door passes `?cursor=`, and the SPA client walks `nextCursor`
  before `nextOffset`. Commerce's exporter pages products org by org, then the orders,
  coupons and quotes sections by offset (those move with P5).
- **The catalog feed streams.** The public XML is written batch by batch
  (`feedXmlHead` / `feedXmlItems` / `FEED_XML_TAIL`, byte-identical to `renderFeedXml`);
  the settings view counts up to 10,000 items (`itemsCapped`) and lists the first 200
  exclusions with their total. **A push keeps one approval per change set** (the gate
  binds its hash: approve what you see), so instead of splitting it, one push sends at
  most 10,000 changes and reports `remaining`; the next push sends the rest, because only
  sent items move the ledger.
- **Embeddings rebuild in batches, and never inside a request for a large catalog.** A
  catalog over 5,000 (`SYNC_REBUILD_MAX`) is queued (`discovery:embedding-stale`) and
  rebuilt by a five-minute discovery sweep, one org per tick, each queued row claimed by
  deleting it first.
- **Seeders** read through `collectCatalog(tenant, org, keep)`, keeping only their own
  actor's rows. **Entities erasure** walks the tenant one type and one page at a time
  (complete: a type with rows cannot be deleted).

| Piece | Test |
|---|---|
| `listProducts` deleted; no whole-type read of `commerce.product`; every whole-catalog walker classified | `test/adr1110-no-whole-catalog-read.test.ts` (3 sabotages, each red) |
| Paged export, streamed feed identity, large-catalog embedding queue | `test/adr1110-p3-jobs.test.ts` |
| Push cap | `test/ads-catalog-feed.test.ts` |
| SPA export client walks `nextCursor`; feed card floor count | `billing/__tests__/dataExportClient.test.ts`, `campaign-connectors/__tests__/catalogFeed.test.tsx` |

**Residue, stated:** the SPA still merges an export into one JSON document in the browser,
so a 500,000-product export is a very large download built in memory (an NDJSON stream
would fix it, and is not in this ADR); embeddings of products that were deactivated or
deleted linger in the vector store and are filtered at query time (unchanged).

### P4 (the cap setting)

`OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG` (`maxProductsPerOrg`, read per create so a test or
an env update takes effect without a restart of the module), default 5,000, ceiling
500,000. The refusal names the setting (`details.setting`). Documented in
`backend/typescript/.env.example`. Test: `test/adr1110-p4-cap-setting.test.ts` (the cap
read from the old constant, and a value over the ceiling used as-is, each red).

> **Correction to D5 (2026-11-11, P4):** D5 said a value outside 1..500,000 "fails the boot
> config check". The host has no central boot config schema, and refusing to start over a
> typo crash-loops a deploy (CLAUDE.md records two outages of that shape). A bad value is
> instead logged as an error (`commerce_product_cap_invalid`) and the default stays in
> force, so a mistake can only keep the cap where it was, never raise it.

### P5 (orders)

> **Correction to D6 (2026-11-11, P5 architect pass):** D6 proposed a separate
> `commerce:order-idx` collection with its own intent-then-manifest ordering. That would be
> a second copy of the declared-index mechanism, the boundary error the P0 review fixed for
> products. Instead `systemIndex.ts` was generalized: a declaration may bring its own store
> (`registerStoreIndex`: `isRow` guard, `idOf`, `tenantOf`, `read`, `scan`), and
> `commerce.order` declares `at` (newest first), `st` (status, newest first) and `live`
> (not canceled, the counted family). Every order write in commerce goes through one
> wrapper that calls the index hooks; the demo seeder's backdating goes through
> `__backdateOrderForSeed` instead of writing the store directly.

| Piece | Test |
|---|---|
| Order families kept in step; a cancel leaves the live count; newest-first paging; status filter decided on the full row; `getOrders` org-guarded; the paged export walks orders | `test/adr1110-p5-orders.test.ts` (3 sabotages, each red) |
| Counted order cap (`indexedCount` of `live`, recount at the cap) | same, and the existing order tests |
| Route `GET …/orders` pages (`cursor`, `limit`, `total` unfiltered); `list-orders` tool pages with `cursor` and the true `total`; workflow surface returns the newest 200 | `test/commerce-agent-tools.test.ts` |
| Summary aggregates through `iterateOrders` (a page in memory at a time) | existing summary tests |
| Orders tab pages, filters status on the server, looks a full order id up directly | `commerce/__tests__/ordersPaging.test.tsx` (3 sabotages, each red) |

**Residue, stated:** these readers still take every order of the org, because each
aggregates over all of them: promotion usage, funnel stats, strategy metric sync, CRM lead
signals, recommendation affinity and child-order lookup. Orders grow with sales, not with
an imported catalog, so they are left for a measured follow-up. The summary visits every
order on each request (bounded memory, not bounded time). The guest-shipping retention
sweep still scans every order of every tenant each tick (pre-existing). The order index
rebuild (`scan`) reads the tenant's orders whole, which only a first build or a drift
repair does.

### Round fixes (after an independent grade of P1–P5)

An independent grader read the whole chain before it merged and found four blockers, all
fixed in the round-fix PR with sabotage-witnessed tests (`test/adr1110-round-fixes.test.ts`
and additions to `adr1110-system-index`), and recorded in
`docs/steward/CODEBASE-ASSESSMENT-adr1110.md`, `UX-ASSESSMENT-adr1110.md` and
`DATA-ASSESSMENT-adr1110.md`.

> **Correction to D1 "Repair" and P1's "On first deploy the same rebuild backfills each
> tenant's existing products" (2026-11-11):** the first read of an unbuilt tenant rebuilt
> its whole index inside the request, and concurrent requests each started one; for orders
> the scan had no bound at all. The claim that this was "bounded for every tenant that
> predates ADR 1110" was false (10,000 products × 15–40 markers each). Now a request builds
> inline only up to 500 rows (single flight per tenant); a larger tenant is queued
> (`entity:sysidx-build`) and built by the new `catalogIndexSweep`, and readers use a
> bounded fallback (the pre-index read) meanwhile. The sweep also queues every product
> tenant whose index was never built.

> **Correction to D1 "Write path and crash ordering" ("a crash at any step leaves either
> an intent or a manifest that agrees with the markers"):** false as written. The repair
> sweep could sync an intent whose write had not landed, delete it, and the write then land
> with its process dying before the after-hook: a stale marker and no intent. Now an
> unleased intent younger than the lease (`markedAt`, refreshed on every mark) is left to
> its writer. Separately, a pass whose lease expired could overwrite a newer pass: a holder
> now re-checks its lease before writing and moves the manifest by compare-and-swap.

> **Correction to D1 "Repair" (`built` trusted):** a `built` row was trusted for good, so a
> fold of an unindexed tenant into a built one left the folded rows out of every list. Now
> `built` is verified once per process by comparing the store's row count with the size
> of a family every row has a marker in (`everyRowFamily`), and the daily check does the
> same for every built tenant of both types, every hour, and recounts every org counter. Hourly bounds deploy skew: rows an older revision writes without markers during a deploy overlap are back in the lists within the hour.

> **Correction to the data-integrity premise of D1 ("the index ... self-registers with
> tenant teardown"):** true, but teardown and the org-delete guard read whole collections,
> and the index holds tens of rows per product. A `DurableCollection` may now declare its
> shape: `tenantKeyed` (teardown deletes the tenant's key range a page at a time) and
> `derived` (the org-delete guard does not count it). A zero counter is deleted, never
> written; before this, reading an emptied catalog left a row that blocked `deleteOrg`.
> The ghost-namespace pass of tenant teardown pages and skips live namespaces by key range.

> **Correction to the caller table and D3:** discovery, collections and the recommendation
> pool walked pages until they had enough matches, so a sparse filter walked the catalog.
> Each now stops after a page budget as well. The feed settings view stops after 20,000
> products read. A push over 20,000 products refuses (`catalog_too_large`) and points at
> the signed feed URL (the scheduled-fetch lane), so no push request walks a huge catalog.
> The streamed feed honours backpressure and stops when the fetcher leaves.

> **Correction to P1's deploy note ("P2 must not ship in the same deploy as P1") —
> decision changed 2026-11-11 with the release manager:** the chain (#5803 → #5804 →
> #5811 → #5812 → #5815 → #5820) is gated as ONE train and shipped in ONE deploy. The split
> existed because rows an older revision writes during the deploy overlap carry no markers.
> With the round fixes that is self-healing: `built` is verified by row count, and the
> hourly drift check queues a rebuild of any tenant whose index is short, so such rows are
> back in the lists within the hour. A tenant first read during the overlap is verified
> then; one written to by the older revision after that is caught by the next hourly check.

Also: upkeep moved off the reservation sweep into `catalogIndexSweep` (a long build no
longer delays reservation release), one failing intent no longer stalls the repair batch,
and the export cursor names the org by id.

### Train 252 (the merge gate)

The first two runs of train 252 were red on frontend checks that `ci:quick` does not run;
the fixes are on #5820 and nothing else changed:

- `catchEmptyListRatchet`: the paged product read removed both silent `catch → []` sites in
  `CommercePage.tsx`, so its allowance was deleted (the list only shrinks).
- `featureCopyNoAdrRefs`: 16 trailing `// ADR 1110` comments on locale string lines moved to
  their own lines.
- `galleryCoverage`: the new `ui/Combobox` got a gallery specimen, and the gallery's 25
  affected visual baselines were re-recorded in both the `-darwin` and `-pinned` sets.

## Decisions (the draft's open questions, closed in review)

- **Q1 — description search:** dropped at every size; name, tags, categories and variant names are
  indexed (D3). Stated in the CHANGELOG.
- **Q2 — per-plan cap:** not in this ADR. The deployment setting ships; a per-plan cap needs a
  gating decision for priced bundles (`priced ⟹ gated`) and is a separate change.
- **Q3 — search-marker size:** a slim `w` projection, about 0.8 GB at 500,000 products with about
  6 million markers, paid only by a deployment that raises the setting.

## Open questions

- None blocking P1. The UCP paging question is a P2 gate (caller table).
