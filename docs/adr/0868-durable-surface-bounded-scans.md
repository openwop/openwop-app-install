# ADR 0868 — Durable surfaces read a page, not a whole key range

Status: Accepted (implemented on this branch; production takes it on the next deploy, no env change)

Date: 2026-10-09

## Context

ADR 0867 put production's storage surfaces on the `durable` backend: rows in
`host_ext_kv` on Cloud SQL, shared by every instance. Its open question 3 asked
whether durable table and vector reads scale, because they "scan a tenant's whole
keyspace".

**MEASURED 2026-10-09 (21:15Z),** revision `00923-9dx` (memory tier, 16:00–19:30Z)
against `00924-w5c` (durable, 19:40–21:15Z), from request logs with event streams
excluded (Cloud Run's `request_latencies` p95 is dominated by hour-long SSE
streams, about 3.8M ms, and cannot answer this):

| | 00923 (memory) | 00924 (durable) |
|---|---|---|
| request p95, non-stream | 121 ms | 128 ms |
| `POST /runs` p95 | 142 ms | 176 ms |
| Storage-pool samples with a waiter | 0.71% (81 / 11,476) | 0.48% (38 / 7,907) |
| Cloud SQL backends, steady | 6 | 7 (peak 12 in the deploy overlap) |

No regression at today's volume. That is not evidence at scale: tenants hold a few
rows each. Reading the code answers the scale question without waiting for one:

- Every durable surface read through `Storage.kvList(prefix)`, which returns
  **every row under the prefix, values included**.
- **Queue receive** (`claimHead`) loaded the whole queue to take its head: the
  hot path cost grew with queue depth.
- **Table query** loaded and parsed the whole table, then filtered, sorted and
  paged in memory: `limit: 1` cost the whole table and paging through it was
  quadratic. **`count`** loaded every value to count keys. No limit meant
  `Number.MAX_SAFE_INTEGER`.
- **kv `list(prefix)`** read the tenant's whole kv keyspace, then filtered by
  the caller's prefix in JS.
- **Account purge** (`purgeTenantDurableSurfaces`) read every `hostsurf:` row of
  **every tenant** to find one tenant's. The operator **DLQ snapshot** read every
  tenant's bus even when asked for one tenant.
- fs `stat` read a directory's whole subtree to answer "has a child".

All of it runs on the 4-connection Storage pool the daemons share, so one tenant's
large table slowed everyone — the `host_ext_kv` prefix-scan incident shape.

pgvector is not affected: it ranks inside Postgres
(`WHERE tenant AND namespace ORDER BY <=> LIMIT k` on the primary-key prefix).

## Decision

**D1 — Two optional `Storage` reads.** `kvListPage(prefix, {after, limit})`
returns at most `limit` rows with key > `after`, in **UTF-8 byte order**;
`kvCount(prefix)` counts in the database. Optional, like `kvListContaining`:
`durableStore` falls back to `kvList` (complete, unbounded) for a backend
without them.

- **Postgres:** `k LIKE $1 AND k ~>~ $2 ORDER BY k USING ~<~ LIMIT $3`. The
  `~…~` operators are the `text_pattern_ops` (byte-order) family, so the planner
  uses the existing `host_ext_kv_k_pattern` index for an ordered range scan that
  stops at the page. No schema change. Byte order is collation-independent, so a
  database on `en_US.UTF-8` pages the same as one on `C`.
- **SQLite:** a byte-order range, `k >= prefix AND k > after AND k < upper`, with
  `upper` = the prefix's last code point plus one (`prefixUpperBound`). Not LIKE:
  SQLite's LIKE is case-insensitive for ASCII, so `kvList('a:')` also returns
  `A:` keys (an existing superset, left alone in `kvList`; durable reads no longer
  use it).

**D2 — Durable adapters read through three helpers** in `durableStore.ts`:
`listPage`, `scanPrefix` (an async iterator over pages of 500, which stops
reading when the caller stops) and `countPrefix`. A ratchet test fails if any
other file in `host/durable/` calls `kvList`.

| Read | Before | After |
|---|---|---|
| table `query({limit})`, no filter | whole table | `limit + 1` rows |
| table `query`, filtered | whole table | pages of 500 until the page fills |
| table `count` | every row and value | `count(*)`, no rows |
| queue `dequeue`, bus `consume` | whole queue | a page of 8 (more only if peers won the claims) |
| kv `list(prefix)` | tenant's whole kv keyspace | that prefix only |
| fs `stat` (directory) | whole subtree | 1 row |
| account purge | every tenant's `hostsurf:` rows | skip-scan: 1 row per family, then the tenant's range |
| DLQ snapshot for a tenant | every tenant's bus | that tenant's bus |

The purge discovers families from the data (read the first key after the last
family, purge `hostsurf:<family>:<tenant>:`, jump to `hostsurf:<family>;`), so a
family added later is purged without editing a list.

**D3 — A table page is capped.** `tableQueryLimit` clamps `limit` (absent or
larger) to `OPENWOP_TABLE_QUERY_MAX_LIMIT` (default 1000), and the caller pages
on with `nextCursor` (RFC 0016 §B point 3). The in-memory table uses the same cap,
and both now order ids by **byte order**. The in-memory table used to sort with
`localeCompare` but compare its cursor with `<=`, two different orders, so a
mixed-case table could skip or repeat rows across pages; the durable table had the
same split.

**D4 — Telemetry.** `surface_scan_heavy` (`{op, family, rows, ms}`, no tenant id)
fires once per logical read that pulls ≥ `OPENWOP_SURFACE_SCAN_WARN_ROWS` (5000)
rows or takes ≥ `OPENWOP_SURFACE_SCAN_WARN_MS` (500 ms). It is the production
signal for the reads that still need a whole range: a selective filtered table
query, an fs listing, and durable vector / search / nosql (which rank or match
every row; production's vector backend is pgvector).

## Alternatives weighed

- **Benchmark only.** Today's data is too small to show the cost, and the code
  already shows where it is. A row-count test is reproducible on every run; a
  timing is not.
- **Map `tableStorage` onto real Postgres tables (the ADR 0867 sql adapter).**
  Real per-column indexes for filtered queries, but a schema-design decision and
  a migration. Not justified until `surface_scan_heavy` shows filtered queries on
  large tables.
- **A new `(k COLLATE "C")` index.** Unneeded: the existing `text_pattern_ops`
  index already serves byte-order range scans through the `~…~` operators.
- **A per-tenant row cap with a typed error** (proposed in the recommendation).
  Deferred: the page cap bounds what one call reads, which is the pool-starvation
  risk; a quota is a product limit that needs a number someone chooses, and D4
  supplies the data to choose it.

## Verification

| Check | Result |
|---|---|
| `test/adr0868-durable-bounded-scans.test.ts` (sqlite storage, counted rows) | 18 pass |
| `test/adr0868-kv-page-postgres-live.test.ts` (real Postgres: `OPENWOP_PG_TEST_DSN`, else a `postgres:15-alpine` container) | 3 pass against a PGlite socket server; the full migration set ran on it |
| Plan on real Postgres: EXPLAIN ANALYZE of a 10-row page over a 5000-row prefix | `Limit → Index Scan using host_ext_kv_k_pattern`, actual rows **10** |
| Sabotage, each restored | claim page unbounded → 2 red; table reads all → 4 red; kv list tenant-wide → 1; purge global → 1; sqlite page via LIKE → 1; DLQ snapshot global → 1; telemetry removed → 1; count via kvList → 1; in-memory `localeCompare` → 1; Postgres inclusive cursor (`~>=~`) → 3; a `kvList` call added to `durableFs.ts` → ratchet red |
| Related suites (durable*, storage-*, adr0858*, adr0867*, operations*, teardown*, destructive*, account*) | 46 files pass, 2 live-only skipped |

## Open questions

1. A per-tenant row quota (see Alternatives) — decide from `surface_scan_heavy`
   data, not before.
2. Filtered table queries on large tables — if D4 reports them, move
   `tableStorage` to real tables with column indexes.
3. ADR 0867's HNSW question is unchanged: pgvector's exact scan runs in the
   database and is not part of this.
