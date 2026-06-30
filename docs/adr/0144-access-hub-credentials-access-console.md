# ADR 0144 — Access Hub: unified credentials & access console

Status: implemented (graduated to always-on, toggle retired — §Correction 2026-06-26)

> **§Correction (2026-06-26) — graduated off the feature toggle.** Shipped behind
> `access-hub` (default OFF), verified, then **turned on by default and retired the
> toggle** — the Connections/Users precedent (a permanent admin surface carries no
> `featureId`). Concretely: the hub nav lost its `featureId`; the four subsumed
> entries (Keys, Connections, Organizations, Capability-firewall) **dropped their
> standalone `nav` entirely** (no longer the conditional `hiddenWhenFeature`
> collapse — that mechanism stays for the toggle-gated Models / Chat-deployment
> consoles, ADR 0145); the backend `access-hub` toggle-only feature was deleted;
> `AdminOverviewPage` dropped `access-hub` from its console list. The hub is now the
> single, permanent way to reach those surfaces (their routes + `hubTab` remain, so
> the hub still renders them). Reverting means restoring the four `nav` blocks.

Owner: openwop-app frontend platform

Composes: ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0015 (workspace-as-tenant),
ADR 0024 (Connections). Touches the nav contract in `chrome/features.tsx`.

RFC verdict: **none — frontend information-architecture only; touches no wire.**

> **Revised after `/architect` review (2026-06-25).** Three corrections folded in
> before any code: (1) the hub **projects from the existing `FEATURES` nav
> manifest**, not a new tab registry — the manifest is already the single source
> of truth that legally aggregates core + feature elements and gates them via
> `resolveNav`; a parallel registry would have been a second nav system. (2) The
> `Workspace · Personal` scope pill is **backed by an explicit `scope` prop** added
> to `KeysPage` + `ConnectionsManager` (mapping to the BYOK `ws:`/`user:` tenant +
> a connections filter) — the components have no such mode today, so this is a
> logged owner-component change, not "just mounting." (3) The nav-collapse rollout
> uses **structural always-on routing** (drop the eight `nav` blocks, keep paths as
> redirects), because `resolveNav` gates positively and cannot express "hide when
> *another* toggle is on."

---

## Context

Credential, account, and access management is scattered across **eight separate
top-level nav destinations**, all already filed under the one `Access & data` nav
group, plus two context-scoped surfaces and several buried cards:

| Surface | Owner (file) | Manages | Scope |
|---|---|---|---|
| `/keys` | `byok/KeysPage.tsx` | BYOK keys, **voice** (`RealtimeVoiceSettings`), AI default, compat endpoints (RFC 0108) | Workspace |
| `/connections` | `features/connections/ConnectionsManager.tsx` | OAuth/API connections + governance (allowlist, media budget) | Workspace |
| `/orgs` | `orgs/OrgsPage.tsx` | Orgs, teams, members, roles/RBAC | Workspace |
| `/users` | `features/users/UsersPage.tsx` | User accounts, SSO | Workspace |
| `/capability-firewall` | `features/capability-firewall/` | Tool/capability gating | Workspace |
| `/profile?tab=connections` | reuses `ConnectionsManager` | OAuth/API connections | **Personal** |
| `/projects/:id?tab=sources` | `notebooks/ProjectSourcesPanel` | data sources | **Per-project** |

The pain is purely **information architecture**: a user setting up the app must
visit `/keys`, then `/connections`, then `/orgs`, then hunt for voice (a hidden
card inside `/keys`), then discover their *personal* connections live on a
*different page* (`/profile`). There is no single "set up access" surface.

Two prior design decisions (captured in the conversation that produced this ADR,
via `/architect` + `/frontend-design`) fix the shape:

1. **Consolidation scope = Credentials + Identity & Access only.** Model-router,
   KB, and example-data keep their own nav entries; per-project Sources stays in
   the project tab. (Other scopes were rejected — see Alternatives.)
2. **A scope pill (`Workspace · Personal`)** reframes the hub so personal
   credentials get a home next to workspace ones, retiring the buried
   `/profile?tab=connections`.

## Boundaries & pre-existing-surface audit (MANDATORY — Step 3)

The lead risk on any consolidation is standing up a *second* system. It is not a
risk here, but two real traps are:

- **No data duplication to reconcile.** Every concept already has exactly **one**
  owner: BYOK owns keys, `ConnectionsManager` owns connections, `accessControl`
  owns orgs/roles, the identity layer owns users. This ADR adds **no service, no
  store, no endpoint, no wire** — it is a frontend shell that *mounts the existing
  owners*. Verified: no service/store named `access*` exists beyond
  `accessControlService` (which we compose, not fork).
- **No route/id collision.** `grep -rn "'/access'"` across `frontend/react/src` +
  `backend/typescript/src` → **0 hits**; no `id: 'access*'` feature exists. The
  `/access` path and `access-hub` feature id are free.
- **Import direction — already solved by the composition root (no new registry
  needed).** The hub renders Connections (`features/connections`), Users
  (`features/users`), Capability-firewall (`features/capability-firewall`) — all
  **feature-packages** — alongside Keys and Orgs, which are **core**
  (`chrome/features.tsx:215,219` `CORE_FEATURES`). A hub that *directly* `import`ed
  those components would make one feature depend on another and make core import a
  feature (forbidden by `ARCHITECTURE.md`). **But the app already has the legal
  aggregation point:** `chrome/features.tsx` composes `CORE_FEATURES` +
  `FRONTEND_FEATURES` into the **`FEATURES` manifest**, and
  `chrome/navConfig/NavConfigProvider.tsx:88` resolves it via
  `resolveNav({ features: FEATURES, …, access: isVisible })`. `chrome/` is the
  composition root, so it may reference every surface's `element` — that is not a
  feature→feature edge. **Resolution: the hub projects from `FEATURES`** (filter the
  `Access & data` admin tabs), reusing the existing toggle gating. An earlier draft
  proposed a separate `accessHubRegistry` each surface re-registers into; `/architect`
  flagged that as a **second nav system** duplicating `FEATURES` + `resolveNav`
  (a single-source-of-truth violation), so it is **rejected** in favor of projection.
- **Core-nav edit (deliberate, minimal exception).** `keys`, `orgs`, `example-data`
  register their nav in `CORE_FEATURES` (`chrome/features.tsx`), not via
  `FRONTEND_FEATURES`. Collapsing the group's eight nav entries into one requires
  touching those core nav entries (drop their standalone `nav`, keep their `path`
  as a route + redirect target). This is a **documented, deliberate exception** to
  ADR 0001's "no edits to core route/nav code": the hub *becomes the nav owner*
  for the Credentials + Identity tabs. It is reversible (revert the manifest) and
  is the minimum core touch the consolidation requires.
- **Helper reuse.** `ui/rovingTabs.ts` already exists (used by `ui/Menu`) but
  there is **no shared `ui/Tabs`** — `ProfilePage` and `ProjectDetailPage` hand-roll
  `?tab=` tab state. We add `ui/Tabs` on top of `rovingTabs` and adopt it, paying
  down that duplication rather than adding a third one-off.

## Decision

Ship a frontend-only feature-package **`features/access-hub/`** that renders a
single route `/access` as a **two-level tabbed console** composing the existing
owner surfaces, driven by an **access-hub tab registry** (dependency inversion).

### 1. The hub projects from the `FEATURES` manifest (no new registry)

The hub does **not** introduce a second registration list. It reads the existing
**`FEATURES` manifest** — already the single source of truth for "which admin
surface exists, its `group`/`label`/`element`/`nav.order`/`featureId` gate" — and
renders the `Access & data` admin tabs as tab bodies instead of rail entries.

To mark which routes belong in the hub (and in which group/scope) without a parallel
list, extend `FeatureRoute` with one **optional annotation** (added in `chrome/featureTypes.ts`):

```ts
interface FeatureRoute {
  // …existing fields (path, element, tier, nav?, featureId?)…
  hubTab?: {
    group: 'credentials' | 'identity';
    scopes: ('workspace' | 'personal')[];   // default ['workspace']
  };
}
```

- The hub computes its tabs as `FEATURES.filter(r => r.hubTab)`, grouped by
  `hubTab.group`, gated by the **same** `resolveNav` access resolution
  (`NavConfigProvider.tsx:88`) the rail already uses — **one manifest, one gating
  path**. No `accessHubRegistry`, no per-surface re-registration, no
  feature→feature import (the elements were already aggregated by `chrome/`).
- **Voice and Compat-endpoints**, today buried cards inside `KeysPage`, become
  **first-class tabs** by registering as **nav-less `FeatureRoute`s** (a `path` +
  `element` + `hubTab`, **no `nav`** so they never appear in the rail) pointing at
  the already-standalone `RealtimeVoiceSettings` / `CompatEndpointsCard` components.

### 2. Layout — left rail grouped by concern, scope pill on top

```
┌─ Access ──────────────────────────────────────────────┐
│  [ Workspace · Personal ]   ← scope pill (signature)    │
│                                                         │
│  CREDENTIALS          │                                 │
│    Keys               │   <mounted owner component>     │
│    Connections        │   (KeysPage / ConnectionsManager│
│    Voice              │    / OrgsPage / …)              │
│    Endpoints          │                                 │
│  IDENTITY & ACCESS    │                                 │
│    Organizations      │                                 │
│    Capability firewall│                                 │
└─────────────────────────────────────────────────────────┘
```

> **§correction (post-deploy feedback).** **Users/People is NOT a hub tab.** Account
> & identity management is a distinct admin surface, so it keeps its own `/users`
> nav entry (no `hubTab`, no `hiddenWhenFeature` — its rail entry never hides). The
> hub's Identity group is Organizations + Capability-firewall (Roles live inside
> Organizations). Credentials is unchanged (Keys · Connections · Voice · Endpoints).

- **Vertical** rail grouped by concern (not a flat horizontal strip — eight
  horizontal tabs would wrap and read as noise).
- **Scope pill** `Workspace · Personal`: Workspace shows all tabs (admin-tier);
  Personal shows only the tabs whose `hubTab.scopes` include `'personal'` (Keys +
  Connections), retiring `/profile?tab=connections`. Identity & Access hides under
  Personal — you don't administer orgs "for yourself."
- **The pill is backed by a real `scope` prop, not a UI fiction.** `KeysPage()`
  (`byok/KeysPage.tsx:60`) takes no props today and `ConnectionsManager`
  (`features/connections/ConnectionsManager.tsx:33`) takes only `returnPath` — they
  have **no workspace/personal mode**; `ConnectionsManager` shows *both* in one list
  split per-row by `shareScope`/`orgId` (`:76,:153`). So the hub adds an explicit
  `scope: 'workspace' | 'personal'` prop to **both** components (a **logged
  owner-component change** — see Phase 3, not "just mounting"):
  - `KeysPage` maps `scope` to the BYOK tenant axis the resolver already keys on
    (`secretResolver.ts:144` — `ws:` vs `user:` tenant); Personal lists/writes the
    caller's `user:`-scoped keys, Workspace the `ws:`-scoped catalog.
  - `ConnectionsManager` maps `scope` to a list filter + the default `shareScope`
    for new connections (Personal → `orgId == null`; Workspace → org-shared),
    composing the existing `canManageOrg` gate.
- **Per-project Sources is NOT absorbed** — it has no meaning without a `projectId`.
  The hub surfaces a one-line pointer ("Per-project sources live inside each
  project") rather than a broken global tab.

### 3. `ui/Tabs` primitive

New `frontend/react/src/ui/Tabs.tsx` built on `ui/rovingTabs.ts`: keyboard a11y
(arrow/Home/End), `?tab=`/`?scope=` URL sync, `surface-card` chrome. The hub uses
it; `ProfilePage` and `ProjectDetailPage` migrate to it (debt paydown, not in the
critical path — can be a follow-up phase).

### 4. Nav collapse (a `hiddenWhenFeature` inverse gate, not an unconditional drop)

> **Phase 5 correction (implementation overturned the original plan).** The
> earlier text said "drop the eight `nav` blocks." That is wrong for the
> default-OFF state: with the blocks dropped *and* the hub gated OFF, those
> surfaces would have **no nav entry at all** until an operator flips the toggle —
> a broken default. Instead we added a minimal nav-contract field,
> `FeatureNav.hiddenWhenFeature`, and one positive gate in `resolveNav`
> (`if (f.nav.hiddenWhenFeature && access(...)) continue`). The five Access & data
> nav entries (Keys, Connections, Organizations, Users, Capability-firewall) carry
> `hiddenWhenFeature: 'access-hub'`. Net behaviour:
>
> - **`access-hub` OFF (default):** the five entries show exactly as today; the
>   hub nav is hidden. Zero change — safe to ship dark.
> - **`access-hub` ON:** the five entries hide, the single "Access" entry shows.
>   Collapsed to one. Reversible by flipping the toggle (no redeploy).
>
> Voice + self-hosted Endpoints carry no `nav` at all (they were buried cards in
> the Keys page); they surface **only** as hub tabs (nav-less `hubTab` routes).

- **No redirects.** The original "redirect old paths to `/access?tab=…`" is
  dropped: the hub reads each surface's `element` *from its own `FeatureRoute`*
  (the `/keys`, `/connections`, … entries), so turning those into `<Navigate>`
  would strand the hub's element source. Keeping the paths as live standalone
  routes is equally non-breaking — a bookmarked `/keys` still renders, just
  without a rail entry once the hub is ON.
- **Sources pointer — N/A.** With the consolidation scoped to Credentials +
  Identity (no Data/KB tab), there is no hub surface to host the "per-project
  sources live in each project" pointer; per-project Sources is simply left in the
  project tab, unreferenced by the hub.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | `frontend/react/src/features/access-hub/` (shell + `routes.tsx`); appended to `FRONTEND_FEATURES`. **Frontend-only — no backend half.** Reads the existing `FEATURES` manifest (no new registry). Core edits, all documented: the `hubTab` field on `FeatureRoute`, the eight nav-block removals, and the `scope` prop on `KeysPage` + `ConnectionsManager`. |
| 2 | **Toggle + admin UI** | `access-hub`, `bucketUnit: 'tenant'` (workspace admin surface, ADR 0015), **default OFF**. OFF = today's scattered nav; ON = consolidated hub + redirects + collapsed nav. Flip ON after verification → instant rollback. Manageable in `FeatureTogglePanel`. |
| 3 | **Workflow surface (ADR 0014)** | **None.** Pure IA; exposes no `ctx.<feature>`. |
| 4 | **Node pack** | **None.** No executable workflow behavior. |
| 5 | **AI-chat envelopes** | **None.** |
| 6 | **Agent pack** | **None** — not an AI surface. |
| 7 | **Public surface** | **None.** Admin/authenticated only; nothing added to `PUBLIC_PATH_PREFIXES`. |
| 8 | **RBAC + isolation (ADR 0006)** | **No new routes, so no new authz.** Each mounted surface keeps its existing route-level authz verbatim. Tab visibility reuses the same `resolveNav`/`isVisible` gating as the rail (one path, not a second gate). The new `scope` prop is **presentation only** — it selects which of the caller's *already-authorized* keys/connections to show (BYOK `user:`/`ws:` tenant + `canManageOrg`); it grants nothing. Personal-scope tabs render for any authenticated user (their own credentials). Fail-closed inherited from the mounted owners. |
| 9 | **Replay / fork** | **N/A** — changes no run behavior; stamps nothing on `run.metadata`. |
| 10 | **Frontend** | `features/access-hub/` page + `routes.tsx` (`FrontendFeature`, `featureId: 'access-hub'`); nav via the menu registry; `ui/Tabs` + scope pill; `ui/` cohesion, a11y (roving tabs, visible focus), tokens, light/dark (`/ux-review`, `/browser`). |

## Phased plan

1. **`ui/Tabs` + `hubTab` field** — `ui/Tabs.tsx` on `rovingTabs` (keyboard a11y,
   `?tab=`/`?scope=` URL sync); add the optional `hubTab` annotation to
   `FeatureRoute` (`chrome/featureTypes.ts`). No registry.
2. **Hub shell** — `features/access-hub/` page: project `FEATURES.filter(r => r.hubTab)`,
   group by `hubTab.group`, gate via the existing `resolveNav`/`isVisible`; render
   the scope pill + grouped rail + active tab body. Appended to `FRONTEND_FEATURES`,
   nav gated on `access-hub`.
3. **Owner-component `scope` prop (logged owner edit)** — add `scope: 'workspace' |
   'personal'` to `KeysPage` (→ BYOK `ws:`/`user:` tenant) and `ConnectionsManager`
   (→ list filter + default `shareScope`). Add nav-less `hubTab` `FeatureRoute`s for
   **Voice** (`RealtimeVoiceSettings`) and **Endpoints** (`CompatEndpointsCard`),
   promoting them out of `KeysPage` cards. Tag `keys`/`connections` `hubTab.scopes`
   with `['workspace','personal']`; the rest `['workspace']`.
4. **Header-less tab bodies** — `KeysPage`/`OrgsPage`/`UsersPage` each render their
   own `PageHeader`; inside a tabbed `/access` that double-stacks headers. Give each a
   header-less body variant (prop or wrapper) so the hub owns the page chrome.
5. **Nav collapse + redirects** — structurally drop the eight `nav` blocks (keep
   `path`s), add the hub nav entry, redirect old paths to `/access?tab=…&scope=…`;
   per-project Sources pointer.
6. **Debt paydown (follow-up)** — migrate `ProfilePage` / `ProjectDetailPage` to `ui/Tabs`.
7. **Verify** — `( cd frontend/react && npm run build )`; a **render/router test**
   asserting the eight legacy paths redirect to `/access?tab=…&scope=…` and the rail
   shows one "Access" entry when `access-hub` is enabled; `/browser` light+dark; flip
   toggle ON.

## Alternatives weighed

- **Flatten all eight into one tab strip** — rejected: breaks the scope axis
  (jams per-project + personal into an admin shell) and 8 horizontal tabs wrap.
- **Absorb per-project Sources (project picker in the hub)** — rejected: couples a
  global admin shell to per-project state; Sources is meaningless without a
  `projectId`. Pointer instead.
- **A separate `accessHubRegistry` each surface re-registers into** — rejected by
  `/architect`: it duplicates the `FEATURES` manifest + `resolveNav` gating (a
  second nav system for a route subset). Projecting from `FEATURES` reuses the SSoT
  and the same import-direction safety the composition root already provides.
- **Direct imports of each owner page** — rejected: core→feature / feature→feature
  import violations. (The `FEATURES` projection avoids them without a registry.)
- **A `scope`-less pill (UI-only)** — rejected: `KeysPage`/`ConnectionsManager` have
  no workspace/personal mode, so the pill would be a fiction. An explicit `scope`
  prop (the small owner edit in Phase 3) is the honest minimum.
- **Leave as-is** — rejected: the reported scatter.

## PRD-vs-architecture corrections

- The plain-language ask ("one comprehensive UI, even tabbed") implied a single
  flat page; corrected to a **two-axis** model (concept × scope) because the
  surfaces are genuinely workspace / personal / per-project — flattening them would
  be scope-incorrect, not just dense.
- "Consolidate *all* the places" was scoped to **Credentials + Identity** (user
  decision) so routing/seed tooling and per-project data don't get mixed into a
  credentials console.

## Open questions

1. ~~**Toggle vs structural rollout.**~~ **Resolved + refined in Phase 5.** Not an
   unconditional nav drop (that breaks the default-OFF state) but a
   `FeatureNav.hiddenWhenFeature: 'access-hub'` inverse gate in `resolveNav`: the
   five entries show when the toggle is OFF, hide when ON. No redirects (the hub
   reads each surface's element from its own route). See §Decision 4.
2. **Capability-firewall placement.** Under Identity & Access, or its own
   "Policy" group alongside a future governance tab? (Deferred; one tab today.)
3. **`ui/Tabs` migration scope.** Migrate Profile/Project tabs in this ADR or a
   follow-up? (Leaning follow-up — not on the consolidation critical path.)
4. **Governance panel** (today inside `ConnectionsManager`) — promote to its own
   hub tab, or leave embedded? (Leaning leave embedded for now.)
5. ~~**Personal Keys reachability.**~~ **Resolved during Phase 3 (verified against
   code).** The BYOK routes derive the tenant from `req.tenantId` (the session
   cookie, set by auth middleware — `routes/byok.ts:36–43`) and the client takes no
   scope argument (`byok/lib/byokClient.ts` — `listStoredRefs()`/`storeKey()` are
   param-free). So a hub-local `scope` prop **cannot** select a `user:`-scoped BYOK
   tenant without an active-workspace switch or a new host-ext route param.
   Decision: **Keys is Workspace-scope only** (`hubTab.scopes` omits `personal`);
   **Personal scope surfaces the caller's own Connections** (which *are*
   scope-reachable — `ConnectionsManager` distinguishes personal vs org by `orgId`).
   A future host-ext `?scope=` on the BYOK routes could add Personal Keys; it is out
   of this frontend-only ADR's scope.
