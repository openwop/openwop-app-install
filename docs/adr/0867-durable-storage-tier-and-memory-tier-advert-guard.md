# ADR 0867 — Durable storage tier, and no memory-tier storage advert on a scale-out host

Status: implemented (host runtime and advertise guards, merged 2026-10-09). Demo production activation is an operational gate; the rollout snapshot below remains pending as of 2026-10-09 18:52 UTC.

Date: 2026-10-09

## Context

Workflow nodes reach a tenant's storage through `ctx.storage` / `ctx.db`
(`buildHostSurfaceBundle`). Each surface resolves a backend through
`host/surfaceBackends.ts`: the default `memory` tier keeps the data inside one
process, and registered adapters keep it elsewhere: `durable` on the host Storage
(Postgres in production), `postgres` sql, `pgvector`, `s3` blob and `opensearch`.

**MEASURED 2026-10-09.** The major-2 cut of `dc929e5d1` (rev `00918-v7w`, 03:29Z)
failed `v2-storage-cross-tenant-isolation` for kvStorage: tenant A's own read
returned `[]`. Cloud Run logs for 03:29:01–13Z put the probe's write run on
instance `3b9b862d` and the read on `09ab22b0` (read by the openwop-app-98 session;
the revision env below was re-read for this ADR). kv was on the memory tier, and the service had two
instances. The other memory-tier families passed only because their write and read
happened to land on the same instance. `02c2711d4` had passed on one instance.

The certification failure was the visible half. The product half was worse: on
every deploy (several a day) and on every scale event, a user's table rows, sql
tables, vectors, queued messages, blobs and agent memories disappeared, and a
request served by a second instance never saw them. Production config at the
time, read from the revisions:

| Revision | `OPENWOP_SURFACE_*` |
|---|---|
| 00917 (`02c2711d4`), 00918 (`dc929e5d1`) | none: every surface on `memory` |
| 00919–00921 (from 03:35Z) | `OPENWOP_SURFACE_KV=durable` only |

`maxScale` is 3 and `minScale` 1.

> **Two citations this corrects.** The header of
> `test/adr0858-storage-family-backends.test.ts` says production runs
> `OPENWOP_SURFACE_BACKEND=durable`; no production revision has ever set it. And
> an in-session claim (mine) that kv was durable during the failing cut read
> TODAY's env, not the certified revision's. `OPENWOP_SURFACE_KV=durable` arrived
> six minutes after the cut. **Read the env of the revision that was certified.**

## Decision

> **SQL security correction, 2026-10-09 (integration review).** Real PostgreSQL
> probes demonstrated qualified foreign-schema reads, access to public host
> tables, and collisions between distinct tenant IDs in the inherited SQL
> adapter. `search_path` is resolution, not authorization. D1's SQL implementation
> must authenticate each operation as a restricted tenant LOGIN role, never as
> the provisioning user followed by `SET ROLE` (which SQL could reset). Role and
> schema names hash the exact tenant ID, preserving case and punctuation.
>
> The privileged provisioning pool has one connection; a process-wide semaphore
> limits tenant connections to `OPENWOP_SQL_PG_POOL_MAX - 1`. The declared total
> therefore still matches deploy Gate 5, with a minimum of two. PostgreSQL 16+
> and `max_prepared_transactions=0` are required. Tenant passwords
> derive from a dedicated stable Secret Manager binding,
> `OPENWOP_SQL_PG_ROLE_PASSWORD_KEY`, rather than the rotatable administrator DSN.
> Every authenticated tenant connection checks for unsafe foreign-schema grants
> and executable security-definer functions before accepting pack SQL. Unexpected
> role membership or elevated attributes fail closed. Provisioning is serialized
> across instances by PostgreSQL advisory locks.

> **Compatibility correction, 2026-10-09 (authenticated rollout readback).** The
> production instance is PostgreSQL 15. The minimum-version sentence above is
> superseded: PostgreSQL 15 uses a plain one-way `GRANT tenant_role TO
> CURRENT_USER`; its non-superuser provisioner must have `INHERIT` to erase
> tenant-owned objects. PostgreSQL 16+ retains explicit `INHERIT TRUE, SET TRUE`
> membership options. Tenants still receive no host membership, elevated role
> attribute, or privileged session. Unsupported provisioners fail before SQL is
> accepted. Both versions must pass the real restricted-login, cross-tenant,
> large-object and erasure matrix; PostgreSQL 15 also receives the real Linux
> normal/future-clock probes before activation. No production major-version
> upgrade is required by this adapter. `max_prepared_transactions=0` remains
> mandatory. PostgreSQL's [15 role grant](https://www.postgresql.org/docs/15/sql-grant.html)
> and [16 membership options](https://www.postgresql.org/docs/16/sql-grant.html)
> define this version-specific syntax; authentication isolation is the same.
>
> Account teardown uses the existing `registerTenantPurgeHook` composition owner,
> covering account deletion and retention. It commits NOLOGIN before terminating
> only that role's sessions and dropping its schema and owned large objects. The disabled role remains a
> tombstone so another revision cannot recreate a deleted tenant's data. Populated
> legacy `tenant_*` schemas block activation: operators must export, identify the
> exact original tenant IDs, resolve legacy collisions, and migrate under a
> maintenance hold before selecting this adapter. No automatic ownership guess,
> silent rename, or data deletion is permitted. Existing in-memory demo SQL has
> no PostgreSQL legacy schema to migrate. These are host-internal corrections to
> the existing SQL surface, with no new wire method or capability.

**D1 — Production storage is shared and durable.** Every storage family runs on a
backend that all instances share and that survives a restart:

| Surface | Backend | Store |
|---|---|---|
| kv, cache, table, queue, queueBus, search, nosql, fs, memory | `durable` | the host Storage (Postgres) |
| sql | `postgres` | a schema per tenant on the same Cloud SQL instance |
| vector | `pgvector` | `host_vectors` on the same Cloud SQL instance |
| blob | `gcs` (new, keyless) | bucket `openwop-dev-host-blob` (us-central1, uniform access, public access prevented) |
| observability | `memory` | no adapter exists; it is a logger, not storage |

`durable` sql is NOT used: it is a SQLite file on one instance's disk.

> **CORRECTED 2026-10-09, same day — blob is `gcs`, not `s3`.** The first plan
> pointed the `s3` adapter at GCS's S3-compatible API, which needs an HMAC key.
> `gcloud storage hmac create` was refused: HTTP 412, org policy
> `constraints/iam.disableServiceAccountKeyCreation`. That policy is right, so
> this ADR adds `host/blob/gcsBlob.ts` instead. It calls the GCS JSON API as the
> workload's own service account (a metadata-server token) and signs V4 URLs
> through IAM Credentials `signBlob`, so no key exists to leak or rotate. IAM
> granted for it: `roles/storage.objectAdmin` on the bucket to the runtime
> account `89896419173-compute@`, and `roles/iam.serviceAccountTokenCreator` to
> that account on itself (for `signBlob`). A dedicated service account created
> for the HMAC route was deleted unused. Live check from a workstation (my user
> token): put, read back and list passed against the real bucket, the object was
> deleted, and `signBlob` was refused for MY user (no token-creator on the
> runtime account, deliberately not granted). Signing as the runtime account is
> therefore proven only by the production boot check.

**D2 — A scale-out host never advertises a process-local storage family.**
`host/instanceTopology.ts` decides `single` or `multi`
(`OPENWOP_INSTANCE_TOPOLOGY` wins; a managed-platform marker such as `K_SERVICE`
means `multi`) and whether a surface's backend is shared (`memory` never;
`durable` only on Postgres Storage and never for sql; the network engines
always). `v2AdvertisedStorageFamilies` drops every process-local family on a
`multi` host, and `main()` logs `storage_families_withheld_process_local` with
the fix. Withholding is the honest fallback; D1 is the fix. A misconfiguration
now shows up as a family that is not advertised, not as a certification row that
passes by luck.

**D3 — A selected engine proves itself before the process listens.** `main()`
awaits `verifyPgSqlBackend` (round trip + CREATE privilege), `verifyPgVectorBackend`
(`CREATE EXTENSION IF NOT EXISTS vector`, the table, a round trip) and
`verifyS3BlobBackend` / `verifyGcsBlobBackend` (`blob/blobBootCheck.ts`: put,
read back, list, fetch through a presigned URL, delete, under a reserved tenant root),
and exits on failure. A bad DSN, missing extension, wrong bucket or credential
therefore fails the new revision's startup probe, and `update-env.sh` / `deploy.sh`
never shift traffic to it.

**D4 — The connection budget counts every pool.** The sql and pgvector adapters
each open their own `pg` pool, sized by `OPENWOP_SQL_PG_POOL_MAX` /
`OPENWOP_VECTOR_PG_POOL_MAX` (default 10, as before). `preflight-deploy.sh`
Gate 5 now sums the Storage pool plus each selected engine's pool per instance,
and prints the breakdown. Without this, selecting `sql=postgres` at the default
would have moved the steady state from 12 to 42 connections with the gate still
reading 12.

> **Session-drain correction, 2026-10-09 (live timeout probe).** A restricted
> tenant can disable its server `statement_timeout`. A 30-second driver read
> timeout followed by `client.end()` left its `pg_sleep(600)` server backend
> alive, so releasing the semaphore could exceed D4's declared budget. Each
> authenticated session now records its PID and exact server start time before
> accepting tenant SQL. Release uses the existing one-connection provisioning
> pool to terminate that specific tenant session and waits for PostgreSQL's
> positive-timeout confirmation before admitting another connection. The
> start-time, role and database checks prevent adoption of a reused PID. Concurrent
> releases share one cleanup promise. Missing administrator visibility or
> unconfirmed termination retains the slot, rejects queued and fresh admission,
> and requires a runtime restart; it never assumes the server drained. This is
> fail-closed capacity protection, not a new pool or wire method. Real PostgreSQL
> 15/16 tests use a non-superuser provisioner, disable the server deadline,
> observe the backend after the actual driver timeout, and prove its removal
> before the queued session is admitted. A revoked-membership case proves the
> failure path. [PostgreSQL's termination contract](https://www.postgresql.org/docs/15/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL)
> distinguishes signal delivery from confirmed termination with a positive timeout.

**D5 — One embedding width.** pgvector columns are fixed-width
(`OPENWOP_VECTOR_PG_DIM`). `effectiveEmbedDims()` moved from `kbService.ts` to
`aiProviders/localEmbedding.ts`, and the product index and subject memory, which
hard-coded `DEFAULT_EMBEDDING_DIMS`, now use it. Production uses 256, the existing
default, so nothing re-embeds.

> **Boot-probe corrections from integration review, 2026-10-09.** pgvector
> now reads the existing column's actual `format_type` and rejects a different
> width without altering data; `CREATE TABLE IF NOT EXISTS` alone never checked
> that. Blob boot checks use independent random fixture keys and attempt cleanup
> even when an accepted PUT loses its response. Real PostgreSQL tests cover the
> SQL restricted login and erasure with a non-superuser CREATEROLE provisioner,
> not just a fixture superuser. Large objects are included in tenant privilege
> checks and erasure because they live outside schemas.

## Alternatives weighed

- **Withhold the memory-tier families and stop.** Honest and cheap, but the data
  loss remains: nodes still write to process memory. Kept only as D2's fallback.
- **Pin `maxScale=1`.** Data is still lost on every deploy. A superseded
  revision's instance still overlaps the new one (WHD-28), and scaling is gone.
- **Blob through the S3 adapter on GCS (HMAC key).** Refused by org policy, and
  a long-lived key is the weaker design anyway. See the D1 correction.
- **ANN index on pgvector now (HNSW).** An HNSW scan post-filters by tenant, so a
  small tenant in a large table can get fewer than `topK` results, or none,
  unless iterative scans are enabled (pgvector ≥ 0.8). The adapter does an exact
  scan of one tenant's namespace through the primary-key prefix. That is correct
  first; ANN is a follow-up (open question 2). The adapter's header used to claim
  "real ANN/IVF indexing" that was never built; it is corrected.

## Rollout

Each step is an env change through `scripts/update-env.sh` (merge flags, verified
revision, traffic shifted by name), preceded by a prod hold check and followed by
a major-2 cut (`publish-evidence.sh`) that must read fail 0 / blocked 0.

| Phase | Change | Status |
|---|---|---|
| Code | D2–D5, plus the restricted-login and session-drain corrections | implemented on main `d2b8ebcd2` through #4642; production activation pending in this dated snapshot |
| 1 | `OPENWOP_SURFACE_BACKEND=durable`, `OPENWOP_SURFACE_SQL=postgres`, `OPENWOP_SQL_PG_DSN` (same secret as Storage), `OPENWOP_SQL_PG_POOL_MAX=2`, `OPENWOP_SURFACE_BLOB=memory`, `OPENWOP_SURFACE_OBSERVABILITY=memory` | pending |
| 2a | `OPENWOP_SURFACE_VECTOR=pgvector`, `OPENWOP_VECTOR_PG_DSN`, `OPENWOP_VECTOR_PG_DIM=256`, `OPENWOP_VECTOR_PG_POOL_MAX=2` | pending |
| 2b | `OPENWOP_SURFACE_BLOB=gcs`, `OPENWOP_BLOB_GCS_BUCKET=openwop-dev-host-blob` (keyless) | pending; bucket + IAM done |

Between Phase 1 and 2b, blob stays on `memory` and D2 withholds `blobStorage`
from the v2 document. Its certification row reads `inapplicable` until 2b.

Connection budget after Phase 2 (Cloud SQL `max_connections` 100): per instance
4 + 2 + 2 = 8, times maxScale 3 = 24 ≤ 97.

> **Review correction 2026-10-09 — rollout is not complete.** The preceding
> budget assumes a database limit of 100; the latest maintained deploy receipt
> instead used 25 (22 usable). Re-read the live limit before configuration:
> 24 connections does not fit a 22-connection budget. Do not increase a pool or
> replace secret/environment bindings on the strength of this planning table.
>
> **Review correction 2026-10-09 — shared SQL needs an isolation gate.**
> `sql/pgSql.ts` changes `search_path` on a connection authenticated as the
> shared application user. That selects a default schema; it does not prevent
> explicitly qualified reads of another tenant's schema or public application
> tables. Its lossy tenant-name sanitizer can also map different tenant ids to
> the same schema. The existing live test checks only an unqualified table name.
> Do not select `OPENWOP_SURFACE_SQL=postgres` for this multi-tenant production
> host until database-enforced isolation and collision-free naming are implemented
> and proven with adversarial live tests. Shared storage, pgvector and keyless
> blob may be validated independently; the SQL rollout remains unfinished.

### Implementation completion and operator-plan correction — 2026-10-09

The preceding review notes describe the defects before their corrections. The
SQL isolation and server-drain gates are now implemented and validated; the
earlier shared-login adapter is not the runtime selected for pack queries.

| Phase | Commit | Actual validation |
|---|---|---|
| Shared storage, GCS/vector boot, topology-aware adverts | Captured #4637 `2141e1fd5`, integrated through #4642 at `d2b8ebcd2` | Canonical CI and actual backend/worker Linux builds passed on the final integrated candidate `cce4a4f90`. |
| Restricted tenant SQL login and erasure | Final integrated candidate `cce4a4f90`; PostgreSQL 15 compatibility at `cb2e5515f` | Exact-head local suite: six files, 82 passes on actual PostgreSQL 15/16, pgvector and blob fixtures. Restricted-login probes exercise foreign-schema/public/role/large-object refusals and target-only erasure. |
| Confirm server drain before returning capacity | `52c7f7c8d`, merged on main through #4642 | Actual 30s driver-deadline tests on PostgreSQL 15 and 16 prove the old backend is gone before queued admission. Double release shares one completion. Unprovable drain rejects queued/fresh admission and requires runtime restart. Non-superuser provisioners are tested on both versions. |
| Linux normal and actual future clock | Immutable `cce4a4f90` / tree `5d0afd0f73beda2abff60d5ea7b5fa08e855bd2d` | Nine actual PostgreSQL 15 probes per clock, including server-timeout drain; 53 related test files and 501 tests pass under each clock, with one existing expected failure and 48 skips. |

Authenticated production readback at 18:08 UTC reported PostgreSQL 15.18,
`max_connections=100`, three reserved connections, CREATE/CREATEROLE/INHERIT,
zero prepared transactions, no legacy tenant schemas or unsafe PUBLIC grants,
and pgvector 0.8.5 available. The local operator limit was corrected from 25 to
100 without changing the database setting. These are observed prerequisites,
not a claim that the new runtime already serves production traffic.

**Operator-plan correction:** the reviewed vector pool is **1**, not the
planning table's 2. Storage 4 + SQL 2 (including its single administrator) +
vector 1 = 7 per instance; maxScale 3 gives 21 steady-state or 12 old + 21 new =
33 during the worst revision overlap, below 97 usable slots. The stable SQL
role-password key is a separate Secret Manager binding, pinned to version 1.
The source revision and reviewed incremental SQL/vector/GCS configuration deploy
atomically, with old traffic retained until the new revision is Ready and its
image-bound commit matches. All ten existing secret bindings are preserved;
the three new bindings bring the total to thirteen. No PostgreSQL major upgrade
is part of this plan.

The rollout rows are a dated pre-activation snapshot. Backend Ready/100% traffic,
frontend source/assets and a fresh signed major-2 cut with zero failures/blocked
rows remain required operational receipts before calling the demo deployment
complete. Implementation status does not stand in for those receipts.

## Open questions

1. Migrating data already in the memory tier: there is none to migrate. It is lost
   on every restart by construction, which is the defect.
2. ANN for pgvector: HNSW with `hnsw.iterative_scan`, once a tenant's namespace
   is large enough for the exact scan to matter. Not before measuring.

   > **Trigger set 2026-10-10 — ADR 0871.** "Large enough" is now a number: one
   > (tenant, namespace) with ≥ 50,000 vectors, or ≥ 20 `vector_query_slow` (a query
   > ≥ 200 ms) a day. Before this the adapter logged neither. The hourly
   > `vector_rows_gauge` also reports the pgvector version, because
   > `hnsw.iterative_scan` needs ≥ 0.8. The vector pool now has a
   > `statement_timeout` (30 s), which it lacked.
3. Durable table and vector queries scan a tenant's whole keyspace (the
   `host_ext_kv` prefix-scan class). Measure p95 after Phase 1 before calling it
   done at scale.

   > **Answered 2026-10-09 — ADR 0868.** Measured after activation: no regression
   > at today's volume (non-stream request p95 121 → 128 ms; Storage-pool waiting
   > 0.71% → 0.48%), which says nothing about scale. The code did: every durable
   > read used `kvList`, which returns the whole prefix. ADR 0868 pages those
   > reads in the database. The vector half of this question was already
   > answered: pgvector ranks inside Postgres; only the `durable` vector
   > fallback scans.

## Connection-budget correction after ADR 0904 P3 (2026-10-25)

The pgvector runner can also be opened for configured lexical maintenance and
teardown after selecting a different vector backend. Deploy Gate 5 therefore
counts that one pool when pgvector is selected OR a non-empty
`OPENWOP_VECTOR_PG_DSN` binding is configured, including a secret reference.
Selection plus configuration still counts one pool; an empty unselected DSN
opens none. The runtime pool and its cap are unchanged. Deploy-gate fixtures
cover plaintext and secret-bound configuration, the empty case, and deduplication.
