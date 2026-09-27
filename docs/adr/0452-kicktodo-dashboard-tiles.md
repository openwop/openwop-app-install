# ADR 0452 — KickTodo home-dashboard tiles (Today + Progress)

| | |
|---|---|
| **Status** | implemented (P1) — 2026-07-20 |
| **Feature** | EXTENDS `frontend/react` dashboard registry (ADR 0375/0377) + `kicktodo` FE client. No new package/toggle. |
| **Source** | KickTodo leverage map #2 — KickTodo contributes 0 of 49 home-dashboard tiles, so participant signal never reaches the home surface (`/`), only `/kicktodo/today`. |
| **RFC verdict** | Host work, no RFC (frontend-only). |

## Boundaries audit
- The home is `dashboard/DashboardPage.tsx`; the registry is `dashboard/allTiles.ts`
  (`ALL_DASHBOARD_TILES`); the contract is `dashboard/tileTypes.ts:24` (`DashboardTileDef`:
  id, labelKey, icon, category, `requiredTier`, `owningFeatureToggle?`, a `lazy()` component).
- Tiles are PURE PROJECTIONS (no tile-owned data, ADR 0082) — a KickTodo tile reads
  `kicktodoClient` only. `owningFeatureToggle:'kicktodo-core'` auto-hides it when off.
- KickTodo already uses the shared `ui/` primitives + the `kicktodoClient` reads the tiles need.

## Decision
Register two tiles in `allTiles.ts`, each a `lazy()` projection gated `owningFeatureToggle:
'kicktodo-core'`:
- **`kicktodo-today`** — the participant's next "One Thing" action (the RFC-0436 One Thing
  card, compact) with a deep-link to `/kicktodo/today`; empty state when no active enrollment.
- **`kicktodo-progress`** — day X of Y + activities-done + percent for the primary active
  enrollment (from the progress projection), read-only, deep-links `/kicktodo/progress`.

Both compose the shared tile chrome + `ui/` tokens; no new data, no new backend.

> **Correction (P1, 2026-07-20):** the Proposed ADR named the second tile
> `kicktodo-streak`. The KickTodo progress projection (`ProgressView`) exposes
> `currentDay`/`durationDays`/`completedActivities`/`totalRequiredActivities` but
> **no streak field** — a "streak" tile would have to fabricate a number the data
> never carries (an LLM-EXCHANGE-style honesty break at the UI layer). Shipped as
> **`kicktodo-progress`** showing only real progress. Both tiles default
> `defaultEnabled:false` (opt-in via the tile picker) so they never disrupt an
> existing workspace's home; `owningFeatureToggle:'kicktodo-core'` hides them when off.

## Phased plan
| Phase | Ships | Status |
|---|---|---|
| P1 | the two `DashboardTileDef`s + their lazy components + i18n (4 locales) + `allTiles.ts` wiring | ✅ implemented 2026-07-20 — `KickTodoTodayTile.tsx`, `KickTodoProgressTile.tsx`, `allTiles.ts` (`kicktodo-today`/`kicktodo-progress`), dashboard i18n ×4 |

## Open questions
- OQ1: does the Today tile show a check-in affordance inline, or link out only? Start link-out
  (a tile is a projection, ADR 0082 — mutations happen on the page). **Resolved P1: link-out.**
- OQ2 (P1): default the tiles ON when `kicktodo-core` is enabled, for stronger participant
  signal on `/`? Shipped OFF (opt-in) to avoid mutating existing dashboards; revisit if
  KickTodo becomes a primary workspace surface.
