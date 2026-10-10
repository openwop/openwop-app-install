# ADR 0846 — Dashboard tile read exits: a tile may never show more than its source's own read

Status: implemented (2026-10-07, branch `feat/fl2-28-dashboard`)

Feature loop round 2, row 28 (Editable dashboard, home at `/`). Extends ADR 0375 (editable
dashboard) and ADR 0377 (widget catalog). Composes ADR 0125/0202 (scheduled agent chats),
ADR 0272 P4 (CRM record visibility), ADR 0210 §3 (the pipeline report), the BI metric
catalog, ADR 0745 (key-lane scope narrowing) and the SHELL-8 `requestCache` auth reset.
No new feature, toggle, pack or wire field. Host-extension only, so no RFC.

## Context

The dashboard owns no data (ADR 0082). Each of its 52 tiles projects an existing feature's
read. That makes the home page the one surface that calls every feature's read exits at once.
It is only as tight as the loosest exit it calls. The row-28 `/grade-workflows` pass traced
every tile to its route, then compared that route with the owning feature's PRIMARY read
predicate (the one its own list page uses) and with the node-surface and agent-tool lanes that
reach the same rows. 46 tiles are clean: they call the primary route, or a route with the same
predicate. Six exits are looser. All six are reachable from a default dashboard tile by a
signed-in member.

| # | Exit | Tile(s) | What is looser | Evidence |
|---|---|---|---|---|
| E1 | `GET/…/:chatId/pause/DELETE /scheduled-chats/orgs/:orgId/chats` | ScheduledAgents, UpcomingAgenda, AiBriefing picker | Returns every org schedule's `prompt` + `conversationId` to any `workspace:read` member. Pause/delete accept any `workspace:write` member. CREATE already requires the caller to SEE the conversation (`isVisibleToAsync`, `routes.ts:69-72`). Read and manage never re-check it. | `features/scheduled-agent-chats/routes.ts:47-100` |
| E2 | `POST /bi/orgs/:orgId/metrics/:id/run` and the `bi.run-metric` agent tool | BiMetric (`sys-pipeline-value`, workspace tier) | Sums every `crm.deal` row in the org. The CRM's own deal list filters per viewer through `filterVisibleCrmRecords` (territories). | `features/bi/biService.ts:194-196,248`, `features/bi/routes.ts:96-100`, vs `features/crm/entities/deals.ts:242-257` |
| E3 | `buildBiSurface().runMetric` (workflow node lane) | — (same data as E2) | No org-membership check and no viewer. An empty `orgId` means "no org filter". The agent-tool twin closed exactly this as `BI-SCOPE-1` (`agentTools.ts:84-87`). | `features/bi/surface.ts:45` |
| E4 | `GET /crm/orgs/:orgId/reports/pipeline` | PipelineTrend, CrmPipeline | `perStage`/`totals`/`aging` are viewer-filtered. `snapshots` (org-wide weekly per-stage sums, written by a viewer-less daemon) and `conversions` (every deal's stage history) are not. | `features/crm/reportService.ts:52,107-118` |
| E5 | `features/dashboard/sharedRead.ts`, `useDashboardOrg.ts` | 10 tiles (`crm-pipeline`, `bi-metric`, `usage-rollup`, `ad-kpi`, `funnel-first`, `csm-accounts`) | Module-level caches with no auth-change reset. Sign-out does not reload the page (`useAuth.ts:106`), so the next account to sign in on that tab is served the previous account's viewer-scoped reads for up to 30 s, and the org id is never re-resolved until a reload. The app's own `requestCache` resets on `onAuthChange` (`client/requestCache.ts:37`); these two caches were built beside it. | `sharedRead.ts:20-40`, `useDashboardOrg.ts:20-32` |
| E6 | `GET /host/openwop-app/fleet/activity`, `GET /v1/host/openwop-app/roster/:id/activity` | AgentFleet | Run activity (status, workflow, timing) with no `runs:read` check, so an `owk_` key narrowed away from `runs:read` reads it. With enforcement on, so does a member whose role lacks it. `GET /runs` requires `runs:read` (`routes/runs.ts:856`). | `routes/agentOps.ts:288-323` |

The dashboard's own three rows (layout, note, briefing pointer) re-measured clean. They are
keyed `${tenantId}:${subject}` from the session and never from the request. The default layout
is derived client-side and is never written, so re-runs cannot duplicate it.

## Decision

**A tile may never show more than its source's own primary read would show the same viewer.**
Each fix sits at the exit every caller shares, never in the tile, so the route, the agent tool
and the workflow surface stay one predicate.

### D1 — Scheduled chats: management follows the conversation

One predicate in `scheduledChatService.ts`:

```ts
export async function canSeeScheduledChat(tenantId: string, chat: ScheduledChat, caller: { userId?: string; principal?: string }): Promise<boolean>
//   = isVisibleToAsync(await getConversationMeta(tenantId, chat.conversationId), tenantId, caller.userId, caller.principal)
```

- **The caller is `req.userId ?? req.principal?.principalId`** — the spelling the chat routes
  pass to this same predicate (`actingUserOf`, `routes/chatSessions.ts:84-86`) and the one a
  conversation's `ownerUserId` is stamped in. NOT `authorizeOrgScope`'s canonical `user.userId`:
  on a personal-tenant bearer lane that is a different key (the two-identity-keys trap), and the
  predicate would hide an owner's own schedules. CREATE (`routes.ts:69-72`) moves to the same
  spelling in this change, so a caller can create exactly what they can later see and manage.
  *(Architect pass correction A1 — the first draft named no spelling.)*
- Meta reads are point lookups (`getConversationMeta`) in `Promise.all`; an org's schedules are
  a small, prefix-scoped set (`SCHED-3`), so no tenant-wide meta scan is added.
- `GET …/chats` filters the list through it. `GET …/:chatId`, `POST …/pause` and
  `DELETE …/:chatId` answer **404** for a row the caller cannot see (the same response as a
  missing row, so there is no existence oracle). The predicate is the one CREATE already uses,
  so a caller can now manage exactly what they could have created.
- An unowned, legacy or absent conversation is tenant-visible under the `isVisibleTo` contract,
  so those rows stay listed. That is unchanged and intended.
- The CHANNEL scope is untouched. There, `conversationId` is forced to the channel and reads are
  member-gated (`getChannel`).
- The scheduler's fire path is untouched. It runs as the creator, who passed the check at create.

### D1b — the scheduler's generic door holds the same line *(added after the grade-code pass)*

> **Correction 2026-10-07 (grade-code `DSHCD-2`, a Blocker in this ADR's own first cut).** D1
> gated the feature's routes and missed the core ones: a scheduled chat is ALSO a scheduler job,
> with no owner Subject, so `routes/scheduler.ts` `jobGateFor` gave any member `read` (the list
> carries `configurable.prompt`) and any writer `write` — pause, delete, and **trigger**, which
> fires an agent turn into the private conversation. A fresh reviewer runtime-witnessed it.

`host/scheduledJobReadGates.ts` is a narrowing-only registry keyed on `job.metadata.kind`.
`jobGateFor` consults it before every arm; `false` ⇒ `none` (the scheduler's uniform 404). The
feature registers `canSeeScheduledChat` for `'scheduled-agent-chat'` at module load, the
`registerSubjectEraser` shape (core cannot import a feature). A gate never grants.

### D2 — BI: the metric exit takes a viewer, and CRM types are filtered by it

- `runMetric(tenantId, metricId, params, viewer)` gains a **required** `viewer: string | undefined`
  argument. `undefined` means a system read, matching `filterVisibleCrmRecords`. Because the
  argument is required, a new caller cannot compile without deciding who it reads as; it cannot
  silently default to tenant-wide.
- After org scoping, rows of the system types `crm.deal` and `crm.company` go through a new host
  helper, `filterVisibleCrmKernelRows` (`host/crmRecordVisibility.ts`). It unwraps the kernel SoT
  (`ext.deal`/`ext.company`), groups by `org_id`, and asks the registered resolver per org, so the
  territories resolver sees the record shape it already reads. Other entity types are unchanged:
  they carry no row-level read ACL today.
- **The row filter is a closed, exhaustive table**, not an `if` on two type names:
  `KERNEL_METRIC_ROW_FILTER: { [T in KernelMetricType]: 'crm-visibility' | 'org-only' }` in
  `metricTypes.ts`, beside `KERNEL_METRIC_TYPES`. Today `crm.deal`/`crm.company` are
  `crm-visibility`; `commerce.product`, `cms.page` and `servicedesk.ticket` are `org-only`,
  because each of those features' own list reads is org-scoped with no row ACL
  (`service-desk/tickets.ts:219-223` and the CMS/commerce list routes). Adding a type to the
  allowlist without deciding its filter is a **compile error**. That is the ratchet; a later
  row ACL on any of them must change its entry. *(Architect pass correction A2 — the first
  draft special-cased two names, so the next metric-enabled type would have defaulted open.)*
- *Correction (grade-code M2/L2):* the helper no longer hard-codes CRM's kernel layout. CRM
  registers a projection per kernel type (`registerCrmKernelProjection`, in `deals.ts` /
  `companies.ts`) that returns the domain record its own list hands the resolver — including
  `projectDeal`'s `status` defaulting, which the raw `ext.deal` lacked and which a territory rule
  on `status` would have matched differently.
- *Correction (grade-code H1):* `totalRows` counts the caller's rows after org + visibility
  filtering; the old pre-filter count leaked the tenant-wide row count. Truncation is a separate
  `truncated` flag.
- Callers: the route passes `user.userId`, the same spelling the CRM's own routes pass as the
  viewer (`crm/orgRoutes.ts:386,515`). The agent tool passes `scope.actingUserId` (it already
  refuses when that is absent). The workflow surface follows D3.

### D3 — BI workflow surface: same org gate as its siblings

`buildBiSurface().runMetric` requires a non-empty `orgId`, calls
`assertRunScopeOrg(scope, orgId, 'workspace:read')` (the `MEDWF-2` pattern), and passes
`scope.actingUserId ?? scope.orgScopeSubject` as the viewer — *correction (grade-code M1)*: a run
a person CAUSED but that acts for no one (a kanban Run, a channel post) reads as that person;
`orgScopeSubject` narrows, never grants. An actorless run stays tenant-trusted, which is the standing
`assertRunScopeOrg` contract and is not changed here.

### D4 — CRM pipeline report: a scoped viewer gets no org-wide history

`computePipelineReport` already loads the pipeline's deals for the viewer. When a viewer is
present and the CRM visibility resolver is active, it also loads them without the viewer.
If the viewer's set is smaller, the viewer is **scoped**, and then:

- `conversions` are counted only over stage-history rows whose `dealId` is in the visible set;
- `snapshots` are returned **empty**, with a new optional `snapshotsWithheld: true`. Snapshots
  are pre-aggregated org-wide by a viewer-less daemon, so a per-viewer slice cannot be derived
  from them.

An unscoped viewer (view-all, territories off, or one who sees every deal) gets the report
byte-for-byte as before. `PipelineTrendTile` renders an honest "trend is org-wide; ask an admin"
state on `snapshotsWithheld` instead of "no history yet".

### D5 — Dashboard client caches reset on auth change

- `sharedRead` becomes a thin call into `cachedRead` (`client/requestCache.ts`). That is the one
  coalesce cache, and it already clears on `onAuthChange` and refuses to cache a load that was
  in flight across the change (generation guard). The parallel cache is deleted, not patched.
- `useDashboardOrg` clears its memo on `onAuthChange`, with the same generation guard, so a
  resolve that started under the old identity cannot repopulate it.

Mounted state is not a second carrier: a signed-out `/` renders the public home (ADR 0487,
`useAuth.ts:106-109`), so the grid unmounts on sign-out and the next account's tiles mount
fresh and read through the reset caches.

### D6 — Agent activity reads require `runs:read`

`fleet/activity` and `roster/:rosterId/activity` call `requireProtocolScope(req, 'runs:read')`
first, the same gate as `GET /runs`. The tile already handles a 403 as its error state.

## Architect pass (adversarial, before code) — 2026-10-07

Corrections folded into the decisions above: **A1** (D1 named no identity spelling; the
canonical `user.userId` would have hidden owners' own rows on bearer lanes, so it is now the
chat routes' `req.userId ?? principalId`, CREATE included) and **A2** (D2 special-cased two
type names; it is now an exhaustive mapped type over `KERNEL_METRIC_TYPES`). Checked and held:
BI is the only reader of CRM kernel rows outside CRM (`listSystemEntities` callers; the
generic entities routes refuse system types, `entities/routes.ts:153,193,217`), so D2 closes the
class. `listAgentRunActivity` has exactly the two D6 callers. The BI run-metric node already
documents `orgId` as an input (`packs/feature.bi.nodes/pack.json:41`), so D3's refusal of an
empty org changes behaviour, not the pack contract; no pack bump. The CRM run surface already
uses `scope.actingUserId` as its viewer (`crm/surface.ts:128-132`), so D3 matches it.

## Witnesses (each proven RED on `origin/main`, then sabotage-witnessed)

- E1: a member who cannot see a private conversation gets that schedule absent from the list, and
  404 from get/pause/delete; the owner still sees and manages it; a legacy unowned conversation
  stays listed.
- E2/E3: with a territory-scoped viewer, `sys-pipeline-value` excludes an out-of-territory deal on
  the route and the tool lanes; the surface refuses a foreign org and an empty org.
- E4: a scoped viewer gets `snapshots: []` + `snapshotsWithheld` and conversions limited to visible
  deals; a view-all viewer's report is unchanged.
- E5: `sharedRead` serves nothing across `fireAuthChanged()`, and a pre-change in-flight load does
  not repopulate it; the org memo re-resolves after the change.
- E6: a key narrowed to `workflows:read` gets 403 from both activity routes; an unnarrowed caller
  gets 200.

## Alternatives weighed

- **Fix in the tiles** (hide the prompt in the tile, drop snapshots client-side): rejected. The
  data still leaves the server, and the feature's own page and the agent tool keep the hole.
  Guard at the exit.
- **E1: admins keep seeing every schedule, with the prompt redacted, so they can stop a runaway
  one.** Deferred as a product decision. Today's fix hides the row entirely. A runaway schedule
  is still stopped by the conversation owner, by deleting the agent (which cascades through
  `deleteScheduledChatsForAgent`), or by the toggle.
- **E2: give BI a viewer filter for every entity type.** Rejected for now. No other kernel type
  has a row-level read ACL to honour, and inventing one is not BI's call.
- **E4: rebuild per-viewer snapshots.** Rejected. It means a per-viewer daemon write, or a replay
  of stage history per request. Withholding the field is honest and cheap.
- **E5: `window.location.reload()` on sign-out.** Rejected. It would hide the bug rather than
  fix the cache. The SHELL-8 work is removing reloads, not adding them.

## Matrix (feature-refinement)

Feature-package: edits in `scheduled-agent-chats`, `bi`, `crm`, core `agentOps` and
`features/dashboard` (FE), plus one host helper. No new imports between features (BI reaches
CRM visibility only through the host seam). Toggle: none new; the dashboard has no toggle. Node
pack / agent pack / envelopes: none new; the BI surface and tool change behaviour, not shape.
Public surface: none. RBAC: the subject of the ADR. Replay: reads only; the BI surface viewer is
the run-stamped `actingUserId`, so a fork re-reads as the same principal. Frontend: one tile
state (D4), two cache modules (D5). RFC verdict: host-extension only, no RFC.

## Phased plan

Implementing commits are cited by subject (a rebase moves shas):

| Phase | Scope | Commit (subject) | Witness |
|---|---|---|---|
| P1 | D1 scheduled-chat predicate + 4 route exits | `fix(dashboard): tile read exits honour their source's own read` | `test/adr0846-dashboard-tile-read-exits.test.ts` D1 |
| P1b | D1b scheduler generic door (grade-code `DSHCD-2`) | `fix(dashboard): close the grade-code findings on ADR 0846` | same test, scheduler legs |
| P2 | D2/D3 BI viewer, closed row-filter table, CRM kernel projection, surface org gate, `totalRows` | both commits above | same test, D2/D3 legs; `bi-metrics.test.ts` |
| P3 | D4 report scoping + withheld UI | first commit + `fix(dashboard): tile caches reset on auth change; withheld pipeline trend state` | same test, D4 leg; `pipelineTrendCurrency.test.tsx` |
| P4 | D5 cache reset (FE) + D6 `runs:read` | the two `fix(dashboard)` commits above | `authChangeReset.test.tsx`; `test/adr0846-agent-activity-scope.test.ts` |

Every guard was proven RED on `origin/main` `f8a3ea22e` and sabotage-witnessed (the guarded file
restored to `main`, or the single guard line removed, turns its leg red).

## Open questions

1. E1 admin redacted view: a product call for the user (see Alternatives).
2. E4 edge: a scoped viewer who currently sees every deal on the pipeline still gets org-wide
   history, which may include deals that have since been deleted or reassigned. That is accepted
   and documented, because the alternative (withholding from every territory-scoped role) needs
   the territories feature's role model inside CRM.
3. Peer PR #4498 (the home-hierarchy redesign) adds `NeedsYou`/`RunHealth`/`RunActivity` tiles over runs, approvals
   and connections. They must be re-traced after it merges; this ADR does not grade them.
