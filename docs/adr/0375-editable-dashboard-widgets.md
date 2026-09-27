# ADR 0375 — Editable dashboard with customizable widgets (feature-package `dashboard`)

Status: implemented (Phases 1–3 landed 2026-07-16, PRs #1889/#1891/#1892; Phase 4 = honest deferred-surface accounting, no build)

## Context

> **§ Correction (2026-07-16, user request):** two of this ADR's decisions were
> deliberately overturned after the catalog proved itself:
> 1. **Placement** — the dashboard is no longer a NEW `/dashboard` surface with
>    "chat stays `/`"; it graduated to the SIGNED-IN HOME at `/` and leads the
>    pinned nav cluster (Dashboard · Chat · Inbox · Agents). Chat moved to its
>    stable `/chat` URL; legacy `/?conversation=`/`?agent=` deep links (stored
>    notification actionUrls, bookmarks) redirect from `/` to `/chat`; the old
>    `/dashboard` URL redirects home.
> 2. **Toggle** — the `dashboard` feature toggle was removed (the Users/Profiles
>    graduation pattern): the home surface can't be toggle-hidden, and the
>    per-tile `owningFeatureToggle` gates already provide the meaningful feature
>    gating inside it. Routes serve unconditionally.


Port target: the **MyndHyve editable dashboard** — a per-user customizable widget
grid (`/Users/david/dev/myndhyve/src/core/dashboard/widgets/`,
`src/components/dashboard/`). Its shape:

- A build-time `DASHBOARD_WIDGET_REGISTRY: DashboardWidgetDefinition[]`
  (`src/core/dashboard/widgets/registry.ts`) — each def carries `id`, `label`,
  `description`, `icon`, `category` (Navigation | Business | Content | AI |
  Operations | Productivity), `requiredRole` (`user`|`company_admin`|`super_admin`),
  `defaultEnabled`, `defaultOrder`, `defaultSize` (`half`|`full`), a `resizable`
  flag, and a lazy `loader`. Each widget component receives `{ compact }`.
- Per-user config (which widgets are enabled, their order, their size) stored as
  part of `UserSettings` (`settingsStore`, direct Firestore sync).
- Role-filtered visibility (`requiredRole`); a settings panel toggles / reorders /
  resizes widgets.

openwop today has **no** customizable widget-grid home. `/` is deliberately the AI
chat (`ChatTab`, the eager home route — `chrome/features.tsx:100`). Feature-specific
KPI *projections* exist (campaign-intel, the usage dashboard of ADR 0118) but each is
owned by its feature, not a composition home. **ADR 0082 is a standing law here:**
insights-suite deliberately ships **no dashboard and no parallel store** — results
surface through runs / notifications. Any dashboard we add must honor that: a pure
projection surface, never a new analytics store.

**Product decisions (maintainer, 2026-07-15):**
1. **Placement — a new `/dashboard` nav surface; chat stays `/`.** Additive and
   lowest-risk; the dashboard is a hub the user opts into, not the landing.
2. **Widget catalog — both families, role-tiered.** Default-enable a *work-hub* set
   for everyone; gate *business-metrics* widgets behind role **and** their owning
   feature's toggle (they light up only where the workspace has the feature and the
   user has the role). Faithful to MyndHyve's role-filtered registry.

## Boundaries & pre-existing-surface audit (MANDATORY)

1. **Route namespace.** No `/v1/host/openwop-app/dashboard/*` is registered
   (`grep` clean). The FE route `/dashboard` is free (`/boards` is the kanban
   surface; `/` and `/chat` are ChatTab). No collision.
2. **Concept duplication — the naming trap.** `src/features/widgets.ts` is the
   env-gated **"Widgets" reference DOMAIN example** (`OPENWOP_EXAMPLE_WIDGETS_ENABLED`,
   FEATURES.md § "Widgets is the env-gated reference *example*, not a product
   feature") — a sample of the `BackendFeature` contract, **not** dashboard widgets.
   No route or store collision, but a *naming-clarity* risk: two unrelated "widget"
   concepts. **Correction:** this feature's concept is a **"dashboard tile"**
   (registry `dashboardWidgetRegistry`, routes under `…/dashboard/*`); keep the
   reference example's "widgets" domain untouched and name-disjoint. Call this out so
   no future reader conflates them.
3. **Existing "dashboards" are feature-specific, not this.** campaign-intel / usage
   (0118) are projections *owned by* their features. The editable dashboard
   **composes over** them (and others); it never forks their data or re-owns their
   reads. It creates **no** widget data of its own — honoring ADR 0082.
4. **Helper reuse.** `featureRoute` (`authorizeOrgScope`, `requireFeatureEnabled`),
   `DurableCollection` (layout persistence), the **menu registry**
   (`chrome/features.tsx` + `featureTypes.ts`) for the nav entry, the **resolver-
   registry pattern** (Sharing, ADR 0013) as the template for the widget-registration
   seam, and the rate-limit fan-out guard (`middleware/rateLimit.ts`) as a design
   constraint (see Open Questions). Reuse over reinvent.

## Decision

Ship `dashboard` as a **self-contained feature-package** (ADR 0001): a
**per-(user, workspace)** customizable **dashboard-tile grid** at a new `/dashboard`
nav surface. The feature **owns** layout persistence + the grid/customization UI + the
tile-registration seam. It **owns no tile data** — every tile is a compact
**projection over an existing feature's client/route** (composition, ADR 0082).

### The registration-seam correction (the headline "port, not clone" fix)

MyndHyve's `DASHBOARD_WIDGET_REGISTRY` hard-imports every widget component
(`core/dashboard → components/dashboard/widgets/*`) — **core depends *up* into
features**, which ADR 0001's import boundary forbids here (*features may import core;
core must never import a feature*). **Invert it into a registration seam**, exactly as
`registerBackendFeatures` / `registerFeatureAgentTool` / the menu registry do:

- A neutral module `chat`-independent of any feature — `dashboard/tileRegistry.ts` —
  exposes `registerDashboardTile(def)`. The FE is where tiles live (each is a React
  component reading a feature client), so the registry is FE-side.
- **Each contributing feature registers its own tile(s)** from its feature module (the
  same place it registers its route + nav), passing a `DashboardTileDef`. The core
  dashboard **reads** the registry and never imports a feature. Adding a new tile =
  one feature-local registration call; **zero edits to core dashboard code**.

### Data model

- `DashboardTileDef` (FE registry, build-time):
  `{ id, label, description, icon (ui/icons), category ('Work'|'Business'|'Content'|
  'AI'|'Operations'), requiredRole ('member'|'admin'|'owner'), owningFeatureToggle?
  (the feature-toggle id that gates this tile; absent ⇒ always available),
  defaultEnabled, defaultOrder, defaultSize ('half'|'full'), resizable, loader (lazy
  component) }`. The component receives `{ compact }` and renders its own
  loading/empty/error states.
- `DashboardLayout` (durable, per user × workspace): `{ tenantId, subject,
  tiles: Array<{ id, order, size, enabled }>, updatedAt }`, keyed
  `dashboardlayout:${tenantId}:${subject}` in a `DurableCollection`. **Absent ⇒ the
  effective layout is *derived* from the registry defaults** (`defaultEnabled` /
  `defaultOrder` / `defaultSize`), so a fresh user gets a sensible dashboard with
  **zero writes** (first paint never blocks on a persisted record).
- **Effective tile list** = registry ∩ (owningFeatureToggle ON for the tenant) ∩
  (user role ≥ requiredRole) ∩ (layout.enabled), ordered by `layout.order`
  (fallback `defaultOrder`), sized by `layout.size` (fallback `defaultSize`). A stored
  layout referencing a **retired** tile id is inert (the intersection drops it — no
  error, no migration). A tile whose owning feature is toggled OFF, or whose read
  errors, is **omitted or shows a designed empty/disabled state** — never a leak,
  never a crash.

### Why per-(user, workspace), not per-user-global

Which tiles are *available* depends on the workspace's enabled features **and** the
user's role in *that* workspace (ADR 0015 workspace-as-tenant). A user in two
workspaces gets a different available set in each, so the saved layout must be keyed
by `(subject, tenantId)`. (MyndHyve's per-user `UserSettings` is a single-tenant
assumption we deliberately correct.)

## Phased plan

**Phase 1 — persistence + REST (backend).**
`src/features/dashboard/` — `dashboardService` (layout get/put, self-scoped by the
authenticated subject), `routes.ts` (`GET`/`PUT /v1/host/openwop-app/dashboard/layout`,
toggle-gated), `feature.ts` (appended to `BACKEND_FEATURES`). `DurableCollection`.
Route-level tests: self-scope IDOR (a caller can only read/write *their own*
(subject,tenant) layout — the key is derived from the session, never request input),
toggle gate (403 when `dashboard` OFF), default-derivation when absent.

**Phase 2 — FE registry + grid + customization.**
The `registerDashboardTile` seam; the `/dashboard` page; the responsive grid (half/full
columns, reflow to one column on mobile); the customization UI — a tile **picker**
(add/remove), **reorder** (drag **and** keyboard: arrow-move for a11y — dragging is not
the only path), **resize** (half↔full where `resizable`); `dashboardClient.ts`; the nav
entry via the menu registry (a top-level "Dashboard" entry, `featureId: 'dashboard'`).
`ui/` cohesion (`surface-card`, `chip`, `StateCard`, `ui/icons`), dark-mode parity,
tokens only. Empty state (no tiles enabled) is designed, not blank.

**Phase 3 — the tile catalog (role-tiered, both families; composition-only).**
Each tile is a compact projection over the **existing** feature client — **no new
data, no new store**. Phase the catalog; log which feature gets a tile when.

> **Correction note (Phase 2 seam):** tiles are registered by the dashboard in the
> central `allTiles.ts`, NOT via per-feature `registerDashboardTile()` calls. A
> feature declaring its own tile would create a `feature → dashboard` import edge
> (and, since the nav manifest imports `DashboardPage`, a cycle). Dashboard-owns-the-
> registry keeps the dependency one-way (`dashboard → each feature's client`), and the
> lazy tile component means a missing/removed client only breaks that one tile's chunk
> (caught by the tile `ErrorBoundary`), never the grid. A tile whose feature client
> does not exist is **deferred + logged**, never stubbed.
- *Work-hub* (default-enabled, `member`): **Active runs (mine)** (runs client),
  **My to-dos / commitments** (ADR 0311 kanban commitments), **Recent conversations**
  (chat sessions client), **Upcoming scheduled agents** (scheduler), **Recent
  documents** (documents client).
- *Business-metrics* (`admin`, each behind its `owningFeatureToggle`): **CRM pipeline
  by stage** (crm), **Commerce revenue + orders** (commerce), **Campaign KPIs**
  (campaign-intel), **Funnel conversion** (funnels), **Top priorities** (priority-
  matrix). Each renders a disabled/absent tile where its feature is OFF or the user
  lacks the role.

**Phase 4 — Core-app extension surface (honest accounting).**
- **Node pack:** **none** in P1 — a dashboard is a read/preference surface, not a
  workflow actor. A future `dashboard.publish-tile` (pin a run/report output as a
  tile) is a candidate; **deferred, logged**.
- **Agent pack:** **none** — not an AI-authoring surface. Honest.
- **`ctx.dashboard` workflow surface:** **none** in P1 (no automation target); a
  read-only "my dashboard summary" op is thin and **deferred**.
- **AI-chat envelopes:** **none**; a future "add the *X* tile to my dashboard" chat
  tool is speculative and **deferred**.
- **`/.well-known/openwop`:** advertises **nothing** — host-extension, no wire.

## Alternatives weighed

- **MyndHyve's static core registry (verbatim clone):** rejected — violates the ADR
  0001 core→feature import boundary. The registration seam is mandatory, not optional.
- **A dashboard-owned aggregate store (precompute tile data):** rejected — violates
  ADR 0082 (no parallel store), invites staleness + duplication. Tiles read live from
  the owning feature client.
- **A single server endpoint that returns all tile data:** rejected — it would
  re-own every feature's read (duplication, N+1, and a second authorization surface
  to drift). Each tile owns its own read via the existing, already-gated feature
  client (parallel, cache-friendly, honestly gated).
- **Dashboard as the landing home (`/`):** rejected per the placement decision — chat
  stays `/`; `/dashboard` is additive. (A future per-user *landing preference* is a
  small follow-on if wanted.)
- **Per-user-global layout:** rejected — available tiles are workspace-and-role
  dependent, so the layout is per-(user, workspace).

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | `src/features/dashboard/` (service + routes + feature.ts), appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; **no core route/nav edits** (nav via the menu registry; tiles via the registration seam). Core must not import features — the seam guarantees it. |
| 2 | Toggle + admin UI | id `dashboard`, **default OFF**, `bucketUnit: tenant` (a workspace turns the surface on). Per-user *layout* is stored per (subject,tenant) regardless. No variants. Manageable in `FeatureTogglePanel`. |
| 3 | Workflow orchestration (ADR 0014) | **None in P1** — not a workflow target. `ctx.dashboard` deferred (see Phase 4). |
| 4 | Node pack | **None in P1**; `dashboard.publish-tile` deferred. |
| 5 | AI-chat integration + envelopes | **None**; "add tile" chat tool deferred. |
| 6 | Agent pack | **None** — honestly not an AI surface. |
| 7 | Public surface | **None** — personal/authed only; not added to `PUBLIC_PATH_PREFIXES`. |
| 8 | RBAC + isolation (ADR 0006) | Layout routes **self-scoped** by session subject (IDOR-safe by construction — key never from request input); `dashboard` toggle-gated; each tile gated by `owningFeatureToggle` + `requiredRole`; **fail-closed** (OFF/erroring tile → empty/omitted, never a leak). |
| 9 | Replay / fork safety | **N/A** — the dashboard never influences a run; no `run.metadata` stamp; no packs to decouple. |
| 10 | Frontend | `dashboardClient.ts` + `DashboardPage.tsx` + a `routes.tsx` `FrontendFeature` (`featureId: 'dashboard'`); nav via the menu registry (`GROUP_ORDER`); the tile-registration seam; keyboard-operable reorder; `ui/` cohesion + a11y + tokens + dark mode (see `/ux-review`, `DESIGN.md`). |

## Open questions / design pins

- **Widget-load fan-out.** N enabled tiles → N parallel feature reads on `/dashboard`
  load can blow the per-IP read budget (`middleware/rateLimit.ts` — the recorded
  "rate-limit fan-out" hazard). **Design pin (Phase 2):** cap concurrent tile loads,
  lazy-load below-the-fold tiles, and prefer a batch read where a feature offers one.
- **`requiredRole` → openwop RBAC mapping.** Confirm the `admin` tier for business
  tiles maps to the workspace org-admin role (ADR 0006), not superadmin.
- **Layout schema evolution.** Retired tile ids are dropped by the effective-list
  intersection (no migration); confirm no code path assumes a stored id still resolves.
- **Default-landing preference.** Deferred — placement is `/dashboard`-only. Revisit
  only if a per-user landing choice is wanted.

## RFC gate

Host-extension under `/v1/host/openwop-app/dashboard/*` — **non-normative, no RFC.**
No run-event field, capability flag, event type, endpoint contract, or normative
`MUST` touched; nothing advertised at `/.well-known/openwop`. A feature riding purely
on existing host-extension surfaces needs none.

## Phase → artifact (to fill as it ships)

| Phase | Artifact |
|---|---|
| 1 — persistence + REST | `features/dashboard/{dashboardService,routes,feature}.ts`; `test/dashboard-layout-route.test.ts` — PR #1889 |
| 2 — FE registry + grid | `dashboard/allTiles.ts` (separate registry, NOT the nav manifest — cycle-free), `resolveTiles.ts` (+ `resolveTiles.test.ts`), `DashboardPage.tsx`, `DashboardTileCard.tsx`, `LazyMount.tsx`, `tileTypes.ts`, `dashboardClient.ts`, `tiles/{ActiveRuns,RecentConversations}Tile.tsx`, `routes.tsx` nav entry, 4-locale i18n, DESIGN.md §5 row — PR #1891 |
| 3 — tile catalog | 8 tiles appended to `allTiles.ts` + `tiles/{Todos,ScheduledAgents,RecentDocuments,CrmPipeline,CommerceSummary,CampaignKpis,FunnelConversion,TopPriorities}Tile.tsx`; shared `useDashboardOrg.ts` (one memoized core `listOrgs`) + `useOrgResource.ts` + `TileStats.tsx`; `__tests__/{catalog,useDashboardOrg}.test`; 4-locale i18n; DESIGN.md §5 row extended — PR #1892 |
| 4 — extension surface (honest accounting) | **None built, by design** — a dashboard is a read/preference surface, not a workflow actor. Node pack: none (a future `dashboard.publish-tile` — pin a run/report output as a tile — is a candidate, **deferred + logged**). Agent pack: none (not an AI-authoring surface). `ctx.dashboard`: none (no automation target; a read-only "my dashboard summary" op is thin, deferred). AI-chat envelopes: none (a future "add the X tile" chat tool is speculative, deferred). `/.well-known/openwop`: advertises nothing — host-extension routes under `/v1/host/openwop-app/dashboard/*`, non-normative, **no RFC**. |

---

## Correction note — customize mode's two edges (2026-07-24, `docs/steward/UX_UPGRADE-dashboard.md`)

A benchmark against customizable product homes (Datadog/Grafana, Notion/Linear,
Retool) found this feature's **resilience architecture is the strongest in the
matrix** — per-tile `ErrorBoundary` + `Suspense` isolation, the `LazyMount`
fan-out guard that keeps N composed feature reads off the per-IP read budget,
fail-closed tile resolution, debounced persistence with an unmount flush, and a
zero-write first paint. None of that was touched.

The gap was at the two edges of customize mode:

1. **Only reordering announced (D-G2/D-G3).** Resize and add/remove were silent,
   so a screen-reader user pressing them got no confirmation anything had
   happened — in a mode whose entire value proposition is keyboard operability.
   The announcement pattern already existed for `move`; it simply had not been
   applied to the other two actions. Removal now also names the recovery path
   ("you can add it back under Add tiles") rather than letting a tile silently
   vanish off the grid.

2. **No route back to the default layout (D-G1).** Restoring defaults meant
   hand-reconstructing the arrangement through the picker. Reset now
   **re-derives from the registry** — persisting an empty layout is exactly what
   "no saved layout" already means to `resolveTiles`, so there is ONE definition
   of "default" and the reset path cannot drift from first-run. It goes through
   `confirm()`, because it discards work and cannot be undone.

Deferred with reasons rather than left implied:

- **Drag-and-drop reorder (D-G4).** The keyboard path is complete and announced —
  the harder half, and the one most products get wrong. DnD is additive polish
  with a real a11y-regression risk if bolted on carelessly.
- **Undo for a removal (D-G5).** Blocked on a shared primitive: `ui/toast` has no
  action slot (`ToastItem` is `{ id, variant, message }`), so a proper Undo means
  changing the design system. That is a DESIGN.md-level decision, not a
  drive-by in a feature pass. D-G3's announcement mitigates the immediate harm.
