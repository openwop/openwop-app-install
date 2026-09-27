# Dashboard + Navigation-settings (unit H3) — chat-first port review

**Scope (single-feature / multi-package mode):** backend `features/dashboard`,
`features/navigation-settings`; frontend `features/dashboard`,
`features/navigation-settings`. Context: ADR 0375 (always-on editable dashboard
HOME at `/`), ADR 0377 (46-tile widget catalog), ADR 0139 (configurable nav menu).

## TL;DR verdict

**This unit already rides the engine and is legitimately page-shaped — there is
nothing to port and nothing to demolish.** Both features are *read / preference*
surfaces: the dashboard composes 51 tiles that are each a compact **projection
over an existing feature's client** (ADR 0082 — no parallel store), and
navigation-settings is a sparse **overlay editor** over the declared nav. Neither
feature declares a workflow, node pack, agent pack, or RFC 0021 envelope — and
`dashboard/feature.ts:15-17` + `navigation-settings/feature.ts:5` say so
**honestly** ("NO workflow surface / node pack / agent pack / envelopes — a
dashboard is a read/preference surface, not a workflow actor"). That honest
non-claim is the opposite of theater: no declared orchestration means no missing
igniter to flag.

The one thing worth naming is an **optional additive enhancement** (not a
blocker, not a demolition): a user *describing* a layout/nav change ("add the CRM
pipeline tile and make it wide", "hide Billing from my rail, rename Platform to
Admin") is intent-shaped and could be driven by two thin agent tools that share
the existing routes' predicates. It is deferred-honestly below — these are
preference surfaces where direct manipulation is arguably *better* than describing
intent, so the ROI is low.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Dashboard home grid — compose registry ∩ toggle ∩ tier ∩ enabled, render (`DashboardPage.tsx:53-59`, `resolveTiles.ts:33-52`) | Page (tile grid) | **PAGE-LEGIT** | Keep. Read-only composition; honesty loop closes per tile. |
| Per-tile data reads — 50 of 51 tiles project over an owning feature's client via `useTileData`/`useOrgResource`/`sharedRead` (e.g. `ActiveRunsTile.tsx:21` → `listMyRuns`; `SuggestedAutomationsTile.tsx:15` → `listSuggestions`) | Projection | **RIDES** | Leave alone. Owns no data (ADR 0082). Approvals/notifications/schedules tiles ride their real owners' clients, not shadow stores. |
| Customize layout — reorder/resize/enable/remove + add-picker, keyboard-operable (`DashboardPage.tsx:94-113`, `DashboardTileCard.tsx:39-50`) | Bespoke edit UI | **PAGE-LEGIT** | Keep. Structural direct-manipulation of a *personal preference*; not a canvas-worthy document, not intent-described. |
| Layout persistence — self-scoped `GET/PUT …/dashboard/layout`, `DurableCollection` keyed `${tenantId}:${subject}`, subject eraser wired (`dashboardService.ts:45-99`, `routes.ts:67-89`) | REST + durable row | **RIDES** | Leave. Instantiates the durable-collection + `registerSubjectEraser` owners; IDOR-safe (key from session, `routes.ts:25-31`). |
| Personal-note tile — dashboard-owned content, separate subject-scoped row, capped, eraser-covered (`dashboardService.ts:61-99`) | Sticky note | **PAGE-LEGIT** | Keep. The one piece of owned content; deliberately its own row to avoid the layout-PUT clobber race (`dashboardService.ts:61-66`). |
| Nav menu bundle read — `GET …/menu-config` returns `{tenant,user}`, open to any authenticated principal, anon gets own empty layer (`nav routes.ts:39-57`) | Page/provider read | **PAGE-LEGIT** | Keep. Presentation preference, read on every paint; ETag exposed for CHN-6 concurrency. |
| User nav personalization editor — `MenuSettingsPage` scope=`user`, sparse item/header overrides (`MenuSettingsPage.tsx:120-168`, `PUT …/menu-config/me`) | Bespoke settings page | **PAGE-LEGIT** | Keep. Structural preference editing; fully keyboard-accessible controls. |
| Tenant nav default editor — scope=`tenant`, superadmin-gated + `If-Match`/CAS optimistic concurrency (`nav routes.ts:59-76`, `service.ts:184-201`) | Superadmin settings | **RIDES** | Leave. Rides `requireSuperadmin` + `compareAndSwap` owners; 409 on stale/racing edit (no silent clobber). |
| Header CRUD + item placement/visibility overrides (`MenuSettingsPage.tsx:134-168`, `service.ts:validateMenuConfig`) | Bespoke controls | **PAGE-LEGIT** | Keep. Sparse overlay, validated closed-world server-side (`service.ts:86-154`). |

**Counts: RIDES=3, ADAPTER=0, PARALLEL=0, THEATER=0, PAGE-LEGIT=6.**

---

## Contract scouting (pinned)

- **No orchestration is declared, so none is missing.** `dashboard/feature.ts:23-28`
  and `navigation-settings/feature.ts:12-18` register routes only — no `surface`,
  no `requiredPacks`, no `toggleDefault`. Grep for
  `startWorkflowRun|registerFeatureAgentTool|WorkflowDefinition|agentProfile` in
  both backend packages returns **only comment lines** in `dashboard/feature.ts`.
  Nothing to ignite.
- **Cross-cutting node-typeId drop pattern — N/A here, stated explicitly.** Neither
  feature contributes node packs, so there are no dashboard/nav node typeIds for
  any agent's `toolAllowlist` to reference. No agent can be silently dropped at
  dispatch on account of this unit. (The pattern the lead flagged applies to
  features that *do* declare nodes; H3 declares none.)
- **Honesty loops close by construction.** Every tile funnels through
  `useTileData` (`useTileData.ts:22-31`) or `useOrgResource` collapsing to
  `loading | error | ready` with a designed empty state, over a **real client
  import** — verified for all 51 tiles (`ActiveRunsTile`→`runsClient`,
  `ApprovalsInboxTile`→`approvalsClient`, `NotificationsTile`→`notificationsClient`,
  `CrmPipelineTile`→`crmReportsClient`, … through `KickTodo*`→`kicktodoClient`).
  The sole data-free tile, `QuickCreateTile.tsx:1-6`, is honestly documented
  "ZERO data calls" — static in-app `<Link>`s, not a painted stat.
- **`sharedRead` is a de-dupe memo, not a store** (`sharedRead.ts:22-40`): paired
  tiles (crm-pipeline + pipeline-trend; csm-health + health-distribution) share
  one in-flight promise with a 30s TTL. No parallel data ownership.
- **Owner instantiation, not shadowing:** layout/note persistence uses the shared
  `DurableCollection` + `registerSubjectEraser` seams (`dashboardService.ts:20-21,
  45, 77, 99`); tenant nav writes use `requireSuperadmin` + `store.compareAndSwap`
  (`nav routes.ts:61`, `service.ts:196`). No second approvals/notifications/
  schedule store anywhere — those concepts appear only as read projections.

### Port tests — where they bite (all pass)

- **Interface test:** every capability here is *reading* (→ page/projection) or
  *structural editing of a personal preference* (→ direct-manipulation page).
  None is *describing intent* (→ chat) or *deciding* (→ interrupt card). Correct
  shape.
- **Agency / Ignition / Composition / HITL tests:** vacuously pass — no agent, no
  workflow, no gate is declared, and none is warranted. A dashboard is not a
  workflow actor.
- **SSoT test:** tile SSoT lives in each owning feature; the dashboard holds only
  layout *intent* and re-derives the effective set every load
  (`resolveTiles.ts:36-51`), dropping ids no longer in the registry (no
  migration). Nav config is a sparse overlay validated closed-world
  (`service.ts:86-154`); tenant layer refuses stale writes with a typed 409.
- **Authority-parity test:** the layout route derives its key from the session,
  never request input (`routes.ts:25-31`) — IDOR-safe by construction, so there is
  no adjacent surface to forget. Nav `GET` is deliberately open to any
  authenticated principal (writes stay gated: `me` needs a resolved user, `tenant`
  needs superadmin). Consistent.
- **Honesty-loop test:** passes (see scouting). Every displayed state has a real
  read; "blocked on data" is nowhere painted green.
- **Lifecycle test:** the two durable rows the unit introduces (layout, note) are
  tenant+subject keyed and both covered by one idempotent eraser
  (`dashboardService.ts:94-99`); nav rows are tenant/tenant+user keyed
  (`service.ts:37-38`). Retries replace (last-writer-wins on self-owned rows;
  CAS on the shared tenant row). No duplicate minting.
- **Card-mechanism test:** N/A — this unit renders **no cards in the chat**. Tiles
  are page surfaces, not chat A2UI/interrupt/typed-renderer cards.

---

## Blockers (from scouting)

**None.** No assumption failed. The unit makes no capability claim it fails to
deliver, instantiates the owners it uses, and closes its honesty loops. There is
no primitive being shadowed and no declared orchestration lacking an igniter.

---

## Demolition list

**Empty.** Every bespoke surface in this unit is PAGE-LEGIT (read-only projection
or direct-manipulation of a personal/tenant preference) — none substitutes for a
platform primitive. The customize-mode controls and the MenuSettingsPage editor
are the *correct* shape for structural preference editing and stay.

(Existing regression coverage lives in `frontend/react/src/features/dashboard/__tests__`
— resolve/merge/persist behavior. No new pins needed since nothing is removed.)

---

## New-code inventory

**None required.** The unit is complete and correct as shipped (ADR 0375 / 0377 /
0139, all marked `implemented`). See the deferred item for the *only* optional
additive work.

---

## Phased plan

No porting phases. If — and only if — the optional chat enhancement below is ever
prioritized, it is a single additive phase (two agent tools + allowlist rows +
the existing routes' predicate reused), closing with `/code-review` + `/ux-review`.
It demolishes nothing and other consumers stay byte-for-byte unchanged.

---

## Deferred honestly

- **Optional chat-driven layout / nav arrangement (LOW priority, not a blocker).**
  A user could *describe* a change instead of clicking: "add the CRM pipeline tile
  and make it full width", or "move Billing to the Admin menu and rename Platform
  to Admin". This is genuinely intent-shaped and the sanctioned expression would be
  **two thin `registerFeatureAgentTool` action tools** — a `dashboard.arrange` tool
  writing the same self-scoped layout row the PUT route owns, and a
  `menu-config.arrange` tool writing the same overlay (`me` layer for a user;
  `tenant` layer only behind `requireSuperadmin`) — each **sharing its HTTP route's
  access predicate** (one helper, route + tool both call it) and failing *typed* on
  invalid ids, never success-with-empty. It would ride the ONE chat, no new panel.
  **Deferred because:** these are preference surfaces where direct manipulation is
  at least as good as describing intent, and the grid/editor already satisfy the
  need keyboard-accessibly. This is an *additive* nicety, not a correction — no
  existing surface is wrong. Filed here rather than built.
- **No cross-layer platform gaps found.** Nothing in this unit needs a recorded
  TODO against another layer.
