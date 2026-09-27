# ADR 0372 — Anonymous-tenant lifecycle (opt-in idle teardown)

Status: implemented

## Context

Every anonymous visitor mints its own tenant (`anon:<session>`), and nothing
ever deleted one: kv business rows (~180 collections), roster entries, chat
sessions, and (until 2026-07-15) enabled scheduler jobs accumulated forever.
The 2026-07-14 incident made the cost concrete — 1,054 standing anon cron jobs
and 47k junk runs. Disabling anon-seeded schedules (PR #1842) stopped the run
flood; this ADR closes the remaining half: the abandoned tenants' data itself
(DATA-ASSESSMENT `RUNDATA-2`).

## Decision

1. **Opt-in, fail-safe default:** `OPENWOP_ANON_TENANT_RETENTION_DAYS` > 0
   enables the sweep (same doctrine as ADR 0287 — destructive ⇒ operator
   opt-in; unset/0 = off).
2. **Abandonment = no HUMAN activity past the cutoff.** Human activity is a
   non-scheduler run (`metadata.schedule` absent — the scheduler stamps every
   run it fires, spread last so other paths can't spoof it away) OR a
   chat-session update. Scheduler-fired runs never count: the 2026-07-15
   lesson is that run-recency alone misclassified all 61 flood tenants as
   active, because their own runaway crons kept their run timestamps fresh.
   A tenant with no human signal at all is abandoned once its FIRST run
   predates the cutoff.
3. **One teardown owner:** the sweep reuses the account-delete quartet
   verbatim — `deleteAllTenantData` (SQL cascade) → `clearTenantSecretCache`
   → `purgeTenantHostExt` (registry walk over every hostext collection) →
   `purgeTenantOverrides` (toggle rows are shared-keyed, unreachable by the
   tenant walk). No parallel deletion path. The route's shared-workspace
   membership cascade is deliberately NOT replicated: anon principals cannot
   join workspaces (sign-in required).
4. **Bounded + tombstoned:** max 5 teardowns per hourly tick (a teardown
   walks ~180 collections), one `governance.retention.purged` audit row per
   tenant (`feature: 'anon-tenant-lifecycle'`).
5. **Evidence surface:** `storage.listTenantActivity(prefix, limit)` (both
   adapters) returns per-tenant `firstRunAt` / `lastHumanRunAt` / `lastChatAt`
   — the discriminator lives in SQL (`metadata->>'schedule' IS NULL` /
   `json_extract(metadata,'$.schedule') IS NULL`), not in policy code.

## Alternatives weighed

- **TTL at mint time** (expire the tenant with the anon cookie): the cookie's
  lifetime is client-side; data-side evidence is the only honest signal.
- **Run-recency criterion:** rejected — the exact misclassification the
  incident demonstrated.
- **Purge on sign-in migration only:** `reassignTenant` already handles the
  anon→user upgrade path; it never fires for visitors who simply leave —
  which is the population this ADR targets.

## Known limits (stated)

- Enumeration is run-anchored: an anon tenant with chat/kv rows but ZERO runs
  is never a candidate (conservative; such tenants are small). A kv-anchored
  enumerator can extend this later.
- Candidates are capped at 500/tick per scan; a backlog larger than that
  drains across ticks.

## Phase → artifact

| Phase | Artifact |
|---|---|
| Evidence method (both adapters) | `storage/storage.ts`, `storage/{postgres,sqlite}/index.ts` (`listTenantActivity`) |
| Sweep + env gate + audit | `host/retentionSweepDaemon.ts` (`pruneAbandonedAnonTenants`) |
| Tests | `test/anon-tenant-lifecycle.test.ts` |
| Operator docs | `DEPLOY.md` § runtime knobs |

## Correction (2026-07-21, grade-pass DATA-1) — the runless-tenant blind spot

The original enumerator (`listTenantActivity`) is RUN-anchored: a tenant with
zero runs never appears, yet hostext-only anon tenants exist (e.g. the Studio's
eager Challenge Author provisioning writes roster + agent-profile rows on first
touch, ADR 0461) — they were permanently invisible to this sweep.

The correction adds a second leg, `listHostExtTenantActivity`: SQL prefilters
to the PURGEABLE keyspace (`k LIKE 'hostext:%'`, indexed) + a value LIKE; the
authoritative top-level `tenantId` extraction is one shared TS aggregator
(`storage/hostExtActivity.ts`) so the adapters cannot diverge (an
enumerator-broader-than-purge mismatch would livelock the batch — an anchored
tenant the teardown can't clear re-enumerates forever). A runless tenant is
abandoned only when BOTH its newest hostext write and newest chat touch predate
the cutoff; a run-EXISTS probe guards the 500-cap dedupe hole before any
runless teardown. Re-entrant ordering is ANCHOR-aware: run-anchored tenants
delete runs LAST (unchanged); hostext-anchored tenants purge hostext LAST.
