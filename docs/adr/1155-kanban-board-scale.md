# ADR 1155 — Kanban boards with thousands of cards

Status: Accepted (2026-11-22). Phases ship as separate PRs: P1 (D6) in #6190, P2 (D1) in #6191; P3–P6 open. Requested by CasaVoga (CV-0243, relayed by casavoga-c9 and openwop-app-14). Host-only; no wire RFC (see D7).

Extends [ADR 0738](0738-kanban-core-work-item-execution.md) (the board command boundary), [ADR 0049](0049-kanban-card-assignment-to-people.md) (assignment and the "Assigned to me" mirror), [ADR 0872](0872-kanban-card-tenant-index.md) (the card tenant index), [ADR 1137](1137-kanban-work-item-assignee.md) (work items carry an assignee) and [ADR 1138](1138-kanban-due-reminders-and-mirror-actions.md) (due reminders). It follows [ADR 0868](0868-durable-surface-bounded-scans.md): read a page, not a whole key range.

## Context

CasaVoga's CV-0243 puts every project decision on one kanban board. A board holds about 1,500–6,000 cards, and a tenant's "Assigned to me" view spans about 25,000. CasaVoga's provisional targets: a filtered page in under about 500 ms at those sizes, a 6,000-card create that can resume in batches, and a 2,000-card re-date in one request or a few. CasaVoga's 6,000-card test has not run yet, so every number below is provisional until it does.

> **CORRECTED 2026-11-22 (casavoga-c9): the volume is larger.** A project board holds about **15,000** cards, not 1,500–6,000: a 30-room house, with selections decided per room. A tenant holds several boards, so a tenant can reach **50,000+** cards. The numbers in D2, D3 and P6 below were sized for the smaller figure. D2 is revised for this volume (see the correction note there). The rest of this record stands as written.

Four things are missing. Each was checked against `origin/main` (`249117305e`):

1. **No bulk create or bulk re-date.** `materializeWorkItems` (ADR 0738, through `ctx.kanban`) is idempotent by source and key, and with `refresh: true` re-dates source-owned facts (ADR 1137 D3). But it takes at most 100 items, it writes a work item, an audit row and an outbox row for each card, and it is reachable only from a workflow. A card by HTTP is one `POST /boards/:id/cards` per card, and a re-date is one `PATCH /cards/:id` per card.
2. **Every board read returns every card, and costs one point read per tenant card.**
   - `GET /boards/:id` (`routes/kanban.ts:437`) calls `listCards`, which calls `cardsOnBoards` (`host/kanbanService.ts:744`).
   - That calls `cards.listForTenantIndexed(tenantId)` (`host/hostExtPersistence.ts:807`): one `kvList` of the tenant's index markers, then **one sequential `get` per marker**. It then filters to the board in memory.
   - So one board read on a tenant with 25,000 cards makes 25,000 sequential reads, against a 4-connection pool. If the index is not verified, it falls back to `cards.list()`, the whole table across every tenant.
   - `GET /kanban/assigned` (`:410`) calls `listCardsAssignedToUser` (`kanbanService.ts:2339`). That scans every board in the table (`boards.list()`), reads the tenant's cards the same way, and then makes one `getBoard` per role-addressed card in the route.
3. **`dueAt` cannot be cleared.** `KanbanCardPatch` (`kanbanService.ts:553`) limits `null` to the two assignment clears, plus `sourceRef`, `handoff` and `lastRunStatus`. A due-date notice that was already sent stays in the assignee's inbox after the date changes or goes away.
4. **No grouping.** Cards carry free-text `labels`, which CasaVoga already uses for card kind (`decisions`, `selections`, `reminders`). There is no stable key-value place for "lock stage" (one of 10), "room" (up to about 60) or "system". The board view (`frontend/react/src/kanban/KanbanBoardView.tsx`) renders columns only.

## Decision

### D1. A card carries `facets`: a small string-keyed map

`KanbanCard.facets?: Record<string, string>` holds stable grouping keys, for example `{ stage: 'rough-in', room: 'r-12', system: 'hvac' }`.

- At most 8 keys. A key matches `^[a-z][a-z0-9_-]{0,31}$`. A value is 1–64 characters with no control characters.
- It is set through `createCard`, `card.patch`, the work-item proposal (`KanbanWorkItemProposal.facets`, written at create and refreshed by `refresh: true` like the other source-owned facts), and both batch routes (D4, D5).
- In a patch, `facets: null` clears the map. `facets: { room: null }` clears one key, and the other keys are kept.
- Facets are ids, not prose, but a value could still name a person. The ADR 0464 DSAR eraser clears them with the card's other free text.
- Labels stay as they are. Facets are for grouping and filtering; labels are free tags. Namespaced labels (`stage:rough-in`) were rejected: they need parsing, cannot be limited to one value per key, and would collide with the `label-changed` automation trigger.

### D2. The card tenant index carries a filter projection

The `kanban:card` collection gains an `indexProjection` (the GC-CV-11 seam already used by `kanban:work-item`). Each tenant marker then stores a small projection:

`{ id, boardId, columnId, order, dueAt?, assigneeId?, assigneeRole?, labels?, facets?, completedAt?, version }`

There is no title, description or other free text.

- A board or assigned read makes **one** `listForTenantProjected(tenantId)` call. It filters, sorts and pages the projections in memory, then point-reads only the cards on the page, in parallel with a bound of 4 (the pool size).
- Each full row is checked against the filter again. A row that no longer matches is dropped, and its marker is rewritten from the row. A projection can lag its row by one crashed write (`compareAndSwap` writes the marker first, `hostExtPersistence.ts:1012`), so the page trusts only the rows.
- Legacy bare-id markers upgrade themselves on first projected read (existing behaviour). The first read of a large tenant after deploy therefore costs what a read costs today, once.
- If the index is not verified, reads keep today's `cards.list()` fallback and log `kanban_card_read_unindexed`. CasaVoga's tenants are new and verified from their first write.
- **Why not a per-board index collection?** It would need its own marker on every card write, delete, purge and DSAR path. That is the hand-kept dual-write that `grade-data` §3.5 calls an orphan generator. The tenant projection reuses one marker the collection already maintains. If CasaVoga's measurement shows one tenant-wide `kvList` of 25,000 small markers missing 500 ms, the follow-up is a board-prefixed marker inside the same collection (`hostextidx:kanban:card:<tenant>:<board>:<id>`, read with `listByTenantAndIdPrefixProjected`). That is one marker per row, not a second collection. Recorded as OQ-1.

> **CORRECTED 2026-11-22 — D2 is replaced, and OQ-1 with it.** At 15,000 cards a board and 50,000+ a tenant (see Context), one tenant-wide `kvList` per read is the wrong shape: every board read would still list every marker in the tenant. A board-prefixed marker is also more index machinery than this record should invent, because the host already has a declared index for a feature's own store. P3 rides **ADR 1110 P5's `registerStoreIndex`** (`features/entities/systemIndex.ts:151`, `StoreIndexDecl`). That index has declared marker families, an intent lease around each write (`beforeSystemWrite` / `afterSystemWrite`), a manifest, repair and rebuild, per-family counts (`indexedFamilyCount`), key-range paging (`listIndexPage`) and fold-safe raw tenant segments. `commerce.order` (`features/commerce/commerceService.ts:1183`) and the media stores (`features/media/mediaService.ts:261`, `:277`) already use it. No new index machinery is added.
>
> - **Families**, each under the org segment `_`:
>   - `board`: `[boardId, columnId, orderKey]`;
>   - `board-due`: `[boardId, dueAt or "~"]` (`~` sorts undated cards last);
>   - `assignee`: `[userId, dueAt]`;
>   - `role`: `[roleKey, dueAt]`;
>   - `facet`: `[boardId, key, value, dueAt]`.
> - **Projection** on each marker: `{ boardId, columnId, order, dueAt, assigneeId, assigneeRole, labels, facets, completedAt, version }`. As before, there is no title, description or other free text.
> - **Query plan.** Pick the most selective family slice for the filter, page it by key range, filter the remaining predicates in memory within that slice, then point-read the page (bound 4, the pool size). `total` comes from `indexedFamilyCount`, and `groupCounts` from the `facet` family's counts.
> - **The stored row is truth.** Each paged card is checked against the filter again on its full row, exactly as D2 said for the projection.
> - **Open boundary question, decided before P3 code.** `systemIndex.ts` lives in `features/entities/`, while `kanbanService.ts` is in `host/`, and `host/` must not import up into a feature (ADR 0001). There are two options. (a) Move the generic index primitive into `host/`, with a re-export from `features/entities/systemIndex.ts` so existing callers do not change. Today it imports only `host/hostExtPersistence`, the logger, and one type (`EntityRecord`) from `entitiesService`, so the type would need to become generic or move as well. (b) Register the kanban index from a kanban feature package, with hooks the host calls. That splits kanban's ownership across two places. The release coordinator leans toward (a). An `/architect` pass decides it and is recorded here.
>
> > **DECIDED 2026-11-23 (`/architect`, options mode): option (c). Neither (a) nor (b).** `host/kanbanService.ts` imports `registerStoreIndex`, `beforeSystemWrite` / `afterSystemWrite`, `listIndexPage` and `indexedFamilyCount` directly from `features/entities/systemIndex.ts`. Nothing moves.
> >
> > - **The premise behind (a) was false.** "`host/` must not import up into a feature" is not a rule this backend enforces, and it does not hold for this module. The ADR 0630 import gate scans only `frontend/react/src` (`scripts/check-feature-import-boundary.mjs:68`). Even there, it permits a **core** feature, because a core feature is never excludable. `entities` is core (`distributions/bundles.json` `core[]`), and `host/` already imports it (`host/demoEntitiesSeed.ts:31`, `host/demoContentMarketingSeed.ts:24`), as 75 `host/` files import some feature. Moving about 700 lines and five durable collection names into `host/` would buy layering that nothing checks, at the cost of churn and a broken blame history. A later move with a re-export stays mechanical if a backend layering gate ever lands.
> > - **(b) is rejected.** Kanban's writes all live in `host/kanbanService.ts`, so a feature package that registers the index would still need the host to call its write hooks. That splits one store's index across two owners.
> > - **The real boundary defect is the sweep, and P3 fixes it first (P3a).** The index's upkeep (intent repair, queued builds, hourly drift check) is global, but two features each run their own copy: `repairCatalogIndex` (`features/commerce/commerceService.ts:783`) and `repairMediaIndex` (`features/media/mediaService.ts:1554`). Both call the same global `repairSystemIndex` and `drainSystemIndexBuilds`, and each drift-checks only its own types. Kanban registering would add a third copy, or would leave kanban with no drift check. P3a moves the generic upkeep into one sweep owned by `entities`: repair, drain, and an hourly drift check of **every** registered type, taken from the declaration registry. Commerce and media keep only their own extra steps, such as commerce's product-tenant backfill queue. Kanban then registers and gets the upkeep for free.
> > - **Write sites.** Kanban has six card writes (`kanbanService.ts:842`, `:1188`, `:1191`, `:1906`, `:2571`, `:2838`). P3 routes them through one wrapper that calls `beforeSystemWrite` / `afterSystemWrite`, following commerce's `orders` wrapper over `orderRows` (`commerceService.ts:1201–1223`), plus a ratchet that no other `cards.put` / `compareAndSwap` / `delete` call exists. A missed site would be an unindexed card until the hourly drift check rebuilds the tenant.
> > - **Two costs P3 must measure with the P0 harness before it merges:**
> >   - **Writes per card.** Each card write now writes the row plus one marker per family. The `facet` family is one marker per facet key, up to 8. Add the manifest, the counter and the intent lease, and a card can cost 12 or more kv writes, on top of today's measured 15.7–23.7 ms per card in memory. If that is too heavy for P4's batch create, index only the board's `groupBy` facet key.
> >   - **The first read of a large tenant.** Above `INLINE_BUILD_MAX` (500 rows, `systemIndex.ts:535`), a read queues the build and answers from its fallback. Kanban's fallback today is the 25,000-read path P0 measured. P3 must either drain the build for existing tenants before it switches reads, or give the read a bounded fallback (a page from the unindexed scan, capped). It must never serve a short index as the whole board.
> > - **What would change this decision:** a backend import-layering gate that forbids `host/` importing a core feature (then do (a), as a move with a re-export); `entities` leaving `core[]` (then the index must move to `host/` before kanban depends on it); or a measured per-write cost that makes the store index unusable for kanban (then revisit D2 at the board-prefixed-marker fallback).

### D3. Board and assigned reads page and filter on the server

`GET /boards/:boardId` and `GET /kanban/assigned` accept the same query:

| Param | Meaning |
|---|---|
| `limit` | 1–100. Giving it turns paging on. The default page is 50. |
| `cursor` | An opaque value from the previous page's `nextCursor`. It is bound to the filter and sort, so a cursor reused with a different query is a 400 `kanban_cursor_invalid`. |
| `column` | A column id. Repeatable. (`/boards/:id` only.) |
| `dueFrom`, `dueTo` | An ISO date range, inclusive and on `dueAt`. A card with no `dueAt` never matches a date filter. |
| `overdue=true` | `dueAt` is before now, and the card is not in a terminal lane. |
| `assignee` | A user id, `me`, `role:<key>` or `none`. (`/boards/:id` only; the assigned view is always the caller.) |
| `label` | Repeatable, matches any. |
| `facet.<key>` | Facet equals the value. Repeatable across keys, AND. `facet.<key>=` (empty) matches cards without that key. |
| `sort` | `order` (column, then order; the default) or `dueAt` (ascending, cards with no date last, then id). |
| `groupBy` | A facet key, `assignee` or `column`. The response then adds `groupCounts`. |

A paged response is `{ board, cards, workItems, total, nextCursor?, groupCounts? }`.
- `total` counts every matching card. That is free, because the projections are already in memory.
- `workItems` holds only the items linked to the page's cards.
- `groupCounts` (`{ [groupValue]: number }`) lets the board draw every lane header before it loads a lane's cards.

**Without `limit`, the response is unchanged**: every card, for the existing SPA and adopters. It still moves onto the D2 projection path, so it costs one list plus one read per card on the board, not one per card in the tenant. Capping or deprecating the unpaged read is OQ-2.

> **CORRECTED 2026-11-22 — OQ-2 is decided.** Above **2,000** cards, an unpaged `GET /boards/:id` returns a typed `400 kanban_board_page_required` with `{ total, cap }` and no cards. It never returns a truncated `200`: an old client ignores an unknown "truncated" marker and would render a partial board as if it were the whole board. `GET /kanban/assigned` gets the same cap, counted on the caller's matching cards. The cap does **not** ship in P3. It ships alone, as **P5b** (see the note under the implementation plan).

`/kanban/assigned` stops scanning `boards.list()`. It reads the tenant projection filtered to the caller's `assigneeId` or held roles, point-reads only the boards that the page's cards sit on, and resolves the role-access check (`boardAccess`) once per board instead of once per card.

### D4. Batch create, idempotent by source id

**A service command, not an HTTP route.** CasaVoga's main caller is in-process: its adopter backend calls kanban service functions directly from setup and schedule code (casavoga-c9, 2026-11-22), and it does not need batch writes over HTTP. So batch create is `applyBoardCommand({ type: 'cards.create-batch', tenantId, boardId, items, onExisting?: 'skip' | 'refresh', notifyAssignees?: boolean, idempotencyKey? })`, beside `work-items.materialize` and `card.patch`. An HTTP route is left out until a caller needs one (OQ-5).

- **Items.** Each is `{ sourceId, title, columnId, description?, dueAt?, assigneeId? | assigneeRole?, priority?, labels?, facets?, sourceLabel?, sourceRef? }`. There are at most 200 items, and every `sourceId` is unique and 1–200 characters.
- **Identity.** The card id is deterministic: `card-src-` plus the first 32 hex characters of `sha256(tenantId, boardId, sourceId)`, through `createCard`'s existing `cardId` (the ADR 0311 precedent and its cross-board collision guard). A retried batch, or a resume after a crash halfway through, converges with no duplicates. `idempotencyKey` is not needed for that, though an optional `idempotencyKey` is still honoured through `reserveKanbanOperation`, so a replay returns the recorded result.
- **Existing cards.** `onExisting: 'skip'` (the default) leaves an existing card alone. `'refresh'` updates only the facts the source owns, by CAS: title, description, dueAt, sourceLabel, sourceRef and facets. It never touches the assignee, column, order or labels, and never a card in a terminal lane. That matches ADR 1137 D3.
- **Validation.** Everything is checked before any write: columns, role fit (`assertAssigneeRoleFits`) and assignee read access (`assigneeCanSeeBoard`, once per distinct assignee). One bad item fails the whole batch with its index, and nothing is written.
- **Results.** The response gives each item `{ sourceId, cardId, status: 'created' | 'existing' | 'refreshed' }`.
- **Notifications.** `notifyAssignees` defaults to **false**. A 6,000-card import must not send 6,000 assignment notices. Due reminders (ADR 1138) still fire for dated, assigned cards on the sweep.
- **Not work items.** These are plain cards. A card that a workflow must execute keeps using `materializeWorkItems`. Writing a work item, an audit row and an outbox row for each of 6,000 decisions would quadruple the writes for work that nothing dispatches.
- **Board events.** The board's change event (`notifyBoardChanged`) fires once per batch, not once per card.

### D5. Batch patch by card id, CAS per card

A service command, like D4: `applyBoardCommand({ type: 'cards.patch-batch', tenantId, boardId, items: [{ cardId, expectedVersion?, patch: { dueAt?: string | null, priority?, labels?, facets? } }], idempotencyKey? })`, at most 500 items.

- Each item is its own `card.patch` command under its own CAS. `PatchKanbanCardCommand` gains `expectedVersion?: number`: when it is set and the fresh row's `version` differs, the result is `kanban_card_precondition_failed` and nothing is written. That is a data field the service compares, not a caller-built function, so ADR 0774's rule that `precondition` is never built from request input still holds.
- **Not atomic across cards.** The response reports each item as `{ cardId, status: 'updated' | 'unchanged' | 'conflict' | 'not_found' | 'invalid', card? }`, and the caller retries the conflicts. A re-date of 2,000 cards is 4 requests.
- Items run with a concurrency of 4 (the pool size). The board's change event fires once per batch.
- **Allowed fields.** Only re-date and grouping fields can be batched. Assignment, moves and content keep their single-card routes, because they carry notification, trigger and WIP side effects that a batch would have to reproduce.
- **Access.** The commands take a tenant and board and trust the caller, like every `applyBoardCommand`. They are for host code (an adopter's backend, a feature), not for request input. A future HTTP route (OQ-5) would need `workspace:write` on the board and would refuse assignment-only callers, because the ADR 0049 D4 carve-out covers moving one's own card, not bulk edits.
- **Idempotency.** An optional `idempotencyKey` is honoured as in D4.

### D6. `dueAt: null` clears the date and withdraws stale due notices

- `KanbanCardPatch.dueAt` becomes `string | null`, and the card PATCH route accepts `null`.
- When a patch clears or **changes** `dueAt`, the service withdraws the card's open `kanban.due` notifications for its assignee. That is best-effort, the same shape as `withdrawAssignmentNotification` (`host/kanbanAssignmentNotify.ts:71`): it archives, never deletes.
- The ADR 1138 notice id is a hash of `(tenant, card, state, dueAt)`, so a new date gets a fresh notice on the next sweep.
- One known edge case is kept on purpose. A date cleared and then set back to the **same** value hits the archived notice's id and does not re-notify. Re-notifying would need a per-set generation on the card, and nothing has asked for that.

### D7. Swimlanes in the board view

- `KanbanBoardView` gains a **Group by** control: none, a facet key present on the board, assignee or priority. Grouping draws one swimlane row per value across the columns, with each lane header showing its count from `groupCounts`.
- The board's default comes from a new optional `KanbanBoard.groupBy` (a facet key, set through `PATCH /boards/:id`). The viewer's choice rides the URL (`?groupBy=`), so a grouped view can be shared.
- A board with more than 500 cards loads in pages. The view first fetches `limit=1&groupBy=…` for the lane headers and counts, then loads each visible lane and column with `facet.<key>=<value>&column=<id>&limit=50`, and **Show more** follows `nextCursor`.
- Smaller boards keep today's single unpaged read.
- The control, lane headers and **Show more** use the existing `ui/` primitives and copy in all four locales.

### Why no RFC

Everything here is a host-extension route under `/host/openwop-app/kanban/*`, a host-internal service command, or a card field, and those are non-normative (CLAUDE.md § "A spec change needs an RFC"). **No method is added to `ctx.kanban`**, because that surface is RFC `host.kanban` (`spec/v1/host-capabilities.md`). Workflow callers keep `materializeWorkItems` in batches of 100 with `refresh: true`, and gain `facets` through the proposal (D1). CasaVoga confirmed that is enough. Batch create from inside a workflow beyond that would be a `host.kanban` RFC change (OQ-4).

## Alternatives considered

- **Raise `materializeWorkItems` to thousands of items and reuse it over HTTP.** Rejected. It writes four rows per card, and its work-item lifecycle (dispatch, dependencies, outbox) means nothing for a decision card. A materialization of 6,000 items would also be one huge request with no resume point.
- **A per-board index collection.** Deferred behind a measurement (D2, OQ-1).
- **Add a SQL table for cards.** Rejected for now. Cards live in `host_ext_kv` with every other durable surface (ADR 0867). A table would need its own migration, DSAR, purge and backup story. The projection read may well be enough, and CasaVoga's numbers will tell.
- **Client-side paging only.** Rejected. It still transfers every card, and the server still does today's read on every request.

## Implementation plan

| Phase | What | Tests |
|---|---|---|
| P1 | D6: `dueAt: null` in the patch and route, plus withdrawing due notices on clear or change | Clearing through the route; changing withdraws; an assignment-scope caller still gets 403 on `dueAt` |
| P2 | D1: `facets` on the card, create, patch, proposal, refresh and DSAR eraser; validation | Limits and charset; per-key clear; refresh rewrites facets; the eraser clears them |
| P3 | D2 + D3: card `indexProjection` and paged, filtered reads on both routes; fix the assigned view's board scan and N+1 | Each filter; cursor round trip; a cursor reused with another filter returns 400; a stale projection is dropped and healed; a route test proving that an unpaged `GET` response is unchanged; tenant isolation of the projection |
| P4 | D4 + D5: the `cards.create-batch` and `cards.patch-batch` commands, `expectedVersion`, one board event per batch | Retry converges with no duplicates; resume after a partial batch; refresh stays within source-owned fields; a conflict is reported per item; the 200 and 500 caps; tenant and board mismatch refused |
| P5 | D7: `groupBy` on the board and swimlanes in the board view, paged loading above 500 cards | Frontend vitest for lane grouping and Show more; `npm run build` |
| P6 | Measure with CasaVoga's 6,000- and 25,000-card numbers; set the final page size and batch caps; decide OQ-1 and OQ-2 | Recorded here as a correction note |

Each phase is its own PR, gated through the release coordinator's train.

> **CORRECTED 2026-11-22 — phases added at the larger volume.**
>
> - **P0. A measured baseline before P3.** At the 15,000-card board and the 25,000- and 50,000-card tenant sizes, record today's read count and wall time for `GET /boards/:id` and `GET /kanban/assigned`. The release coordinator asked for this, so P3's improvement is measured, not asserted. It runs only in a slot the coordinator names.
> - **P2b. Facets from a workflow node.** The `core.openwop.kanban-work-items` pack schema is `additionalProperties: false`, so a workflow's work-item proposal cannot carry `facets` until the pack is bumped and re-pinned (the ADR 1137 P3 precedent). Until then, facets reach cards through the service commands, create and PATCH.
> - **P5b. The unpaged cap (OQ-2).** It ships after P5 (the SPA pages) and after an `@openwop/cli` release whose `kanban board` and `kanban assigned` commands follow `nextCursor`. Both commands read unpaged today (`openwop-cli` `src/cli/kanban.ts:107` and `:292`). That release is a public publish, so it needs David's own go in the session that runs it, and P5b's PR body must say so. P5b carries a CHANGELOG entry and an "Upgrading from" note: a 0.x minor contract change, and an operator with any board above 2,000 cards deploys the new SPA first.

> **MEASURED 2026-11-23 — the P0 baseline.** One vitest process at 1 worker on `memory://`, at `41001fe85`. One tenant held 25,000 cards: one 15,000-card board plus 10,000 cards on four other boards. 2,000 of the board's cards were assigned to one user. Every host_ext_kv call was counted. The call counts are what transfer to production, where each call is one Postgres round trip. The times are in-memory floors only, so production will be slower.
>
> | Read | Rows returned | kv calls | Time (memory) |
> |---|---|---|---|
> | `GET /boards/:id` (`listCards`), index **not** verified | 15,000 | 3 (1 `kvList` of the **whole table**, every tenant) | 61 ms |
> | `GET /boards/:id`, index verified, first read | 15,000 | 50,006 (25,003 `kvGet`, 25,001 `kvSet`, 2 `kvList`) | 417 ms |
> | `GET /kanban/assigned` (`listCardsAssignedToUser`), verified | 2,000 | 25,004 (25,002 `kvGet`, 2 `kvList`) | 228 ms |
>
> - **Today's verified index makes a board read worse, not better.** The fallback it replaces makes 3 calls. The verified path makes 50,006 calls on its first read and about 25,004 on every later one, and it was 7× slower even in memory. The fallback's 3 calls are not cheap: one of them lists the whole table, every tenant's cards, in one query, so its cost grows with the whole installation. Neither path is acceptable at this volume. That is the headline argument for P3.
> - **A board read costs one sequential `kvGet` per card in the tenant, not per card on the board.** It reads 25,000 rows to return 15,000, and that cost grows with every other board the tenant holds. At about 1 ms per round trip, that is about 25 s per read in production, sequential on a 4-connection pool. This is an estimate from the counts, not a production measurement.
> - **The first verified read also wrote 25,001 rows. Traced: it is the one-time tenant-index backfill.** `DurableCollection.ensureTenantIndex()` (`host/hostExtPersistence.ts:888`) runs at the start of every indexed read. Until the durable sentinel `hostextidxmeta:kanban:card:backfilled` exists, it lists the **whole collection**, every tenant, and `kvSet`s one marker per row: 25,000 writes, plus 1 for the sentinel. Those numbers match exactly, and so do the extra `kvList` and the `kvGet` count.
>   - **It is once per installation, not per instance or per deploy.** The sentinel is a stored row, and the only code that deletes it is the test-only `__clear()` (`:1038`). Tenant migration leaves `hostextidxmeta:` rows alone (`storage/tenantMigration.ts:158`).
>   - **It is redundant.** The ADR 0866 reconcile pass that verified the index had already written every missing marker (`repaired: 0` in this run), so the backfill rewrote markers that already held the same value.
>   - **It runs on whatever request comes first,** which might be a user's `GET` or the hourly due sweep (ADR 1138). It runs with no lease, so instances that read at the same time each repeat the whole scan and rewrite. The writes are idempotent, so this costs load and does not corrupt data.
>   - **In production it has most likely already run,** because the due sweep reads this index every hour. That should be confirmed with a read-only probe: the sentinel row should exist. The same one-time backfill applies to every collection with a `tenantOf`, and the first indexed read of each one pays for it.
>   - **P3 must not carry it.** `registerStoreIndex` builds per tenant, not per installation. A request builds inline only up to `INLINE_BUILD_MAX` rows, with one flight per tenant. A larger tenant is queued for the background sweep (`ensureSystemIndexBuilt`, `features/entities/systemIndex.ts:567`), and the request reads its bounded fallback meanwhile.

> - **The unverified fallback is cheap in calls but scans the whole table.** In memory that is one `kvList`. In Postgres it reads every tenant's cards in one query. Its cost grows with the whole installation, not with this tenant.
> - **`/kanban/assigned` reads every card in the tenant to return 2,000.** It also scans `boards.list()` across every tenant, which counts as one `kvList` here.
> - **Seeding is a finding for P4.** `createCard` one at a time cost **15.7–23.7 ms per card** in memory. The higher figure was measured beside another gate. At that rate, a 15,000-card board takes 4–6 minutes to create even with no network, and Postgres adds a round trip per write. That is the case for D4's `cards.create-batch`. The stop rule (3 ms per card) ended the run at 25,000 cards, so the 50,000-card tenant was not measured. Its read counts should scale linearly: one `kvGet` per tenant card.
> - **What P3 must beat:** a page of 50 should cost one key-range list plus about 50 point reads (D2's correction note), independent of the tenant's size.
>
> **MEASURED 2026-11-23 (P3a) — kv calls per card write under the D2 store index.** A prototype of D2's declaration (families `board`, `board-due`, `assignee`, `role`, `facet`), on `memory://` at `029324b15`. Each write runs `beforeSystemWrite`, then the row write, then `afterSystemWrite`, as commerce's `orders` wrapper does. The card is assigned and dated. The prototype reads its rows from memory, so production adds about 1–2 `kvGet` per write for the row read.
>
> | Write | kv writes (incl. the row) | kv reads |
> |---|---|---|
> | create, 0 facets | 10 | 11 |
> | create, 3 facets | 13 | 11 |
> | create, 8 facets | 18 | 11 |
> | re-date, 3 facets (every family's `dueAt` segment moves) | 17 | 10 |
> | column move, 3 facets | 13 | 10 |
> | an edit that moves no marker | 1 | 3 |
> | delete, 3 facets | 13 | 11 |
>
> - **A write costs 7 fixed calls plus one per marker,** and every write that moves a marker also makes 10–11 reads. A board-wide re-date of 2,000 cards (D5) is therefore about 34,000 writes. A 15,000-card import with 3 facets each (D4) is about 195,000 writes plus 165,000 reads, against today's 1 per card.
> - **The facet family is the multiplier.** One marker per key, so 8 keys cost 5 more writes than 3. P3 should index facets only for the board's `groupBy` key, or for a short declared list. It should also not put `dueAt` in every family's key: a re-date then rewrites one marker per family.

## Open questions

- **OQ-1.** Does one tenant-wide projected `kvList` meet about 500 ms at 25,000 cards? If not, add board-prefixed markers (D2). Decide at P6 from measurement.
  > **CORRECTED 2026-11-22:** superseded. D2 now rides `registerStoreIndex` (see the D2 correction note), so there is no tenant-wide list left to measure.
- **OQ-2.** Should an unpaged `GET /boards/:id` be capped (for example, a 400 above 2,000 cards that asks for `limit`) once the SPA pages? Decide at P6.
  > **CORRECTED 2026-11-22:** decided. A typed 400 above 2,000 cards, on both routes, shipped as P5b (see the D3 correction note).
- **OQ-3.** Should batch create send one digest notification to each assignee ("12 decisions were assigned to you") rather than none? Ask CasaVoga.
- **OQ-4.** Is batch create needed inside workflows beyond `materializeWorkItems`' 100 items per call? CasaVoga says no (2026-11-22). If someone does need it, it needs a `host.kanban` RFC.
- **OQ-5.** HTTP routes for the two batch commands. Left out because no caller needs them. Add one with the access rule in D5.
