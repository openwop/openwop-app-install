# ADR 1124 — A request about a deleted run is over too

Status: Accepted (2026-11-15). Design reviewed by the release manager (openwop-app-14) before build.

Issue: #5933 part 2 (ISS-052, from the CasaVoga adopter): the inbox keeps approval cards for
runs that are not found, each reading "This approval couldn't be loaded".

Host notifications, storage and the inbox SPA only: no wire change, so no RFC. It completes
[ADR 1114](1114-retire-finished-requests.md), which retires a request when its step ends.

## Context — the cause, verified on main `0322673e9`

ADR 1114 D1 retires a request from one event-log subscriber, on `interrupt.resolved` and on
`run.completed` / `run.failed` / `run.cancelled`. Two kinds of rows never get that stamp:

1. **Requests whose run is deleted.** `storage.deleteRun` and `storage.pruneTerminalRuns`
   (both adapters) delete a run's `events`, `interrupts` and kv rows, but **not its
   notifications**, and they append no event. So the subscriber never fires, and the row points
   at a run that no longer exists. The callers are `DELETE /runs/:id` (any status), the run
   retention sweeper, and the channel-ingress erasure.
2. **Requests filed before ADR 1114 shipped** (#5870, 2026-11-13). The subscriber was not
   running when their runs ended. When retention later prunes those runs, the rows end up in the
   same state as (1). This is most of an adopter's backlog: #5868 measured 279 such rows on
   one production inbox.

The card made it worse. `InlineInterruptResolver` treated any failure of
`GET /host/openwop-app/runs/:runId/interrupts` as "couldn't be loaded". That route answers 404
from `loadOwnedRun`. Since [ADR 1121](1121-run-client-org-read-scope.md), a 404 can also mean
"this is a client's run you may not read". An unstamped row also stays `isActionNeeded`, so it
keeps inflating the Action needed count. `:archive-resolved` (ADR 1114 D4) already treats a
missing interrupt as over, but only when someone presses it.

## Decision

### D1 — Retire at the delete

`deleteRun` and `pruneTerminalRuns`, in both sqlite and postgres, stamp every still-open request
about the run being deleted. The stamp is `metadata.resolution = { state: 'run-deleted', at }`,
and `unread` moves to `read`. This happens in the **same transaction** as the delete (helper
`stampDeletedRunRequests`), on the ADR 1114 partial index `(tenant_id, run_id) WHERE
interrupt_id IS NOT NULL`. It follows ADR 1114 D2's row rules: stamp, never archive; leave
already-stamped and archived rows alone; never touch rows that name no interrupt.

A subscriber cannot do this, because the delete erases the event log. The storage delete is
the one choke point that every current and future deleter passes through. Tenant teardown deletes
notifications wholesale and is unaffected.

`RequestResolutionState` gains `'run-deleted'` (backend `types.ts`, SPA
`requestResolution.ts`).

### D2 — Reconcile the backlog once, by an operator

A background job, `stale-request-reconcile` (`notifications/retireRequests.ts`
`reconcileStaleRequests`), sits behind `OPENWOP_NOTIF_STALE_RECONCILE=off|report|apply`. The
default is **off**: the job rewrites notification rows on every host (openwop-dev and adopters),
which is a production data write that needs the owner's go.

- **report** decides every unstamped request row and logs counts per tenant (`resolved`,
  `runEnded`, `runDeleted`, `stillOpen`, `unexplained`; ids and counts only). It writes
  nothing, and the job stays pending.
- **apply** stamps the decidable rows through `resolveRequestNotifications`, with the same row
  rules, and marks the job complete when the scan finishes.

Each row is decided from what is still stored:

| The row's interrupt | The run | Stamp |
|---|---|---|
| resolved | any | the subscriber's own mapping of `resolvedValue` (`resolutionStateOf`), at `resolvedAt` |
| gone | gone | `run-deleted` |
| gone | terminal | `run-ended`, at the run's `updatedAt` |
| still open | — | none (it is still waiting) |
| gone | not terminal | none, counted `unexplained` |

The job pages through `listUnstampedRequestRows`, a new optional storage read on both
adapters. It is keyset on `(tenant_id, run_id, notification_id)`, the partial index's leading
columns, so no page scans the whole table. A row that gets stamped drops out of the next page's
predicate. The job is idempotent and safe to run on two instances at once.

**The operator procedure:** set `report`, read the per-tenant counts in the logs, then set
`apply` with the owner's go in that session, then unset the switch.

### D3 — The card says it cannot open the step, not why

On a 404 the card reads "This step can no longer be opened here". It does not say "no longer
waiting" or "run deleted", because under ADR 1121 a 404 may be a client-floor refusal. Any other
failure still reads `interruptLoadFailed`. A row stamped `run-deleted` shows the ending chip
"Run deleted" in place of the type and priority, and **no** "Open the run" link. All 4 locales.

## Alternatives considered

- **Retire on a failed load.** The card would call a retire endpoint when its fetch 404s.
  Rejected: that is a client-triggered write keyed on a 404 that can mean "not yours", so a
  viewer would retire rows based on their own visibility. It is also the per-card state ADR 1114
  rejected.
- **Delete the notifications with the run.** Rejected for the same reason as ADR 1114 D2: the
  person loses the record that the request existed and how it ended.
- **D2 as a silent app migration.** This was the first draft. Rejected in review: a migration
  runs on every host at boot, and this one rewrites production rows.

## Out of scope

A request can be addressed to someone who cannot read the client run it is about (ADR 1121).
Whether that person should be notified at all is a fan-out question, filed as #5951.

## Implementation record

| Piece | Where | Test |
|---|---|---|
| D1 stamp at delete and prune | `storage/sqlite/index.ts`, `storage/postgres/index.ts` `stampDeletedRunRequests` | `test/adr1124-retire-deleted-run-requests.test.ts` (D1 cases, plus HTTP `DELETE /runs`) |
| D2 job and paged read | `notifications/retireRequests.ts` `reconcileStaleRequests`; `listUnstampedRequestRows` (both adapters); `host/appMigrations.ts` `stale-request-reconcile` | same (report writes nothing; apply covers all five branches and is idempotent) |
| D3 card | `notifications/NotificationsPage.tsx`, `requestResolution.ts`, 4 locales | `notifications/__tests__/adr1124DeletedRunRequests.test.tsx` |
