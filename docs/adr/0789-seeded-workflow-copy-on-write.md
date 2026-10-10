# ADR 0789 — Shared (seeded) workflow definitions are never written by a tenant: copy-on-write fork

Status: Accepted (implementation on `fix/seeded-workflow-tenant-write`)

- **Found by:** feature loop 2026-10 row 11 (MCP, ADR 0788) while tracing which
  workflows an MCP client could see. Carried as a separate security fix.
- **Composes:** ADR 0163 (ownership index), ADR 0440 P4 (the write guard this
  corrects), ADR 0435 / ADR 0596 R2 (the owned-shared-definition seed lane),
  ADR 0474 (revisions), ADR 0369 (lifecycle), ADR 0770 D5/D6 (builder CAS + flush),
  ADR 0788 § Deferred (the stranded projection copies retracted here).
- **Toggle:** none. This is an authorization fix on an always-on core surface.
- **RFC verdict:** host-only. `/v1/host/openwop-app/workflows*` is a
  non-normative host extension. The response gains an additive `forkedFrom`
  field and may carry a different `workflowId` than the request. No wire, event
  or capability change.

## Context

Three seeders give every seeded tenant the same workflows under a deterministic id:

| Seeder | Ids |
|---|---|
| `host/seedWorkflows.ts` `seedZeroConfigWorkflows` | `wf.seed.<chain>` (~50) |
| `host/workflowAuthorSeed.ts` | `openwop-app.authored.{lead-triage,doc-summary}` |
| `host/demoWalkthroughsSeed.ts` | `walkthrough.campaign-studio.first-brief`, `walkthrough.chat.first-message` |

The DEFINITION is one row in the global by-id registry (`wfreg:<id>`). Only the
OWNERSHIP row (`workflow:ownership`, `${tenant}:${id}`) is per tenant. The write
guard `isWriteProtected` (`routes/workflows.ts`) short-circuited on
`getOwned(tenant, id)` ("self-overwrite / autosave"), so a seeded tenant's write
landed on the row every other seeded tenant runs. Every tenant write verb was
affected:

- **POST save (builder autosave, Run, debug).** One tenant's edit changed the steps
  every seeded tenant runs, and each of them runs those steps with its OWN BYOK
  keys and connections. That is an injection path, not cosmetic drift.
- **DELETE.** `deleteRegisteredWorkflow` removed the global row, and its deletion
  hooks cascaded by id: `deleteWorkflowRevisions(id)` takes no tenant, so every
  tenant's revision history (the replay pin) went too.
- **archive / unarchive / promote.** These rewrote the shared row's lifecycle.
- **rollback.** This re-headed the shared row.
- **Pre-squat.** A tenant could CREATE a free `wf.seed.<chain-not-yet-shipped>`. The
  seeder is register-if-missing, so every tenant seeded afterwards would adopt the
  squatter's definition.

`workflowAuthorSeed.ts` documented the first bullet as an accepted TRADEOFF
("illustrative demo content"). That judgement was wrong: the builder can add ANY
node to the graph. A correction note now sits at the site.

## Decision

**A shared id is never written through a tenant lane.** One predicate,
`isSharedWorkflowId` (`host/workflowOwnership.ts`), defines "shared":
`wf.seed.*`, `tmpl.*`, `openwop-app.*`, and the two seeded walkthroughs, named
EXACTLY. A `walkthrough.*` prefix was the first cut. The grade pass caught it:
the tour recorder mints `walkthrough.recorded.<slug>.<uuid>` and the tour author
mints `walkthrough.authored.<uuid>`, both tenant-owned, so the prefix broke saving
a recorded tour. It is kept distinct from `PUBLIC_WORKFLOW_ID` on purpose.
PUBLIC answers "readable by anyone and never an MCP tool" (the M7 read guard and
ADR 0788 D1). SHARED answers "one row that no tenant lane writes" and is PUBLIC
plus the two exact seeded walkthrough ids. Those two are shared-written but NOT
public-readable, and they expose no MCP tool, so MCP stays on PUBLIC. The two
regexes spell the same three prefixes today. Deriving SHARED from PUBLIC in code,
so the prefixes cannot drift, is a small follow-up.

The shared predicate is a namespace test rather than an
"owned by >1 tenant" count, for two reasons. The count is a full ownership scan
on the 1.5 s autosave path. It is also FALSE for the first tenant ever seeded,
which is exactly the tenant whose write would poison every later seed. A test pins
every seeder's ids to the predicate, so a new seeder cannot drift out of it.

| Verb on a shared id | Before | After |
|---|---|---|
| POST, content unchanged: the builder's `X-OpenWOP-Canvas-Pristine: 1`, or `revisionHashOf` equal after the ADR 0524 merge | re-registered the shared row | **no-op**, 201 with the same id (a Run that re-registers an untouched seeded workflow must not mint a copy) |
| POST, content changed | overwrote the shared row | **fork**: 201 `{workflowId: <fork>, forkedFrom, revision}` |
| POST by a non-owner, or of a FREE shared-namespace id | 404 for foreign ids, **201** for free ids (pre-squat) | 404, indistinguishable |
| POST by a tenant that already FORKED it (second tab, queued save, old bookmark) | n/a | lands on the tenant's fork; `If-Match` is judged against the FORK's head, so a canvas loaded from the shared original gets 409 instead of overwriting the fork's newer edits |
| rollback | re-headed the shared row | **fork**, or a no-op when the restored content equals the shared head |
| archive / unarchive / promote | rewrote the shared row's lifecycle | ownership row only (the list, builder and `/` picker render from it); promote starts from the ownership row's archive state, so it never silently un-archives |
| DELETE | deleted the global row + every tenant's revisions | ownership row only; the schedule guard still applies |
| last owner's teardown (`purgeTenantOwnedWorkflowDefs`: account deletion, anon teardown) and the showcase/walkthrough CLEAR | deleted the row once nobody owned it | never deletes a shared row. Forked or retracted tenants still have runs stamped with it, and the cascade drops every tenant's revisions |
| AI-author `persist` / agent `compose` / `propose` | could write an owned shared id, or mint a free one | 409 `shared_workflow` / typed refusal; the model authors under a new id |
| collab room | refused `PUBLIC_WORKFLOW_ID` | refuses the wider shared predicate (adds the two walkthroughs) |
| wildcard operator (`tenants: ['*']`) | writes | unchanged: host tooling may still maintain the shared rows |

### Why the builder says "pristine" (and why that is safe to trust)

The builder's serializer normalises what it sends. It drops the default
`triggerRule`, an empty `config`, default ports, and node names equal to the
catalog label, and it fills first-port defaults from ITS catalog. The grade pass
measured 89 explicit `all_success` edges and 94 `config:{}` nodes across the
corpus, so a hash of an untouched seeded workflow's round-trip is NOT the stored
hash, and the port defaults are not derivable server-side. The first Run of an
untouched seeded workflow would therefore have forked it.

So the builder records the canvas's wire serialization at load
(`builderStore.isCanvasPristine`) and sends `X-OpenWOP-Canvas-Pristine: 1` when
it is unchanged. The header is added to the CORS allow-list. Trusting it is safe
because it can only SUPPRESS a write: a lying client gets a same-id no-op, and
its edit is simply not saved. No tenant lane writes the shared row at all.

### The fork (`host/sharedWorkflowFork.ts`)

Order, chosen so a crash part-way fails SAFE:

0. **Claim** the fork id by compare-and-swap of `forkedTo` onto the tenant's
   ownership row of the shared id (`claimForkOf`). Two concurrent first saves (two
   tabs, two instances) converge on ONE fork, last writer wins like any autosave.
   A save after a crash part-way re-claims the same id and completes the remaining
   steps. Every step below is idempotent on that id.
1. Register the fork under a random, non-shared `wf.fork.<slug>.<8hex>` (durable,
   awaited). Random rather than tenant-derived, so no one can predict and
   pre-register it. If the tenant had PROMOTED the seeded workflow, the published
   revision's content is first recorded under the fork and pinned as its
   `publishedRevision`. The re-pointed schedules and triggers then keep launching
   the published content, not the unpromoted edit, which would otherwise bypass
   the promote gates.
2. `recordRevision`, attributed like any save.
3. **`recordOwnership`** with the sticky `forkedFrom`. This is ce requirement 1:
   without the ownership row the fork is invisible in `/builder` and the `/` picker.
4. Run the **fork hooks**: re-point THIS tenant's references (below).
5. Only then remove this tenant's ownership of the shared id.

A crash before step 5 leaves the tenant owning both (a visible duplicate), and
its next save re-claims and completes the same fork. A crash between steps 1 and
3 leaves a registered but unowned fork definition that no purge reaches. That is
bounded (one row, never listed) and accepted. The shared row is not touched at any
step. Runs stamped with the shared id keep
resolving it, and it never changes again (replay-safe).

The seeders skip a shared id the tenant already holds a fork of (`forkedFrom`),
so a re-seed never lists "X" beside the tenant's edited "X". Forks are ordinary
tenant-owned workflows, so they appear in that tenant's MCP tool list like any
other workflow it owns (ADR 0788 D1 excludes only shared namespaces). That is
intended.

### Re-pointing references (ce requirement 2)

`workflowsRegistry.onWorkflowForked(id, hook)` mirrors `onWorkflowDeleted`. The
owning module subscribes and the registry imports none of them. Each hook
rewrites only `tenantId`'s rows, via one CAS primitive (`host/forkRepoint.ts`)
that is idempotent: a row no longer matching the old id is skipped. A hook
failure is counted and logged (`workflow_fork_hook_failed`), and the response
carries `repointFailed`. It is never thrown, because the fork is already durable,
and a missed re-point leaves a reference on the unchanged shared definition.
That reference is stale, not unsafe.

| Store | Hook | What moves |
|---|---|---|
| `scheduler:job` | `scheduler:job` | `workflowId` (this also covers project schedules, scheduled-chat jobs, assistant loops and cadence jobs, which live as scheduler jobs) |
| `kanban:board` / `kanban:card` / `kanban:work-item` | `kanban` | column `triggerWorkflowId`, card `workflowId`, work item `workflowId` while `execution.status === 'idle'` |
| `roster` | `roster` | `workflows[]` |
| `projects:project` | `projects` | `workflows[]` |
| `profiles:profile` | `profiles:profile` | `workflows[]` |
| `triggerbridge:sub` | `trigger-bridge:subscription` | `workflowId` |
| `hostevent:binding` | `host-event:binding` | `workflowId` |
| `connections:inbound` | `connections:inbound` | `workflowId` |
| `messaging_routing_rules` | `messaging:routing-rule` | `workflow_id` |
| `schedchat:config` | `schedchat:config` | turn-workflow override `workflowId` |
| `workflow:budget` | `workflow:budget` | the budget row, re-keyed |
| `workflow:eval-set` | `workflow:eval-set` | the eval-set rows, re-keyed |
| `workflow:debug-pin` | `workflow:debug-pin` | the pins, re-keyed (the fork keeps the node ids) |

**Partial failure (a hook throws mid-fork) — the deliberate answer.** By the time
the hooks run, the fork is registered, has its revision, and is OWNED, so it is the
tenant's copy regardless. Therefore:

- the save still returns **201 with the fork's id**, plus `repointFailed: [<hook ids>]`;
- every other hook still runs, because each is isolated (`runWorkflowForkHooks`);
- the caller's shared ownership is **still dropped**. Keeping it was weighed and
  rejected: it would leave the tenant listing both copies, and the claim already
  makes a re-save land on the same fork, so keeping it would buy nothing;
- the failed hook ids are **persisted** on the fork's ownership row
  (`repointPending`). Every later save of the fork re-runs exactly those hooks
  (`retryPendingRepoints`) and clears them once they succeed, so a failure is
  never only a log line. Retrying matters because a stale reference is not always
  harmless: an inbound webhook refuses to fire for an id another tenant owns;
- a reference the failed hook missed stays on the shared id. That id is unchanged
  and still resolves, so the reference is stale, never unsafe;
- the failure is logged as `workflow_fork_hook_failed` (error level), and the
  builder shows a warning toast saying some linked items still point at the
  original.

Every hook is idempotent (CAS on "still references the old id"), so the retry is
safe. A hook that half-applied before throwing (kanban updated its boards, then
threw on cards) is completed by the retry. `moveKeyedRows` is put-if-absent then
delete, not atomic: a crash between the two leaves a duplicate budget, eval-set or
pin row on the shared id, which is harmless (the fork's row is authoritative) and
accepted. The `connections:inbound` hook full-scans that small collection (it has
no tenant index), which is acceptable on the rare fork path. The witness is the
"PARTIAL FAILURE" leg of `seeded-workflow-tenant-isolation.test.ts`, which also
proves the retry.

**Deliberately left on the old id, with the reason:**

- **Runs, run events, notifications, dispatch outbox, approvals, trigger
  deliveries, running or finished kanban work items, `kanban:work-item-run`.**
  These are history or in-flight state, and a run replays against the definition
  it recorded.
- **`workflow:revision`.** Content-addressed history of the shared id. The fork
  records its own first revision.
- **`workflow:eval-result`, `workflow:eval-online`, `workflow:spend-day`.** Each
  result is pinned to the revision it graded, and the fork's head is a new
  revision that the promote gate must grade afresh. Spend is the shared id's
  history, and the fork starts its day at zero.
- **Environment snapshots (`env:snapshot` `workflowPins`).** These are immutable
  and content-hashed, so rewriting one changes its hash. Applying a pre-fork
  snapshot hits `setPublishedRevision` on an ownership row that no longer exists.
  That fails closed, as the named per-item error the domain already reports.
- **Strategy cadence.** Its workflow id is derived (`wf.<chain>.cadence-<tenant>`),
  never a shared id.
- **Collab snapshots, seed claims and builder-pair rooms.** Shared ids can never
  open a room, so none exist.
- **MCP exposure `disabled[]`.** ADR 0788 D1 never exposes a public-namespace id,
  so no entry names one.
- **Sub-workflow references inside other definitions (`config.workflowId`).** A
  shared parent cannot be rewritten (it is shared). Rewriting the tenant's own
  parents would mint silent revisions of workflows the user did not edit, so they
  keep calling the unchanged shared child. Revisit if a tenant-owned parent ever
  commonly nests a seeded child.
- **Chat mentions and pins.** No persisted store exists. The mention picker
  re-reads the ownership list, which lists the fork, and the builder's local cache
  is re-keyed (below).
- **Workforce catalogs (`workforce.workflowCatalog`).** These are a global seed, not
  tenant state.

### Frontend (ce agreed the file list; nothing of ce's in flight there)

Every lane that POSTs a definition adopts the RETURNED id:

- `backendStore.saveWorkflow` returns `workflowId`, `forkedFrom` and
  `repointFailed`, and re-keys the local cache.
- A write already QUEUED under the shared id when the fork lands is sent under the
  fork (`resolveForkAlias`, applied inside the serialized write turn by the
  autosave, Run and execute-from-step). Otherwise it would post an id the tenant
  no longer owns, and the edits it carried would never reach the server. Reopening
  the shared id later in the session redirects to the fork.
- A History-drawer restore that forked adopts the fork before reloading
  (`adoptRestoreOutcome`). Without it the restore looked like a no-op, the next
  edit hit a 409 against the fork head, and a walkthrough reload returned 404.
- "Pristine" ignores node `position` (layout is not content, ADR 0770 D4), so a
  drag alone never forks a seeded workflow. The consequence: on a still-shared
  workflow, a drag-only change is not persisted.
- `builderStore.adoptForkedWorkflow` moves the store, the pending debounced save
  and the cache to the fork, and toasts "saved to your own copy" in 4 locales.
- `BuilderTab` follows to `/builder/<fork>` without re-reading the canvas, which
  would drop edits made since the save.
- The toolbar Run (`BuilderShell`) and execute-from-step (`debugSession`) start
  the returned id.
- The chat-mention and runs-index lanes register only when the probe finds NO
  definition, so they never reach a shared id.

### Stranded projection copies (ADR 0788 § Deferred)

> **§Correction (2026-09-30, the failed deploy of #4271).** This section first
> shipped the retract as `APP_MIGRATIONS` v22. App migrations run inside
> `createApp` → `recordAppVersion` and are awaited BEFORE `listen`. In
> production the retract ran at ~0.4 rows/s over ~1,000 ownership rows, because
> `hasJobForWorkflow` did a full scan of every tenant's scheduler jobs **per
> row**. That outlasted Cloud Run's 4-minute startup probe: the revision never
> became Ready, the deploy was rolled back, and the migration was left partially
> applied (`wf.seed.notebooks-mcp-list` owners 324 → ~55; its completion log
> line never appeared).
>
> The fix (`fix/adr0789-v22-boot`):
> - v22 is a **no-op marker**. The number is kept so a host that recorded it
>   never re-runs a renumbered successor.
> - The retract is the first **`BACKGROUND_APP_JOBS`** entry. It is started by
>   `startBackgroundAppJobs` from the `listen` callback in `main()`, never from
>   `createApp`, so no readiness probe waits on it.
> - It is batched (yields the event loop every 50 rows).
> - It is idempotent over a partial state, because a retracted row no longer
>   matches. A killed instance or two instances at once only finish the job.
> - It records the durable marker `app_bg_job:internal-seed-retract = done` only
>   after a run with zero failures.
> - It loads the scheduler jobs **once** into a set.
>
> Witness: `adr0789-background-retract.test.ts`. Its boot leg is
> sabotage-proven (re-running the retract inside v22 reds it). So is its
> constant-scans leg (restoring the per-row job scan reds it).
>
> **The same in-boot risk remains for every OTHER app migration.** Each is
> awaited before `listen`, and v16 (row-driven reseed), v19 (CRM re-tenant) and
> v20 (user backfill) all scale with data. Production is past all of them
> (counter 21), so they cannot bite a redeploy. They can bite a white-label
> install that upgrades several versions over a large database. New
> data-proportional one-shots belong in `BACKGROUND_APP_JOBS`; a ratchet
> enforcing that is an open question below.

`APP_MIGRATIONS` v22 `retract-internal-seed-ownership` removes the `wf.seed.*`
OWNERSHIP rows of chains that are now `internal` (the four zero-config MCP
projection chains). It never touches the definition or the revisions, so replay
holds. A tenant keeps its row when either:

- it authored a revision whose content is not the pristine seed (it edited it),
  or
- a schedule of its own fires the workflow.

It is idempotent, and per-row failures are counted. A population of zero is
logged as an error, because it means the chain corpus did not load (the
migration-14 lesson).

## Alternatives weighed

- **Per-tenant seeded ids** (`wf.seed.<chain>.<tenant>`). This isolates by
  construction, but it registers ~50 definitions for EVERY seeded tenant,
  including every anonymous session. It also needs a migration that re-keys
  every existing tenant's ownership, and it strands replay stamps (ADR 0596 R2).
  Copy-on-write pays only when a tenant actually edits.
- **Refuse writes (409, "duplicate it to edit").** This is the smallest diff, but
  it breaks editing seeded workflows, which is the first thing the demo invites a
  visitor to do, and it turns every autosave into a failure banner.
- **Deterministic fork id per (tenant, shared id).** This converges two tabs'
  concurrent first saves on one fork. It was rejected because the id is derivable
  from a tenant id, so another tenant could pre-register it. The two-tab race
  yields two forks, which is visible and harmless.

## Consequences and residuals

- The AI-author door refuses a shared id instead of forking. Its CAS and
  lifecycle contract (ADR 0595/0773) is written around a stable id, and a typed
  refusal is honest to the model, which re-authors under a new id.
- **Prod may already hold tenant-edited shared definitions** written before this
  fix. The fix stops new writes but does not restore old ones. That needs a
  read-only prod query (revisions of `wf.seed.%` / `openwop-app.authored.%` /
  seeded walkthroughs whose content differs from the pristine seed, grouped by
  tenant), run by ce. Any restore is destructive to shared state and needs the
  user's approval. It is tracked as an open question, not done here.
- A stale tab of a tenant that already forked saves through the fork lane: it is
  judged against the fork head (`If-Match`) and merged against it
  (`preserveDroppedFields`). It also re-runs all 13 fork hooks on every such
  save, including the `connections:inbound` full scan. That path is rare (a tab
  left open across a fork), so the extra work is accepted and not optimised.

## Production evidence (read-only, via openwop-app-ce, 2026-09-30)

The defect was live, but no tenant is known to have used it. Nothing needs
restoring.

- **Revisions:** 84 shared ids, all with live definitions.
  - 77 are unchanged since their first revision.
  - 68 "late" first revisions all fall inside one 2.5 s host backfill
    (2026-08-07 03:04Z), not in a tenant action.
  - 0 revisions carry `createdBy`. That alone proves nothing: the POST lane sets
    it only for signed-in sessions, and an anon edit would not.
  - The real signal is that a tenant content edit always writes a
    content-addressed revision row under the editor's tenant. None exists that
    is not accounted for below.
- **Two ids with 2 hashes:** `wf.seed.feedback-triage-classify-and-route` and
  `wf.seed.walkthrough-inbox-notifications`.
  - seq 1 is the host backfill with the older expansion.
  - seq 2 is an `anon:` visitor's SEEDER re-minting the current pristine hash
    (2026-09-29 ~19:50Z). The diff is the ADR 0498 node-id renumbering, not
    tenant content (see SEEDRM-1 below).
- **Three ids with no revision row:** `insights-anniversary-draft`,
  `kicktodo-replan` and `strategy-weekly-checkin` do not match current code. All
  three are chainVersion 1.0.0, expansion-time, minted before seeder revision
  recording (b2fe40f3c, 2026-07-28). Their packs are now at 1.2.1 / 1.0.2 /
  1.1.1, so this is benign expansion drift, not an edit.
  - The two `openwop-app.authored.*` ids match the showcase source exactly.
- **DELETE:** 0 requests on shared ids in 30 days of request logs. The deletion
  cascade would have reset revision history, and none of the late first
  revisions fits that pattern.

## Residuals

- **`SEEDRM-1` — the seeder is not strictly insert-only.**
  - `getRegisteredWorkflowAsync` (`workflowsRegistry.ts:121-138`) returns `null`
    for a storage read ERROR, the same as for "absent". A transient read failure
    (for example, pool starvation) therefore makes `seedZeroConfigWorkflows`
    re-expand and blind-overwrite an existing shared row. Prod shows it
    happened (the two ids above).
  - **Decision:** a seeder may only ever write the PRISTINE pack expansion. It
    already can write nothing else, because `def` is built solely from
    `expandChain(chain, {deferred: true})`, so tenant content is never at risk.
    It must also never OVERWRITE. Even pristine content re-rolls node ids (the
    RI-1 hazard) under runs of other tenants, which replay only through their
    revision pin.
  - **Fix, owed as a follow-up (code, not in this PR):** register insert-only
    (`kvCompareAndSwap(key, null, value)` / a `registerWorkflowIfAbsent`), and
    distinguish "absent" from "read failed" so the seeder skips on error. Witness:
    a seed over an existing row with an injected read error leaves the row
    byte-identical.

## Open questions

- [x] Prod audit of already-edited shared definitions: done, no restore needed
  (§ Production evidence).
- [ ] A ratchet that refuses a new data-proportional `APP_MIGRATIONS` entry
  (steering it to `BACKGROUND_APP_JOBS`), plus bounding the existing
  v16/v19/v20 for multi-version white-label upgrades.
- [ ] Whether to re-point sub-workflow references in tenant-owned parents.
- [x] Retrying failed fork hooks: done by `repointPending` plus a retry on the
  fork's next save. A fork that is never saved again keeps its pending list; an
  operator sweep over `repointPending` rows would close that remainder.

## Implementation record

| Phase | What | Witness |
|---|---|---|
| 1 | predicate + guard + fork + verbs + hooks + seeders + migration v22 + frontend adoption | `backend/typescript/test/seeded-workflow-tenant-isolation.test.ts`, `frontend/react/src/builder/__tests__/adr0789ForkAdoption.test.tsx` |
| 1b | re-grade (B+, no Blockers): promote starts from the ownership-archive view (sabotage-proven), History restore adopts the fork, position ignored for "pristine", stale-tab merge against the fork head | `PROMOTE of an archived seeded workflow` leg; `History restore` + `drag alone` frontend legs |
| 1a | grade pass: exact walkthrough ids (B1), the pristine marker (B2), no shared-row delete on teardown or clear (B3), queued-save alias (I1), published pin carried (I2), persisted and retried re-points (I3), CAS fork claim (I4), promote from the ownership archive plus rollback no-op (I5), migration hardening (I6), fork `If-Match` | same witnesses, 22 + 6 legs |

**Proof of the defect before the fix.** A trimmed four-leg witness (save leak,
DELETE plus revision cascade, archive, pre-squat) was run on a detached
`origin/main` worktree at `2273db9c6`: 4 of 4 failed. **Sabotage.** Making the
predicate always false reds 10 of 14 legs, un-registering the scheduler hook reds
3, and removing the builder's adoption reds 3 frontend legs.
