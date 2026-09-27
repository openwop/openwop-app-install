# ADR 0203 — Admin-tier page enforcement: AdminLayout gates on effective access

**Status:** implemented (Phase 1 shipped with this ADR; Phase 2 = the tracker updates in the same PR)

## Context

UX-ASSESSMENT `ADM-8`: the `admin` tier is IA-only. ADR 0196 Phase 4 shipped the
**Sidebar** admin-entry filter (`useEffectiveAccess` + `isAdminCaller`), so admin
chrome is hidden from non-admin callers — but the routes stay mounted, and
`AdminLayout` (the pathless layout wrapping every admin-tier page,
`chrome/AdminLayout.tsx`) renders for anyone who navigates by URL. A viewer-role
member can open `/orgs`, `/feature-toggles`, `/audit-log`, etc. and see the page
chrome; every backend route 403s on its own, so what leaks is *layout and
partial UI*, not data — an honesty/enterprise-credibility gap, not a security
hole.

### Boundaries audit (what already exists — do not rebuild)

- **Authority:** `accessControlService` (ADR 0006) — built-in role catalog
  (`viewer/editor/admin/owner` → scopes), custom roles (protocol-scopes-only;
  the `host:*:manage` family is reserved to built-in admin/owner — the
  mint-guard), `scopesForRoles` fail-closed. Every admin route is scope-gated
  server-side.
- **Caller resolution:** `GET /access/effective` + the module-cached
  `useEffectiveAccess()` hook (ADR 0196 P4) — one read per page load, shared by
  all consumers, re-resolves on `onAuthChange` (incl. the Phase-D workspace
  broadcast), fail-closed to `basis:'none'`.
- **Predicate:** `isAdminCaller()` — tenant-owner ∨ built-in admin/owner ∨ any
  custom-role `host:*:manage` scope. The same family the panels check.

> **CORRECTED 2026-09-07 — the predicate missed one authority.** The env-bound
> superadmin (`OPENWOP_SUPERADMIN_TENANTS`, the wildcard bearer, the dev-open
> switch — `host/superadmin.ts`, the predicate every admin ROUTE gates on) is
> a different authority from membership and was never projected into
> `/access/effective`. A pure superadmin with no org role therefore resolved
> `basis:'none'`, the Sidebar hid the Admin entry and this layout showed the
> "Administrator access required" card, while every admin route would have
> answered 200. MEASURED on a white-label first bring-up (2026-09-06): the
> binding was live and the only way to learn that from the UI was to type
> `/admin` by hand. Fix: the route projects `superadmin: true` for the caller's
> OWN resolution (never for a member/subject preview), and `isAdminCaller`
> admits it. Presentation only, as before; the routes remain the authority.
- **Management UI:** already shipped — `orgs/CustomRolesPanel` (custom-role
  CRUD), member role assignment in the orgs surface. ADM-7's "RBAC-management
  surface" framing is stale; no new management UI is needed.
- **Single seam:** `AdminLayout` is the ONE component wrapping every
  `tier: 'admin'` route (`chrome/features.tsx`) — gating here covers all
  present and future admin pages with zero per-page wiring.

## Decision

Gate **inside `AdminLayout`**, presentation-only, fail-closed:

1. While effective access is unresolved → a neutral loading state (no deny
   flash on first paint; the hook resolves once per load).
2. Resolved and `!isAdminCaller` → an honest `<StateCard>` ("Administrator
   access required" + how access is granted), rendered inside the normal app
   shell. No redirect (deep links stay shareable; an admin who signs in on the
   same URL lands correctly after the auth-change re-resolve).
3. Resolved admin → render as today.

The backend remains the authority — this changes what the SHELL admits, not
what the API allows. Demo host unaffected: an anonymous visitor resolves
`basis:'tenant-owner'` server-side (the single-tenant demo exception), so the
public demo keeps its full admin nav.

`useEffectiveAccess` grows a sibling `useEffectiveAccessState()` returning
`{ access, resolved }` off the same module cache (the bare hook cannot
distinguish "still resolving" from "resolved to none", which would flash the
deny state).

> **CORRECTED 2026-09-20 — the tier contract is authoritative across discovery.**
> Stale router and manifest comments still described `admin` as IA-only and the
> configurable-menu overlay could re-advertise an admin route in the workspace
> rail without moving its `AdminLayout` gate. The admin tier is explicitly the
> role-gated operator shell. Effective navigation now projects the same caller
> access before producing admin destinations; Overview and the command palette
> consume that projection, and menu configuration cannot change a route's tier.
> Backend enforcement remains unchanged and authoritative.

## Alternatives weighed

- **Per-page guards** — N wirings, drift-prone; new admin pages would ship
  unguarded by default. Rejected for the single layout seam.
- **Unmounting admin routes** (the `nav.featureId` pattern) — feature-toggle
  gating and authz gating are different axes; unmounting breaks the
  honest-message pattern (toggles render `notEnabled` cards for the same
  reason). Rejected.
- **Redirect to `/`** — hides the reason; breaks the sign-in-then-land flow.
  Rejected for the honest StateCard (the feature-toggles/audit-log precedent).

## RFC verdict

Host-only presentation change; no wire surface. **No RFC needed.**

## Plan

| Phase | Work |
|---|---|
| 1 | `useEffectiveAccessState()` + the AdminLayout gate + chrome i18n ×4 + test (viewer → deny card; admin → renders; unresolved → loading) |
| 2 | Tracker: close ADM-8; correct ADM-7's stale "RBAC-management surface" framing (management UI already ships) |

## Open questions

- **OQ-1:** Should `editor`-role members see a *reduced* admin rail (e.g. only
  pages whose own scope they hold) instead of all-or-nothing? Deferred — the
  scope family on nav entries doesn't exist yet; all-or-nothing matches the
  Sidebar filter shipped in ADR 0196 P4.
  > **Implemented in the effective-navigation seam (2026-09-20).**
  > The full page→authority map exists: superadmin cluster = {feature-toggles,
  > agent-allowlists, front-page, audit-log, appearance}; scope-gated =
  > {boards/prompts→workspace:read, mission/runs→runs:read, library→artifacts:read};
  > the rest are tenant-scoped (ungated by design). Wiring: add
  > `requiredScope?: string` to `FeatureNav` (flows through `navGroups`/resolveNav
  > spreads untouched), filter in the effective-push loop (`resolveNav.ts:78-109`,
  > beside the toggle gates), thread `EffectiveAccess.scopes` into
  > `ResolveNavInput` (`NavConfigProvider.tsx:88`). Two prerequisites make this
  > Prerequisites are now satisfied: (1) `/access/effective` exposes a superadmin indicator
  > (env-based wildcard — NOT derivable from `host:*:manage` scopes) before the
  > superadmin cluster can filter client-side; (2) tenant-owner already returns
  > the full materialized OWNER_SCOPES (`accessControlService.ts:1026`), so no
  > owner special-case is needed. Routes annotate only authority narrower than
  > the admin-shell baseline; unannotated routes inherit the admin gate.
