# ADR 0292 — CDP-D §6: reverse-ETL warehouse write (governed BigQuery `insertAll`)

**Status:** Accepted (implemented 2026-07-06)
**Date:** 2026-07-06
**Depends on / composes:** ADR 0266 (CDP-D destination-sync hub — this implements its §6 Phase 4),
ADR 0262 (CDP program + ruling #3: destination-sync is the ONE non-ad egress owner), ADR 0024
(Connections credential broker + `brokeredEgress`), ADR 0028 (connector-action governance /
`actionPolicyOf`), ADR 0076 (BigQuery read-only — a **separate** write-scoped id here, not a
loosening; correction note added there), ADR 0167/0223 (`host/adsAdapter.ts` — the governed-write
spine mirrored here).
**Part of:** CDP program (ADR 0262). CDP-D, Phase 4.
**RFC gate:** **no new RFC.** A node calling a vendor API (BigQuery `tabledata.insertAll`), exactly
the class of the six shipped ad/connector packs. Credentials stay off the wire (opaque
`credentialRef`, ADR 0024 §5); no capability is advertised beyond what is wired and honored.

> **Numbering note.** Drafted as "ADR 0291" per the task brief, but 0291 was claimed by a parallel
> session (`0291-shell-white-label-branding-and-posture.md`) before this landed; renumbered to the
> next free slot, **0292**. No content change.

## Why this exists

A CDP closes the loop by **activating** traits/segments back into downstream systems. ADR 0266 shipped
the destination-sync hub (catalog + CDC watermark + field-map + the `prepare`/`prepare-onward` nodes)
and the write-scoped `bigquery-write` provider, but left the actual **reverse-ETL warehouse LOAD** as
Phase 4. ADR 0266 §6 sketched enabling it by **composition** — `prepare` → an authed
`core.openwop.http` POST on the `bigquery-write` connection. An architect review rejected that: a raw
`http.fetch` composition has nowhere to host the three invariants a governed subject-data write
requires:

1. a **fail-closed approval gate** on a brand-new warehouse write,
2. a **fork-stable per-row `insertId`** so a replay / `:fork` dedups at BigQuery rather than
   double-loading, and
3. **honest partial-batch** reporting of `insertAll`'s per-row `insertErrors` (the call is NOT
   atomic).

## Decision

Ship the warehouse load as a **governed surface verb owned by destination-sync**:
`ctx.features['destination-sync'].warehouseLoad`, implemented in
`features/destination-sync/warehouseLoadService.ts`, driven by a new
`feature.destination-sync.nodes.warehouse-load` node (role `action`). It is a **feature-level** verb,
NOT a new `host/` adapter — a host adapter would shadow destination-sync's egress ownership
(ADR 0262 ruling #3, "one non-ad egress owner"). The feature CALLS the host seams (features → host is
the allowed dependency direction): `host/brokeredEgress` (transport), `host/governanceService` (gate),
`host/approvalService` (the one approvals inbox). It mirrors `host/adsAdapter.ts`'s governed-write
spine, with the differences below.

### 1. The gate — `actionPolicyOf('warehouse.load')`, default `approval-required`

`actionPolicyOf(tenantId, 'warehouse.load')` returns `disabled | draft-only | approval-required`, and
an **unset** policy defaults to **`approval-required`** (governanceService's T6 posture). This is the
KEY difference from `adsAdapter`: adsAdapter reads the policy **directly** precisely to AVOID that
default (it would silently flip pre-existing ad flows). A warehouse write is **new**, so the
fail-closed `approval-required` default is **correct**, and there is **no spend-threshold logic** at
all. Verdicts:

- `disabled` → **refuse** (typed `disabled` result; no insert).
- `draft-only` → **dry-run**: return the rows that WOULD load (`wouldLoad: N`, `loaded: 0`), NO insert,
  NO `brokeredPost`. (The preview carries row bodies as the node output — its whole purpose is human
  review, like adsAdapter's dry-run plan.)
- `approval-required` / unset → **mint-or-consult** a `warehouse-load` `PendingApproval` keyed by a
  fork-stable batch idem key (stored in a `DurableCollection` map, mirroring adsAdapter's
  `spendApprovals`). Proceed to the insert **only** when that approval is `approved`; otherwise return
  `requires-approval` (approvalId + status). Approve-then-rerun of the same batch reuses the approval
  (same key), and a `:fork` cannot re-ask.
- A policy read that **throws** is treated as **gated** (fail-closed → `approval-required`), mirroring
  adsAdapter's catch.

### 2. Transport — `brokeredPost` on `bigquery-write` (ruling #3 satisfied)

The insert reuses the sanctioned `brokeredPost` (SSRF-guarded, credential-resolving, no-redirect,
bounded-timeout) on the `bigquery-write` provider — **no bespoke sender**. The URL is built from a
**hardcoded** BigQuery host constant (`https://bigquery.googleapis.com`, env-overridable for tests
only), never input-derived — exactly as adsAdapter builds its platform hosts — to
`…/bigquery/v2/projects/{project}/datasets/{dataset}/tables/{table}/insertAll`, body
`{ rows: [{ insertId, json: <field-mapped row> }] }`. The broker resolves the acting human's
`bigquery-write` credential host-side and injects it; the config's `connectionId` records the
operator's chosen connection for UX/validation but auth resolves by (tenant, provider, actingUser).

**The gate is un-bypassable (`adapterOnly`).** `bigquery-write` is marked **`adapterOnly: true`** on
its manifest, and the generic `ctx.http.safeFetch` provider-match (`matchAllowedProvider`,
connectionInjection.ts) **skips `adapterOnly` providers**. Without this, a run that opted the
`bigquery-write` connection in could POST `insertAll` through the generic `core.openwop.http.fetch`
node — injecting the write credential by apiHost-match and **skipping the approval gate entirely**
(`consumerNodes` is advisory, not enforced). With it, the ONLY path that reaches `bigquery-write` is
this adapter's `brokeredPost` (which resolves by explicit provider id, unaffected by the skip), so the
ADR 0028 separation-of-duty gate cannot be circumvented. (Code-review finding, applied pre-merge.)

### 3. Idempotency — deterministic `insertId`

Per-row `insertId = sha256([syncId, keyFieldValue, batchMarker])` (hex, 32 chars), where
`keyFieldValue` is the source record's `warehouseKeyField` (default `id`) and `batchMarker` is the
sync's **pre-sync cursor**. Fork-stable (no `runId`, never `randomUUID`) → a replay / `:fork`
re-issues identical `insertId`s and BigQuery `tabledata.insertAll` dedups them; a later batch
(advanced cursor marker) with the same key mints a NEW id, so an updated row re-inserts. The batch
**approval** key is a separate `whload:sha256([tenantId, syncId, dataset, table, marker])`.

### 4. Partial-batch (non-atomic)

`insertAll` returns per-row `insertErrors`. The result surfaces
`{ loaded, failed, errors: [{ index, reason }] }` — it does **not** claim all-or-nothing.

### 5. PII-safe

Row bodies are subject data: **never logged**, and **never** in the LOAD result envelope (only counts
+ `{index, reason}` per failed row — the reason is the BigQuery error `reason`/`message`, never the
offending row). The only place row bodies appear is the `draft-only` **preview** output (deliberate,
for review). The BYOK `bigquery-write` credential is resolved host-side by `brokeredPost` and never
reaches logs, results, or the approval row.

### 6. Config + approval-kind additions

- `DestinationSync` gains `project` / `dataset` / `table` / `warehouseKeyField`;
  `createDestinationSync` requires `connectionId` + `project` + `dataset` + `table` when
  `destinationKind: 'warehouse'`. (`project` is beyond ADR 0266 §7's three-field sketch but is
  mandatory — the `insertAll` URL cannot address a table without it.)
- `approvalService` gains a `'warehouse-load'` `kind` + a `createWarehouseLoadApproval(...)` helper
  (mirroring `createCampaignSpendApproval`), carrying `syncId` / `dataset` / `table` / `rowCount` and
  reusing the generic `spendIdemKey` binding. **No new approval store** (ADR 0025 §4) — the same
  durable queue + inbox + CAS resolve.

## Boundaries / duplication audit

- **Single owner.** The write lives in destination-sync (ruling #3); it is not a `host/` adapter and
  does not touch `campaign-connectors` (the ad specialist). `bigquery` stays read-only + override-immune
  (ADR 0076); only the separate `bigquery-write` id carries the write scope.
- **No parallel primitive.** The gate is the real `governanceService.actionPolicyOf`; the approval is a
  real `PendingApproval` in the one inbox; the transport is the real `brokeredPost`. Nothing is
  shadowed (the "no parallel architecture" rule).
- **Storage seam.** A feature surface is built from a `BundleScope` (no `storage` handle) but
  `brokeredEgress` types a `Storage`. Injected once at boot via `setWarehouseLoadStorage(storage)` in
  `index.ts` — the `setChatStorage` singleton precedent.

## Alternatives weighed

- **Composition (ADR 0266 §6's sketch):** `prepare` → raw `core.openwop.http` POST. **Rejected** — no
  home for the approval gate, fork-stable insertId, or partial-batch honesty; a subject-data write
  under a fail-closed default cannot be an un-governed raw egress.
- **A `host/warehouseAdapter.ts` (`ctx.warehouse.load`), mirroring `ctx.ads`:** **Rejected** — it would
  shadow destination-sync's egress ownership (ruling #3). Feature-owned verb chosen instead.
- **Reading policy directly like adsAdapter (to skip the approval-required default):** **Rejected** —
  adsAdapter does that only to avoid breaking pre-existing ad flows; a NEW write should fail closed.

## Consequences

Reverse-ETL warehouse load ships as a governed, replay-safe, PII-safe write with a fail-closed default,
under destination-sync's single ownership, reusing the broker transport and the one approvals inbox.
The single load-bearing risk (a write to a customer warehouse) is quarantined behind the separate
`bigquery-write` id **and** the `approval-required` gate. Snowflake/Redshift remain future work (a new
connection pack + a strategy branch behind the same verb); the gate + idempotency + partial-batch spine
is provider-agnostic.

## Implementation (phase → artifact)

| Piece | Artifact |
| --- | --- |
| Governed write | `features/destination-sync/warehouseLoadService.ts` (`warehouseLoad`, `evaluateWarehouseGate`, `insertRows`, `setWarehouseLoadStorage`) |
| Surface verb | `features/destination-sync/surface.ts` → `ctx.features['destination-sync'].warehouseLoad` |
| Pure row build + insertId | `features/destination-sync/destinationSyncService.ts` (`buildWarehouseRows`, `warehouseInsertId`, warehouse config + validation) |
| Approval kind | `host/approvalService.ts` (`'warehouse-load'` kind + `createWarehouseLoadApproval`) |
| Node | `packs/feature.destination-sync.nodes` → `feature.destination-sync.nodes.warehouse-load` (role `action`) |
| Boot wiring | `index.ts` → `setWarehouseLoadStorage(storage)` |
| Correction notes | ADR 0076 (separate write id, not a loosening), ADR 0266 §6 (composition superseded; approval-required default resolved) |
| Tests | `test/cdp-warehouse-load.test.ts` (gate default/approve/disabled/draft-only, host-pin + `{rows:[{insertId,json}]}` shape, deterministic insertId, partial-batch, PII, warehouse validation) + `test/cdp-bigquery-write.test.ts` (provider invariants) |

## Open questions

- [ ] Snowflake/Redshift stage+COPY behind the same verb (a strategy branch + connection packs).
- [ ] A per-tenant `warehouse.load` admin toggle in the governance UI (today it is the generic
      `actionPolicy` map; the fail-closed default already protects an unconfigured tenant).
