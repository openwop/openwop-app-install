# ADR 0139 — Configurable Navigation Menu (tenant + per-user nav layout overlay)

**Status:** implemented — all 5 phases (2026-06-24)
**Date:** 2026-06-24

## Decision

Today the navigation is computed **once at module load** from the static
`FEATURES` array (`WORKSPACE_NAV` / `ADMIN_NAV_GROUPS` in `chrome/features.tsx`),
grouped by each route's declared `nav.group` and split by `nav.tier`
(workspace = the main rail, admin = the `AdminLayout` rail). We **keep those
declarations as the *suggested defaults*** and add a sparse **override overlay**
resolved at render time. There is **no second nav registry** — that would shadow
`FEATURES` ([[no-parallel-architecture]]); the overlay only re-tiers / re-groups
/ re-orders / hides items that `FEATURES` already declares.

Configurable per item: which **menu** it lives in (main ↔ admin), which **header**
(group) it falls under, its **order**, and **visibility** (show/hide). Headers
themselves are configurable: create / rename / reorder / delete.

Two override layers (in precedence order):

```
declared default  ←  tenant default (admin-edited)  ←  per-user personalization
```

The feature-toggle system stays the **hard gate**: a toggled-off feature never
appears regardless of overlay; a newly toggled-on feature appears under its
**declared (suggested) location** automatically until someone overrides it.

**Always-on items** — nav items with no `featureId` (`Chat`, `Agents`, `Inbox`,
`Workflows`, …) — are **movable/regroupable but never hideable** (the hide
control is disabled with a lock affordance).

Section headers become **collapsible**, remembered per-browser in a **cookie**
(`openwop.nav.collapsed`), distinct from the existing localStorage icon-rail
collapse (`openwop.sidebar.collapsed`).

## Context — boundaries audit (MANDATORY)

The naïve build is "a second nav source / analytics store." That shadows
`FEATURES` + `navGroups()` ([[no-parallel-architecture]]). Instead the overlay is
a *projection re-sort* over the existing declared nav.

| Concern | Existing owner (file) | How this feature reuses it |
|---|---|---|
| Declared nav (the suggested defaults) | `chrome/features.tsx` `FEATURES[].nav` + `navGroups()` | stays the single source of *declared* nav; the overlay only re-tiers/re-groups/re-orders/hides. No nav item is defined anywhere new. |
| Feature gating | `useFeatureAccess(featureId)` + `nav.featureId` | unchanged hard gate; the overlay never reveals a disabled feature. |
| Workspace rail | `chrome/Sidebar.tsx` (consumes `WORKSPACE_NAV`) | switches from the static constant to the resolved hook. |
| Admin rail | `chrome/AdminLayout.tsx` (`ADMIN_NAV_GROUPS`) | same. |
| ⌘K palette | `ui/CommandPalette.tsx` (`NAV`) | same resolved source so search matches the live menu. |
| Drag-and-drop | `@dnd-kit/core` (already vendored — `kanban/`) | reused for the editor (NO new dependency). |
| Per-tenant / per-user config store | host-extension `DurableCollection` (ADR 0132/0133/0137 pattern) | a small new store, same shape + RBAC discipline. |
| Superadmin write gate | `OPENWOP_SUPERADMIN_TENANTS` ([[prod-superadmin-mechanism]]) | tenant-layer writes are superadmin-only; per-user writes are caller-scoped. |

## Decision detail

### Identity
- A nav item's stable key = its route **`path`** (already unique across `FEATURES`).
- A header = `{ id, label, order }`. Built-in headers keep their current label as
  their id (`Workspace`, `Platform`, `Operations`, …) so existing items map with
  **no migration**; custom headers get generated ids (`hdr_<n>`-style, allocated
  client-side and persisted).

> **Architecture-review correction (2026-06-24, pre-impl).** Two refinements from
> the `/architect` Phase-1 review are folded in:
> 1. **Header id ≠ display label.** Today item→group is keyed by the group *label*
>    string (`features.tsx:302`). An item's `group` override therefore stores a
>    header **id** (built-in id = the current label; custom id = `hdr_*`), and the
>    resolved `NavGroup` gains `{ id, label, items }` (it had only `label`). This
>    lets a built-in header be **renamed** without stranding the items declared
>    under its old label, and lets the collapse cookie + DnD key on the stable id.
> 2. **No parallel orderer.** `resolveNav` does **not** re-implement
>    `navGroups()`; the group/sort core is extracted into a shared primitive and
>    the static `WORKSPACE_NAV` / `ADMIN_NAV_GROUPS` are **redefined as
>    `resolveNav` with empty overrides + allow-all access** — one implementation,
>    pinned by an "empty == today" regression test ([[no-parallel-architecture]]).

### Resolution (pure, unit-tested) — `chrome/navConfig/resolveNav.ts`
`resolveNav({ features, tenantOverride, userOverride, access })`:
1. Project declared items: `path → { tier, group, order, label, labelKey, icon,
   hint, hintKey, featureId, end, notUnder, alwaysOn }` where `alwaysOn = !featureId`.
2. Hard-drop items whose `featureId` is present and **not** enabled in `access`
   (always-on items always pass).
3. Apply `tenantOverride` then `userOverride` (sparse, keyed by path):
   `{ tier?, group?, order?, hidden? }`. `hidden` is **ignored** for `alwaysOn`.
4. Assemble headers per tier: built-ins ordered by `GROUP_ORDER` merged with
   custom headers, re-ordered by the override's header order; **empty headers drop out**.
5. Group + order → `{ workspace: NavGroup[], admin: NavGroup[] }`.

**Invariant:** with both overrides empty, `resolveNav` reproduces today's
`WORKSPACE_NAV` / `ADMIN_NAV_GROUPS` exactly (zero behavior change until configured).
A regression test pins this.

### Persistence (host-extension — no RFC)
- `GET /v1/host/openwop-app/menu-config` → `{ tenant, user }` in **one** read (the
  rate-limit fan-out gotcha — never N requests on load).
- `PUT /v1/host/openwop-app/menu-config/tenant` — **superadmin-gated**.
- `PUT /v1/host/openwop-app/menu-config/me` — caller-scoped (subject), any user.

> **Post-merge architecture-review fix (2026-06-25).** The tenant-layer key MUST
> be derived from the SAME source the `GET` reads — the resolved user's
> `tenantId` (`resolveCallerUser`), not `tenantOf(req)`. The two coincide for a
> shared/workspace tenant but can diverge under personal-tenant canonicalization,
> which would make a superadmin's workspace-default save invisible to their own
> `GET`. `PUT /tenant` now keys by the resolved user's tenant, falling back to
> `tenantOf(req)` only for the user-less superadmin bearer (which reads via
> `getTenantBundle`). The `/me` layer was already consistent.
- Backed by `DurableCollection`(s); per-user layer stored server-side for
  cross-device parity. Config payload schema-validated; unknown item paths /
  header ids are tolerated on read (a feature can be removed between writes) and
  ignored by the resolver.
- Section-collapse state: a per-browser **cookie** `openwop.nav.collapsed` =
  comma-joined collapsed header ids (per the explicit request).

### Frontend
- `chrome/navConfig/NavConfigProvider.tsx` — context that fetches the combined
  config once and exposes `useResolvedNav()` → `{ workspace, admin }` groups +
  editor mutators (`setTenant`, `setUser`, `reset`). Initial value = the declared
  static nav (no first-paint flash); reconciled after fetch.
- `Sidebar`, `AdminLayout`, `CommandPalette` consume the hook instead of the
  static constants. The static `WORKSPACE_NAV` / `ADMIN_NAV` / `NAV` exports
  remain as the declared-default inputs to the resolver (and the SSR/first-paint
  fallback).
- Collapsible group headers in both rails (a header button, `aria-expanded`,
  roving focus preserved); collapsed set in the cookie.

### Editor — `features/navigation-settings/` admin page
- Route `/menu-settings`, `tier: 'admin'`, `Platform` group, lazy route-split.
  Nav label "Menu settings".
- **Scope switch:** "Workspace default" (superadmin only) vs "My layout"
  (everyone). Non-admins see only "My layout".
- Two drop-zones (Main menu / Admin menu) → headers → items. `@dnd-kit` drag to
  reorder items, move between headers, move between menus (keyboard sensor for
  a11y; an equivalent move-menu for non-DnD users).
- Per item: visibility toggle (disabled + lock badge for always-on); shows its
  source feature + suggested (declared) location.
- Header CRUD: add / rename / reorder / delete. Deleting a non-empty header
  reassigns its items to the tier's default header (+ toast). Built-in headers are
  renamable; their id stays stable.
- Reset-to-default per layer. Save → PUT the active layer.

> **Phase-4 scope correction (2026-06-24).** The implemented editor is
> **control-based** — per-item **menu** + **header** dropdowns and a **visibility**
> toggle, plus add/rename/remove of custom headers. **Drag-and-drop (`@dnd-kit`)
> and per-item ordering within a header are DEFERRED**: the original request asked
> only *which* menu/header an item belongs to and what shows, not item ordering, so
> the control-based form fully meets it and is inherently keyboard-accessible.
> Items keep their declared order within a header. DnD/order remains a clean
> future enhancement (the data model already carries `order`).

### Feature toggle
The editor page + overlay ship **always-on** (no toggle): with empty overrides
the menu is byte-identical to today, so there is no risk surface to gate. (An id
is reserved should we later want to gate the editor.)

## Phased plan

| Phase | What |
|---|---|
| 1 | Resolver + types + cookie helpers (pure) — `chrome/navConfig/` + unit tests (defaults == today; overrides; always-on lock; toggle hard-gate). No UI wiring. |
| 2 | Backend host-extension — `features/navigation-settings/` service + routes (GET combined; PUT tenant [superadmin]; PUT me) + schema validation + vitest. |
| 3 | FE provider + rail refactor — `NavConfigProvider`/`useResolvedNav`; switch `Sidebar`/`AdminLayout`/`CommandPalette`; collapsible headers + cookie. |
| 4 | Editor page — `/menu-settings` (both layers, DnD, header CRUD, show/hide, reset) + i18n (en/es/fr/pt-BR) + nav registration + tests. |
| 5 | Docs — this ADR → implemented (phase→commit table); `FEATURES.md` entry. (A manual-test page is a clean follow-up.) |

## Alternatives weighed
- **Per-user only / tenant only** — rejected per the "both layers" decision (a
  shared default *and* personal arrangement).
- **A second nav registry** — rejected (shadows `FEATURES`; [[no-parallel-architecture]]).
- **New DnD library** — rejected; `@dnd-kit/core` is already vendored (Kanban).
- **localStorage for the layout** — rejected for the shared/tenant layer (must be
  server-side); localStorage/cookie retained only for the per-browser collapse state.

## RFC verdict
**Host-only IA + a host-extension config store under `/v1/host/openwop-app/*`.**
No run-event field, capability flag, event type, endpoint contract, auth/scale
profile, or normative `MUST`. Host-extension routes are non-normative → **no RFC**.

## Open questions / decisions
- [x] Per-user layer server-side (cross-device), not localStorage.
- [x] Delete non-empty header → reassign items to the tier default (+ toast), not block.
- [x] Editor ships always-on (defaults == current menu, no risk surface).
- [ ] Built-in header rename: free-text label wins over the i18n key once renamed
  (custom labels are not translated). Confirm during P4.

## Implementation record
| Phase | What | Commit |
|---|---|---|
| 1 | Pure resolver + types + cookie (`chrome/navConfig/`); `NavGroup` gains stable `id`; `navGroups` exported as the one grouping primitive; "empty == today" invariant test. | `c43bd7e9` |
| 2 | `features/navigation-settings/` host-extension — `DurableCollection` store (2 keyed layers), `GET /menu-config` + `PUT /tenant` (superadmin) + `PUT /me`, fail-closed validation; route-level vitest. | `351d19f0` |
| 3 | `NavConfigProvider` + `useResolvedNav`; `Sidebar`/`AdminLayout`/`CommandPalette` consume the resolved nav; collapsible sections + cookie; entry budget 165→167 kB. | `3c65bb4b` |
| 4 | `/menu-settings` admin editor (scope layers, menu+header assignment, visibility, header CRUD, reset) + i18n en/es/fr/pt-BR. DnD/per-item-order deferred. | `eaa1b8b9` |
| 5 | ADR → implemented; FEATURES.md entry; this record. | _this commit_ |

Each phase ran `/architect` before and `/code-review` + `/ux-review` after, applying
fixes (header id≠label split; subsume `navGroups`; reduced-motion chevron fallback;
`aria-pressed` toggle over a misused `role="tablist"`). Backend tsc + the menu-config
route test green; the FE build gate (tsc + token/CSS integrity + bundle budget) green;
resolver + cookie unit tests green.
