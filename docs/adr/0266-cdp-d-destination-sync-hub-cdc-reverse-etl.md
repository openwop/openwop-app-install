# ADR 0266 — CDP-D: Destination-sync hub, field-mapping, CDC cursor & reverse-ETL write

**Status:** in-progress (catalog + CDC watermark + field-map + prepare node/surface + bigquery-write provider shipped; warehouse LOAD is enabled via COMPOSITION — prepare -> authed core.openwop.http/openapi-call on the bigquery-write connection, no bespoke node per the reuse ruling)
**Date:** 2026-07-05
**Depends on:** ADR 0262 (CDP program + rulings), ADR 0024 (Connections), ADR 0028 (connector-action governance), ADR 0037 (connector framework), ADR 0076 (BigQuery read-only — **loosened** here for the write variant), ADR 0020 (consent egress), the workflow executor + `core.openwop.http`/`adsAdapter`, RFC 0095 (connection packs), RFC 0099 (`TriggerEvent.source` — the streaming extension gate)
**Part of:** CDP program (ADR 0262). CDP-D, Phase 1 (+ Phase 4 for streaming/warehouse).

## Why this exists

A CDP closes the loop by **activating** traits/audiences to downstream destinations (CRM, ESP, ad
platforms, warehouse, custom webhook) with field-mapping, incremental (CDC) sync, and observability.
Today activation is real but **destination-specific and non-generic**: `host/adsAdapter.ts` +
`campaign-connectors` do live ad-platform audience upload + metric sync; `core.openwop.http.fetch`
is generic SSRF-guarded egress but a raw node, not a managed destination; there is **no
destination catalog, no trait→field mapping, no CDC** (`syncService.ts:35` `SyncStateRow.lastSyncAt`
is a **15-minute cooldown**, not a watermark cursor — `syncService.ts:9,97`), and **no
warehouse write** (BigQuery is deliberately read-only, `providerRegistry.ts:60` `readOnly` +
`assertReadOnlyConsistent`; nothing writes Snowflake/Redshift).

## Decision

Build a **`destination-sync` feature-package** — the single generic egress owner — reusing
Connections for credentials and the existing `core.openwop.http` / `core.openwop.integration` /
`adsAdapter` primitives for transport. **One egress owner (ADR 0262 ruling #3.)**

### 1. Egress-owner boundary (ruling #3 — decided here)

`campaign-connectors` already owns ad-platform egress with a careful consent-scope decision. CDP-D
adopts **Option (b): scoped split** — `destination-sync` owns **non-ad destinations**
(CRM/ESP/warehouse/custom-webhook); `campaign-connectors` stays the ad specialist. The boundary is
documented in both packages' headers. (Option (a) full generalization — ad-upload consuming the
generic abstraction — is deferred to a future consolidation ADR; it is not blocked, but ad-egress is
hardened enough that a refactor now buys little.)

### 2. Destination catalog + field-mapping

A `cdp:destination` config store (destination kind + Connection credential ref + `DestinationSync`
{ sourceObject, `fieldMap: trait→destField[]`, syncMode `batch|event|cdc`, schedule }). A
**field-mapping config UI** with **dry-run validation** (block publish on unmapped required fields).
Egress rides `core.openwop.http`/`integration` nodes (idempotent, retry/backoff/429 already handled).

### 3. CDC cursor (changed-records-only)

Add a durable **sync-cursor** — a real high-watermark (`updatedAt`/changelog id) per
(destination, sourceObject) — modeled on the existing `SyncStateRow`/`claimSync` CAS
(`syncService.ts:97`) but storing a watermark, not a cooldown. Each run emits only records past the
watermark; the CAS makes it exactly-once under concurrent triggers.

### 4. Consent-aware egress (unchanged seam)

Every sync subtracts consent + suppression at the existing chokepoints
(`consentService.isAllowed`, `crm/suppressionService.isSuppressed`) — reused verbatim, extended with
CDP-F `permittedPurposes` when that lands. Purpose-propagation *to the destination* is RFC-gated
(ADR 0262).

### 5. Sync observability + replay

Persist per-sync-run records → a runs table with per-record failure drill-down + a **replay/retry**
action reusing the executor's replay machinery (not a new job system).

### 6. Reverse-ETL warehouse write (Phase 4 — governance-gated)

A `dest.warehouse.load` node (BigQuery `insertAll`/load jobs; Snowflake stage+COPY) requires a
**write-scoped provider variant** (`bigquery-write` with a `bigquery.insertdata` write scope group)
because the current `bigquery` provider is `readOnly` and override-immune (`providerRegistry.ts`
`assertReadOnlyConsistent`). **Loosening ADR 0076's read-only invariant is deliberate and gated by a
connector-action-governance review (ADR 0028)** — recorded as an ADR 0076 correction note. No
OpenWOP RFC (a node calling a vendor API, like the ads packs).

> **Correction note (ADR 0292, 2026-07-06) — §6 Phase 4 is now IMPLEMENTED, and the "no bespoke
> node" stance is superseded.** This ADR's status line and §6 sketched enabling the warehouse load
> by **composition** (`prepare` → an authed `core.openwop.http` POST on the `bigquery-write`
> connection). An architect review overturned that: a raw `http.fetch` composition cannot host the
> three load-bearing invariants a governed subject-data write needs — the fail-closed
> `actionPolicyOf('warehouse.load')` **approval gate** (default `approval-required`), a **fork-stable
> `insertId`** so a replay/`:fork` dedups at BigQuery, and **honest partial-batch** surfacing of
> `insertAll`'s per-row `insertErrors`. So the write is a **governed surface verb**,
> `ctx.features['destination-sync'].warehouseLoad`, owned BY destination-sync (single-owner, ADR 0262
> ruling #3) and driven by a real `feature.destination-sync.nodes.warehouse-load` node — mirroring
> `host/adsAdapter.ts`'s spend-gate spine but keeping the `approval-required` default (a NEW write, so
> fail-closed is correct; adsAdapter reads policy directly only to avoid breaking pre-existing flows).
> The transport still reuses the sanctioned `brokeredPost` on `bigquery-write` (no bespoke sender —
> the ruling holds). See **ADR 0292** for the full decision. The Open-questions item "Warehouse-write
> governance default: `approval-required` … until proven" is thereby **resolved: approval-required
> stands as the default.**

## Scope / non-goals

- **Streaming/CDC *ingest* sources are CDP-G**, and adding `stream`/`change` to `TriggerEvent.source`
  is **RFC-gated** (RFC 0099) — out of scope for the host-ext core of CDP-D.
- No new HTTP/egress transport — everything rides existing SSRF-guarded nodes.

## Phased plan

1. **Phase 1:** `destination-sync` package + catalog + field-map + dry-run + CDC watermark cursor + observability/replay UI; node pack `feature.destination-sync.nodes` (`dest.sync.upsert`, `dest.field-map.apply`).
2. **Phase 4:** `dest.warehouse.load` + `bigquery-write` provider (governance review) + Snowflake/Redshift connection packs.
3. Verify: field-map dry-run tests; CDC watermark exactly-once concurrency test; consent-suppression egress test.

## Open questions

- [ ] Watermark source per object (updatedAt vs monotonic changelog id) — per-destination adapter choice.
- [ ] Warehouse-write governance default: `approval-required` action kind (ADR 0028) until proven.

## Consequences

Activation becomes destination-agnostic, incremental, and observable, with one generic egress owner
distinct from the ad specialist. The single load-bearing risk is the warehouse-write invariant
change — quarantined behind a new provider id + a governance review, not a blanket loosening.
