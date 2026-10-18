# ADR 0872 — kanban card tenant index

Status: implemented

Follows ADR 0866 (deploy-safe tenant-index adoption), open question 1.

## Context

Every kanban card read that a person or agent triggers scans **every card of
every tenant** (`cards.list()` in `host/kanbanService.ts`):

- `listCards(boardId)`: opening a board, the board API (`routes/kanban.ts`), the
  board surface, the heartbeat work loop, work-selection, voice preamble, MCP.
- `listBoardsWithCards(tenantId)`: the dashboard.
- `listCardsAssignedToUser`: the personal "assigned to me" board.
- `createCard` and the card patch command: each lists every card to find a
  column's siblings, for ordering.

The inventory in ADR 0866 ranked kanban cards ahead of `users:user`. That store's
hot path (`getUserByPrincipal`) is already a point read of a derived id, and it
scans only on a miss, where an index cannot be trusted anyway.

Cards cannot adopt the ADR 0866 index as-is. **A card row carries no
`tenantId`**: its tenant is its board's. `tenantOf` must be computed from the
row alone, synchronously.

## Decision

### D1 — stamp `tenantId` on every card write

`KanbanCard` gains `tenantId?: string`, always its board's tenant. Every write
path sets it from the board it already holds:

- `createCard` (reads the board; a card for a board that does not exist is now
  refused: `kanban_board_not_found`);
- the card patch command (CAS);
- the DSAR eraser;
- the workflow-fork repoint.

`tenantOf` is `(c) => c.tenantId ?? ''`. A write of an unstamped card still
throws in `put` (FU-DATA-4: a write must not mint an `undefined` slice), so a
write path that forgets to stamp fails loud in tests.

Side effect: the generic teardown (`purgeTenantRows`, `countRowsFor`) and the
GEN-1b fold now see cards by their `tenantId` content field, as they do every
other tenant-scoped row. `purgeTenantKanban`'s board cascade still runs first.

### D2 — stamp legacy rows before each reconcile

`registerTenantIndexAdoption` takes an optional `beforeReconcile` hook, run
under the same hourly slot lease, immediately before the reconcile pass.
Kanban's hook lists the unstamped cards, joins them to their boards, and stamps
each with a compare-and-swap (a concurrent edit wins; the next hour retries).

This one mechanism covers both legacy rows and rows that a superseded
pre-stamp revision writes during a deploy overlap. No migration is needed.

A card whose board no longer exists (an orphan) cannot be stamped. The hook
counts it and logs `kanban_card_unstamped_orphans`. It does not delete it:
deleting rows from an hourly daemon on an inference is not this ADR's call.

### D3 — an unindexable row blocks verification (generic)

Today `reconcileTenantIndex` counts a row whose `tenantOf` is empty as
`skipped`, and verification ignores it. For a collection where that can happen,
such a row is invisible to every indexed read while the index says it is
verified. So:

- a pass with `skipped > 0` restarts the window (a writer that does not stamp
  may still be live), so it never verifies, and it resets a verified index
  (logged as `tenant_index_unindexed_writer` with `skipped`, like a repair);
- `ensureTenantIndex` (the one-time backfill) and `compareAndSwap`'s failed-swap
  marker repair skip a row with an empty tenant instead of throwing.

The existing adopters (`connections:connection`, `access-members`) always have a
tenant. Production reports `skipped 0` on every pass, so this changes nothing
for them.

Consequence: one orphan card keeps the kanban index unverified, and every read
stays on today's full scan. That is the safe failure. The log line names it.

### D4 — which reads move

"The index may say yes, never no" (ADR 0866 D4). A read moves only if a missed
card costs a delay, not a wrong decision:

| Read | Moves? | Why |
|---|---|---|
| `listCards` (board view, work loop, surfaces) | yes | a missed card shows or is picked after the next hourly repair |
| `listBoardsWithCards`, `listCardsAssignedToUser` | yes | display |
| sibling order in `createCard` and the patch command | yes | a miss can only give a duplicate `order`, which sorts stably |
| job-search provisioning dedupe | no: `listCardsExact` | a miss creates a duplicate card |
| priority-matrix idea caps | no: `listCardsExact` | a miss undercounts the cap |
| workflow-fork repoint | no: `listCardsExact` | a miss leaves a card on the old workflow |
| `deleteBoard`, `purgeTenantKanban`, `eraseSubjectKanban` | no | teardown and erasure need completeness |

An indexed read returns `null` (and the caller scans) when the index is not
verified or the indexed read throws.

## Alternatives

- **Index by `boardId` as the partition key.** Gives `listCards` an exact
  slice, but the persistence layer treats the partition as a tenant: teardown,
  `countRowsFor`, and the GEN-1b fold would misread a board id as a tenant.
  Rejected.
- **A one-time migration to stamp legacy rows.** Misses rows the old revision
  writes during the deploy overlap, after the migration ran. D2's hourly hook
  covers both. Rejected.
- **Delete orphan cards in the hook.** Rejected for now (see D2). If production
  shows orphans block verification, decide then.

## Implementation

| Part | Where | Witness |
|---|---|---|
| D1, D2, D4 | `host/kanbanService.ts`, priority-matrix, job-search | `test/kanban-card-index-adoption.test.ts` (5 tests) |
| D2 hook | `host/tenantIndexAdoption.ts` | `test/hostext-tenant-index-adoption.test.ts` "beforeReconcile" |
| D3 | `host/hostExtPersistence.ts` | same file, the two "ADR 0872 D3" tests |

Sabotage, each run separately: dropping the `skipped` branch reds both kanban D3
tests; dropping the hook reds D2; dropping the stamp in the patch command reds
D1; pointing `listCardsExact` at the index reds D4; dropping the backfill skip
or the CAS-repair guard reds its generic test.

Not moved: `deleteBoard` and `purgeTenantKanban` still scan once per board.
Teardown is rare and completeness wins (ADR 0284).

### Production record

| Step | When (UTC) | Evidence |
|---|---|---|
| Merged | 2026-10-10 | PR #4682, `472ff4697` (train tip `4001514ae`) |
| Deployed | 2026-10-10 21:11Z | rev `00930-d8t`, both halves verified at `4001514ae` |
| Verified | 2026-10-11 01:19:35Z | `tenant_index_verified collection=kanban:card repaired=0 skipped=0` on `00932-w92` |
| Held | 2026-10-11 21:11Z → 2026-10-12 00:11Z | every hourly pass on `00933-ppj` (v0.4.0): `tenant_index_reconciled verified=true repaired=0 skipped=0` |

`kanban_card_unstamped_orphans` and `tenant_index_unindexed_writer` never
appeared in the three days after the deploy (log query over 3 days; the same
query finds the `tenant_index_verified` lines above, so it can match).

A side effect it predicted came true. Between the first pass and verification,
the heartbeat's `listCards` full scan spilled a ~5.19 MB sort to disk on Cloud
SQL about ten times every ten minutes, because D1's stamp made each row larger.
The spills stopped at 01:21Z, two minutes after verification, when the read
moved to the index. Measure such spills by size bucket, not exact size: the sort
grew from 5,185,536 B to 5,193,728 B during the window.

## Open questions

- [x] Orphan cards in production: after deploy, read `kanban_card_unstamped_orphans`.
  If it is non-zero, kanban never verifies; decide deletion then.
  **Closed 2026-10-12:** zero orphans logged and the index verified (see the
  production record), so no deletion decision is needed.
