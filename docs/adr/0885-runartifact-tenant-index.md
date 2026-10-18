# ADR 0885 — runartifact tenant index

Status: Rejected (2026-10-13) — measured before implementation: the index would add database work, not remove it

## Context

ADR 0866 lets a `DurableCollection` that reads with `list()` plus a tenant
filter move those reads to a tenant index, once an hourly reconcile has
verified the index. Its open question lists the next adopters "by request-path
cost (inventory 2026-10-10)", and `runartifact` is on that list.

`runartifact` (`host/runArtifactStore.ts`) has one tenant-wide scan:
`listRunArtifactsForTenant`. Its only caller is the artifact Library
(`host/artifactProjection.ts` `listArtifacts`, served by
`GET /host/openwop-app/artifacts`). Every other read is a point read or the
per-run prefix read `listRunArtifactsForRun`, which needs no index.

## Decision

**Rejected. Do not adopt the tenant index for `runartifact`.**

Adoption does not remove the full scan. It moves it from the request path to
the hourly reconcile (`reconcileTenantIndexesOnce`), which lists the whole
collection plus every marker on **every** pass, including after the index is
verified. So adoption pays off only when the tenant-wide read runs more often
than the reconcile.

Measured on 2026-10-13 (production, Cloud Run request logs, 30 days):

| What | Count | Latency |
|---|---|---|
| `GET /api/host/openwop-app/artifacts` (the Library list) | 7 | 15 ms, 107 ms, 0.9 s, 1.1 s, 1.2 s, 1.9 s, 27.3 s |
| reconcile passes the index would add | ~720 (one per hour) | each a full `list()` of the collection |

The reconcile runs hourly whether or not the index is verified. The
production log shows `tenant_index_reconciled` for every adopted collection on
each hourly tick, with `verified: true`. The index would replace about 7 full
scans a month with about 720. That is roughly 100 times more work.

A second cost: the run cascades delete artifact rows with raw SQL beneath the
collection (`deleteRun` and `pruneTerminalRuns` in both storage adapters,
`DELETE FROM host_ext_kv WHERE k LIKE 'hostext:runartifact:<runId>:%'`). They
would leave every marker behind. A marker whose row is gone is harmless
to a read (it is skipped and removed), but retention prunes runs continuously,
so markers would pile up until their tenant's Library is opened. Adoption
would also need the cascades to delete
`hostextidx:runartifact:<tenantId>:<runId>:%`. That is fixable, but it is
not worth fixing for a read that runs seven times a month.

## Alternatives

- **Adopt anyway, for the Library's latency.** The 1–27 s responses are real,
  but they are rare, and the index would not fix them cheaply: the hourly
  scans would cost more database time than the Library spends in a month.
  Rejected.
- **Throttle the reconcile for low-traffic collections (e.g. daily).** That
  would change ADR 0866's verification window and its rollback detection for
  every adopter. It is a separate decision with its own risks. Not taken
  here.
- **Fix the Library's latency without a tenant index.** See the open
  question.

## Open questions

- [ ] The Library list is slow when it runs (0.9–27 s). If that matters, the
  likely fixes do not involve a whole-collection scan: an index projection
  (`indexProjection`, GC-CV-11) so the list does not read the 1 MB bodies, or
  a per-tenant paged read. Measure what the time is spent on before choosing.
- [ ] The same arithmetic applies to every ADR 0866 adopter: compare the
  request-path scans saved with the 720 reconciles a month. The ADR 0866
  inventory ranked candidates by cost per request, not by frequency.
  `documents:doc` (rejected the same day in its own ADR, on the same grounds) measured 5 list requests in 30 days
  (p50 48 ms), plus the same 7 Library reads.

## How this was measured

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="openwop-app-backend"
  AND httpRequest.requestMethod="GET" AND httpRequest.requestUrl:"/host/openwop-app/artifacts"' \
  --project openwop-dev --freshness 30d --format='value(timestamp,httpRequest.latency,httpRequest.requestUrl)'
gcloud logging read '... AND "tenant_index_reconciled"' --project openwop-dev --freshness 4h
```

A list call is a URL whose path ends in `/artifacts`. Count them by URL, not
with a regex filter: the regex filter tried first also matched
`…/artifacts/<id>/revisions` reads (20–40 ms, not tenant-wide scans) and gave
6 list calls instead of 7.

Production paths are `/api/host/…` with no `/v1`. A filter on
`/v1/host/openwop-app/artifacts` returns nothing, with exit 0. The first query
here did exactly that, and a looser filter found the real path.
