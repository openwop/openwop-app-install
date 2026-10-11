# ADR 0871 — Storage growth is measured hourly, and three deferred decisions have numeric triggers

Status: Accepted (implemented on this branch; production takes it on the next deploy, no env change)

Date: 2026-10-10

## Context

Three storage decisions were deferred until data justified them:

- **ADR 0868 open question 1:** a per-tenant row quota on the durable surfaces.
- **ADR 0868 open question 2:** moving `tableStorage` onto real Postgres tables with
  column indexes, for filtered queries.
- **ADR 0867 open question 2:** an approximate (HNSW) index for pgvector, which today
  ranks with an exact scan of the tenant's namespace.

"Wait for the data" had no mechanism behind it:

- `surface_scan_heavy` (ADR 0868 D4) fires only once one read passes 5000 rows or
  500 ms. **MEASURED 2026-10-10:** zero events from 02:12Z to 12:31Z in production.
  That says no read crossed the line; it cannot say how close any came, or whether
  anything is growing.
- The pgvector adapter (`host/vector/pgVectorVector.ts`) logged **nothing**: no
  query time, no row count. The HNSW question had no input at all.
- Nothing read the pgvector version. HNSW needs pgvector ≥ 0.5, and because every
  query filters by tenant and namespace, a correct HNSW needs `hnsw.iterative_scan`
  (≥ 0.8). Whether Cloud SQL offers the planned remedy was unknown.
- The vector pool had **no `statement_timeout`**, unlike the storage pool (30 s).
  Production runs that pool at 1 connection, so one slow exact scan would hold every
  vector operation. This one is a latent defect, not a measurement gap.
- No log-based metric, alert, or script read any of this back. "Re-check in a few
  days" depended on someone remembering.

## Decision

**D1 — An hourly gauge** (`host/storageGrowthGauge.ts`), run by the retention
daemon's tick under a one-row CAS lease (the `tenantIndexAdoption` pattern), so one
instance runs it per UTC hour:

- `surface_rows_gauge`, one line per durable family: `tenants`, `maxTenantRows`,
  `totalRows`, `tenantsAtOrOverTrigger`, `trigger`, `ms`. From the new optional
  `Storage.surfaceRowStats(minTenantRows)`, which groups `hostsurf:<family>:<tenant>:`
  keys in the database (Postgres `split_part`; SQLite `substr`/`instr`). The tenant
  segment is `encodeURIComponent`-encoded, so an `anon:` tenant is one tenant.
- `vector_rows_gauge` when pgvector is selected: `namespaces`, `maxNamespaceRows`,
  `totalRows`, `namespacesAtOrOverTrigger`, `dim`, `pgvector` (the extension
  version), `ms`.

No line carries a tenant id or a namespace: only aggregates leave the database.
`OPENWOP_STORAGE_GROWTH_GAUGE=false` turns it off.

**D2 — pgvector telemetry and a timeout.** A query at or over
`OPENWOP_VECTOR_QUERY_WARN_MS` (default 200) logs `vector_query_slow {ms, k,
matches}`, again with no tenant or namespace. The vector pool gets
`statement_timeout` = `OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS` (default 30000).

**D3 — The triggers, as numbers:**

| | Decision it opens | Triggered when |
|---|---|---|
| **T1** | a per-tenant row quota (ADR 0868 OQ1) | one tenant holds ≥ 100,000 rows in one family (`OPENWOP_SURFACE_ROW_TRIGGER`), or one family logs ≥ 10 `surface_scan_heavy` a day |
| **T2** | `tableStorage` on real tables (ADR 0868 OQ2) | ≥ 10 `table.query` `surface_scan_heavy` a day |
| **T3** | an HNSW index (ADR 0867 OQ2) | one (tenant, namespace) holds ≥ 50,000 vectors (`OPENWOP_VECTOR_NAMESPACE_TRIGGER`), or ≥ 20 `vector_query_slow` a day. Acting on it also needs the gauge's `pgvector` ≥ 0.8 |

A trigger opens the decision; it does not make it. Each needs its own ADR.

**D4 — The re-check is a script.** `node scripts/measure-storage-growth.mjs
[--days 7] [--json]` reads those four lines from production logs and prints CLEAR
or TRIGGERED per trigger, the per-family trend, and the pgvector version. Exit 0
all clear, 1 triggered, 2 **UNMEASURED**. No gauge line in the window is
UNMEASURED, never CLEAR: the gauge logs every hour once deployed, so an empty read
means the query or the deploy is wrong.

## Alternatives weighed

- **A Cloud Monitoring alert on `surface_scan_heavy`.** Needs a notification channel
  (whose inbox?), and alerts only at the threshold, which is the gap D1 closes.
  Deferred to the operator; a log-based metric can be built over the same lines.
- **Read the counts from Postgres directly when needed.** Needs the database DSN on
  a workstation, which this project binds only by secret reference, and still
  depends on someone remembering. The gauge runs where the credentials already are.
- **Emit the gauge per tenant.** Would put tenant ids in logs, which ADR 0868 D4
  deliberately avoided. `tenantsAtOrOverTrigger` answers the trigger question
  without naming anyone; the operator can find the tenant in the database once a
  trigger fires.
- **Add HNSW now.** Without iterative scans a filtered HNSW query can return fewer
  than `topK` rows for a small tenant in a large table, and the version on Cloud SQL
  was unknown. Exact is correct at today's size.

## Cost

The gauge is itself a scan of the `hostsurf:` range, once an hour on one instance.
**MEASURED** on real Postgres (PGlite, PG 17): 200,000 rows across 4 families and 500
tenants took 245–257 ms (a sequential scan plus an on-disk sort of 3.9 MB, since
every row is in range). It logs its own `ms`, so its cost is visible as it grows, and
the storage pool's 30 s statement timeout bounds it.

## Verification

| Check | Result |
|---|---|
| `test/adr0871-storage-growth-gauge.test.ts` (sqlite) | 4 pass: encoded `anon:` tenant counted once; totals equal `kvCount('hostsurf:')`; once per hour across two instances; no tenant id in any line; kill switch |
| `test/adr0871-pgvector-telemetry.test.ts` (mocked `pg`) | 6 pass: slow query logged without tenant/namespace; none under the threshold; pool `statement_timeout` 30000 default and override; stats probe null unless selected, including after re-registration; stats mapping |
| `test/adr0871-storage-growth-postgres-live.test.ts` (`OPENWOP_PG_TEST_DSN`, else a `pgvector/pgvector:pg15` container) | 2 pass on a PGlite socket server with pglite-pgvector **0.8.1**: `surfaceRowStats` and the vector probe on real SQL, extension version read live |
| `test/adr0871-measure-storage-growth.test.ts` | 6 pass: UNMEASURED without a gauge line; CLEAR, T1, T2, T3 at their thresholds; numeric version compare |
| Sabotage, each restored | SQLite tenant parse → 2 red; Postgres tenant parse → 1; no lease → 1; no kill switch → 1; no slow log → 1; slow log carries the tenant → 1; no `statement_timeout` → 2; probe not reset → 1; probe set without pgvector → 1; version not read → 2 |
| Script against production before deploy | `UNMEASURED`, exit 2 (the gauge is not deployed yet) |

## Open questions

1. After a week of gauge data, run the script and record the reading here.
   **First reading, 2026-10-10 (one hour of data):** CLEAR, exit 0, from
   `measure-storage-growth.mjs --days 1`. The first pass ran on 00929-vkt
   (5c9d54f5b) at 21:24:42Z. Only two families hold rows: `memory` has 9
   tenants, a largest tenant of 10 rows and 27 rows in all; `tableschema` has 1
   row. The other durable families are empty, so they log no line. The surface
   read took 4 ms. No `surface_scan_heavy` or `vector_query_slow` events. The
   week's reading is still owed (`STORAGE-GROWTH-1`, 2026-10-17).
2. Whether to build a log-based metric and alert over these lines (needs a
   notification channel the operator chooses).
3. The pgvector version on Cloud SQL, which the first `vector_rows_gauge` reports.
   If it is below 0.8, T3's remedy is a Cloud SQL upgrade before it is an index.
   **ANSWERED 2026-10-10: pgvector 0.8.5**, from the first `vector_rows_gauge`
   (21:24:42Z): 180 vectors in all, the largest (tenant, namespace) holding 6,
   read in 152 ms. 0.8.5 has HNSW and `hnsw.iterative_scan`, so when T3 fires the
   remedy is an index, with no Cloud SQL upgrade first.
