# ADR 0380 — Size-retention TTL hygiene: the idempotency cache + append-only KV stores

Status: Accepted — implemented (all phases, one PR)

Date: 2026-07-16
Lane: cross-cutting seam (storage hygiene) — no new feature package, no toggle
RFC verdict: **host work only.** TTL expiry of a host-side HTTP dedupe cache and
host-ext KV rows touches nothing normative.

## Why (evidence — live prod probe session, 2026-07-16)

DATA-ASSESSMENT named a retention program the next scoped effort; the probe
session made it evidence-based rather than estimated:
- The **`idempotency` table** ("Layer-1 HTTP idempotency key cache",
  `postgres/schema.ts:121`) has **no TTL anywhere in code**: 40,738 rows at
  ~5.8k/day (the table is ~5 weeks old; the 72 rows >30d are the leading edge,
  not a cleaner) → ~2M rows/yr unchecked on a db-f1-micro.
- **`agent_run_activity`** carries **24 orphans** of runs swept before the
  deleteRun cascade (`postgres/index.ts:967`) landed — bounded pre-cascade
  residue, not a live leak.
- The good news the probes confirmed: `runartifact` (49% of host_ext_kv) is
  fully retention-covered (0 orphans — the ADR 0371 cascade holds) and `events`
  is SHRINKING under 0371 (457k → 379k).
- The watchlist KV stores (billing checkout/webhook-event, commerce order-idem,
  invites, engagement tokens, cdp-sync history) are small today (≤1k rows each)
  but append-only and unbounded.

## Decisions

### 1. Idempotency cache TTL — default ON, 7 days
`OPENWOP_IDEMPOTENCY_TTL_DAYS` (default **7**; `0` disables). **Deliberately
unlike ADR 0371's OFF-default**: 0371 guards user data (runs), where retention
is a policy choice; this is an HTTP dedupe **cache** — a cache without expiry
is a defect (Stripe's idempotency window is 24h; 7 days is generous).
Mechanism: a batched `deleteIdempotencyBefore(cutoffIso, limit)` on BOTH
storage adapters (keyed-subselect delete; sqlite parity per the adapter
discipline), invoked on the **existing ADR 0371 retention daemon tick** — the
ONE daemon, never a second timer. **No index migration**: steady-state is
≈ TTL × daily-rate ≈ 40k rows, a seqscan slice per tick is fine; the revisit
trigger is a sustained steady-state ≥500k rows (then add a `created_at` btree).
**Correctness stance:** a client retry AFTER the TTL re-executes the request —
acceptable and standard for HTTP-layer dedupe; the engine-side
`invocation_log` (Layer-2, replay-relevant) is untouched and already rides
`deleteRun`.

### 2. One-shot orphan backfill (APP_MIGRATION v3)
Delete `agent_run_activity` rows whose run no longer exists (the 24
pre-cascade orphans). Idempotent, concurrency-safe (a plain guarded DELETE),
prevents every future audit from re-flagging known residue.

### 3. The generic KV age-out seam — size hygiene, not governance
`registerKvAgeOut({ id, prefix, ttlDays, timestampField })`
(`host/kvAgeOut.ts`): owning features register their append-only stores; the
0371 tick sweeps each — prefix scan (demo-scale stance; stores ≤1k rows),
parse `timestampField` from the row JSON, delete rows older than `ttlDays`,
**fail-open per store** (one bad registration logs and never stops the tick).
**The boundary vs `registerRetentionPurger`:** that seam is per-tenant
GOVERNANCE/PII deletion driven by classification policy; this seam is global
SIZE hygiene driven by store semantics. Two mechanisms, two purposes, one tick.
Registrations shipping now (clear semantics + usable timestamps):
- ~~`billing:webhook-event` — processedAt, 90d~~ **Correction (review, 2026-07-16):
  DROPPED.** PR #1940 (a parallel session, merged mid-implementation) documents
  this ledger as deliberately never-purged: it is a money-critical dedup ledger —
  purging a marker lets a re-delivered Stripe event RE-PROCESS (double-apply a
  top-up/plan change), and while Stripe's own retries are ~72h, manual/replayed
  deliveries are unbounded. The dedup guarantee overrides the size argument
  (rows are tiny). The exclusion is recorded at the store's declaration.
- `billing:checkout` — createdAt, 30d (session pointers; Stripe expires in ~24h)
- `commerce:order-idem` — at, 30d (the GEN-2d residue, named by that audit)

**Correction (review, 2026-07-16) — composition with PR #1940:** #1940
independently registered `billing:checkout` + `commerce:order-idem` under
`registerRetentionPurger`'s opt-in `retention.internalDays` window. Both lanes
are KEPT, cross-referenced at each store: the governance purge is per-tenant,
admin-tunable, and dormant until an operator enables the sweep (it is OFF in
prod — the probe-confirmed growth would continue under it alone); this ADR's
kvAgeOut is the global default-on backstop. Deletes compose idempotently. This
is the §3 boundary working as designed — two lanes, two purposes, one tick —
now exercised on the same stores.
Documented follow-ons for their owners (each a semantics decision, not
mechanics): identity invites (survive-until-accepted?), MKT engagement tokens,
cdp:destination-sync history, expired devkeys.

## Phased plan → as-built
| Phase | Scope | As-built |
|---|---|---|
| 1 | idempotency TTL + daemon hook + env | **Correction:** no new storage method — the EXISTING `pruneIdempotencyByPrefix('', cutoff)` (both adapters, LIKE + created_at) IS the global TTL delete; `idempotencyTtlDays()` + tick hook in `retentionSweepDaemon.ts`; boot gate in `index.ts` widened to start the loop when only the TTL is live |
| 2 | APP_MIGRATION v3 orphan backfill | `deleteOrphanAgentRunActivity()` on pg + sqlite; migration `delete-orphan-agent-run-activity` |
| 3 | `registerKvAgeOut` seam + 3 registrations | `host/kvAgeOut.ts` (fail-open per store, 1000/store/tick cap, skip-on-unparseable); registrations in `billingService.ts` + `commerceService.ts` |
| 4 | Tests + trackers | `test/size-retention-ttl.test.ts` (8: env, global-prune cutoff, seam sweep/skip/fail-open, orphan idempotency); DATA-ASSESSMENT changelog |

## Alternatives weighed
- A second daemon/cron for TTLs — rejected (the ONE-daemon rule; 0371's tick
  exists and is idle-cheap).
- Indexing `created_at` up front — rejected at current scale (steady-state
  small once swept; a migration for a seqscan we don't need).
- Registering ALL watchlist stores now — rejected: invites/tokens have
  survive-conditions their owners must rule on; forcing a TTL is a data-loss
  foot-gun. The seam makes each follow-on a one-liner.
