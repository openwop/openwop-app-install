# ADR 1104 — integrity gauges

Status: Accepted (2026-11-11). Implemented in `d3/integrity-gauges`.

## Context

A data assessment ends with read-only probes: "count the pages whose overlay
state differs from the base", "count the stale tutorial rows". The ADR 1038
pass left four of them (PROBE-1038-1…4 in
`docs/steward/DATA-ASSESSMENT-adr1038.md`), and every follow-up pass carried
them forward as "needs a session with DB access". A session that may not hold a
database credential cannot run them. And a probe run by hand answers for one
day; nothing says when the count turns non-zero again.

What already exists:

- The retention daemon's tick runs in production (its default TTLs are on) and
  already hosts one read-only observer, the ADR 0871 storage-growth gauge, under
  a kv CAS lease so one instance runs it per period. Its log lines are read back
  with `gcloud logging read` (measured 2026-11-11: `surface_rows_gauge` from
  revision `01198-qhh`).
- `listAllSystemRows(typeName)` (`features/entities/entitiesService.ts`) reads
  one system type across all tenants, for backfills.
- Features push into core through registries (`registerRetentionPurger`,
  `registerKvAgeOut`); no registry exists for a read-only periodic check.

## Decision

1. **D1 — a host registry, `host/integrityGauges.ts`.** A feature registers a
   named gauge, `registerIntegrityGauge(name, run)`, where `run` returns
   aggregate counts. Feature → core only; the host imports no feature.
2. **D2 — once per UTC day, from the existing tick.** `runIntegrityGaugesOnce`
   runs right after the storage gauge in the retention tick, under one kv lease
   (`integrity-gauges:day`), so a fleet runs each gauge once a day.
   `OPENWOP_INTEGRITY_GAUGES=false` turns it off.
3. **D3 — numbers only.** Each gauge logs one `integrity_gauge` line with
   `gauge`, its counts and `ms`. The host drops any non-numeric value, so no line
   can carry a tenant id, a page id or content. A gauge that throws logs
   `integrity_gauge_failed` and the others still run.
4. **D4 — the first two gauges.**
   - `cms` (`features/cms/integrityGauge.ts`): PROBE-1038-1 `staleItemOverlays`
     (an overlay whose list items carry presentation keys that differ from the
     base; the test is "would `restoreItemStates` change it", the same function
     every write lane applies), PROBE-1038-2 `dormantHeroFlows`, PROBE-1038-3
     `oversizedFlowOverlays`, plus `pages`, `sections`, `tenants`.
   - `tutorials` (`tutorialsService.ts` `tutorialIntegrityGauge`): PROBE-1038-4
     `staleSeedCopies` and `tenantsWithStale` (the rows the readers yield to the
     shipped seed since TUT-STALE-1), plus `customizedBehind`, `tenantAuthored`.

5. **D5 — a per-tenant row cap** (release-manager review, 2026-11-11). A gauge
   reads at most `INTEGRITY_GAUGE_ROW_CAP` (10,000) rows of a type per tenant,
   through `DurableCollection.listByPrefixUpTo` (`kvListPage`, `limit + 1` keys,
   so a huge tenant is never loaded whole), and logs `truncatedTenants`; when it
   is above 0 every count is a floor. Lines stay numbers-only, so "truncated" is a
   count, not a boolean. The cap bounds memory per tenant; the number of tenants
   is still unbounded.

No wire change, no new store or table, no RFC. The kv lease is one row.

## Alternatives

- **A feature-owned timer per gauge** (the `startCmsPublishSweep` shape): each
  feature would copy the storage gauge's private lease, two copies that drift.
- **A superadmin route:** needs a signed-in superadmin to call it, so a probe
  still cannot run unattended.
- **Run the probes by hand with a database credential:** excluded for agent
  sessions, and it answers for one day only.
- **A metric per probe:** the ADR 0556 catalog forbids tenant-shaped labels, and
  a daily count is a log line's job; `openwop.tutorials.stale_seed_served`
  (TUT-OBS-1) already counts the serving side of PROBE-1038-4.

## Trade-offs

- A run loads up to 10,000 rows of one type per tenant into memory once a day
  (D5). At today's scale (every surface family under 100 rows per tenant, ADR 0871
  gauge) that is small; `truncatedTenants` and ADR 0871's triggers are where
  growth shows.
- The day's lease is claimed before the gauges run, so an instance stopped
  mid-run skips that day's lines; the next day runs again. A missing day is
  visible (no line), never a wrong count.
- The "feature registers its gauge" witness is a source check, not a booted
  feature: booting the CMS feature in a unit test costs more than it proves, and
  deleting the call still turns the check red.
- A count is a symptom, not the row. When one turns non-zero, the next step is a
  targeted look, which still needs a person or a scoped tool.

## Implementation

| Phase | What | Where |
|---|---|---|
| P1 | Registry, daily run, numbers-only line | `src/host/integrityGauges.ts`, `retentionSweepDaemon.ts` |
| P1 | CMS gauge (PROBE-1038-1…3) | `src/features/cms/integrityGauge.ts`, `cmsService.ts` `listAllPagesForIntegrityGauge` |
| P1 | Tutorials gauge (PROBE-1038-4) | `tutorialsService.ts` `tutorialIntegrityGauge` |
| P1 | Per-tenant cap (D5) | `hostExtPersistence.ts` `listByPrefixUpTo`, `entitiesService.ts` `listAllSystemRowsBounded` |
| P1 | Tests | `test/adr1104-integrity-gauges.test.ts`, `test/tutorials-service.test.ts` |

Read the counts after a deploy:

```bash
gcloud logging read 'resource.labels.service_name="openwop-app-backend" AND jsonPayload.msg="integrity_gauge"' \
  --project openwop-dev --freshness=2d --limit=10 --format=json
```
