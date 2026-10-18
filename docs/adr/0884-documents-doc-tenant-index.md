# ADR 0884 — documents doc tenant index

Status: Rejected (2026-10-13; measured: the index would add database work, not save it)

Follows ADR 0866 (deploy-safe tenant-index adoption), open question 1, which listed
`documents:doc` as a next adopter "by request-path cost". It was built from the
ADR 0872 (kanban cards) template, then withdrawn before merge when production
measurements showed adoption costs more than it saves.

## Context

Every documents list scans every document of every tenant (`docs.list()` in
`features/documents/documentsService.ts`) and then filters by tenant. Two of those
reads are display-only and could move to the tenant index: `listDocuments` (the
documents route, the workflow surface's `list`, a notebook's transformations) and
`listDocumentsForTenant` (the artifact Library).

Adoption is not free. `registerTenantIndexAdoption` adds an **hourly**
`reconcileTenantIndex` pass, which does a full `list()` of the collection plus a
`kvList` of every marker, under the slot lease. That is about **720 full scans a
month** for each adopted collection, whatever the read traffic.

## Measurement (production, 30 days to 2026-10-13)

Cloud Run request logs, `openwop-app-backend`, GET only (paths are `/api/host/…`
in production, with no `/v1`, so a `/v1` filter returns 0):

| Read | Path matched | Requests |
|---|---|---|
| `listDocuments` route | `/host/openwop-app/documents/orgs/[^/]+/documents(\?\|$)` | 5 (p50 48 ms, max 69 ms, per openwop-app-38) |
| Library (`listDocumentsForTenant`) | `/host/openwop-app/artifacts(\?\|$)` | 13 (detail pages included) |
| notebook transformations | `/notebooks/[^/]+/transformations` | 0 |
| workflow surface `documents.list` | no caller in `packs/`, `examples/` or `src/` (`git grep`) | — |

About 18 request-path scans a month, each already under 70 ms, against about 720
reconcile scans. Adoption would multiply this collection's scan work roughly 40×.

Query used:

```
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="openwop-app-backend" AND httpRequest.requestMethod="GET" AND httpRequest.requestUrl=~"<path>"' --project openwop-dev --freshness 30d
```

## Decision

Do not adopt the tenant index for `documents:doc`. Its reads stay full scans.

**General rule for ADR 0866 adopters:** a collection adopts the index only when
its request-path scans clearly exceed the ~720 a month that the hourly reconcile
adds. `kanban:card` (ADR 0872) passed: the heartbeat work loop scanned every ten
minutes, and its Cloud SQL sort spills stopped when the read moved to the index.
`documents:doc` does not pass. ADR 0866's ranking was by cost per request, not by
cost times frequency, and frequency is what decides it.

## What the withdrawn implementation established

Kept here so a future adopter (if traffic changes) does not have to rediscover it:

- **Both handles need `tenantOf`.** `features/documents/erasure.ts` opens a second
  handle over `documents:doc`, and tenant teardown (`HOSTEXT_COLLECTIONS`) keeps the
  handle that registered last. An unindexed second handle would make teardown skip
  the index markers.
- **The split:** only the display reads above may move. The create cap, the
  project-owner delete cascade (`listDocumentsOwnedBy`), `clearPromotedCanvasRefs`,
  the team-ledger drift check (`producedText`), the demo seed dedupe and clear, and
  both DSAR erasure scans must stay exact (ADR 0866 D4: "the index may say yes,
  never no").
- The implementation, with a 4-test witness, passed with six sabotages each
  turning it red. It was not merged and is not kept in the repository.

## Alternatives

- **Adopt anyway, for when traffic grows.** Rejected: the cost is paid hourly from
  day one, and the trigger to revisit is measurable (below).
- **A cheaper reconcile cadence for low-traffic collections.** Out of scope here.
  It would change ADR 0866's verification window for every adopter.

## Open questions

- [ ] Revisit if the documents list or Library traffic rises above a few hundred
  requests a month, or a hot non-HTTP caller appears (for example, a workflow node
  that calls the surface's `list` in a loop). Re-run the query above.
