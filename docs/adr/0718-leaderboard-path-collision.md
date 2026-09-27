# ADR 0718 — Two features own `/leaderboard`, and the test that guards it cannot see which

Status: **implemented** (the fix ships in the same PR as this decision)

**Feature:** Models console (`FEATURES.md` ordinal 215) · ADR 0145/0123 · feature-loop 2026-09 it.47
**Closes:** `MHC-2` (and corrects its description) · **Ticks:** `MHU-1`, `CDU-1` (closed by ADR 0715)

## Context

Two unrelated features declare the same frontend path:

| owner | element | tier | nav |
|---|---|---|---|
| `evals` (`features/evals/routes.tsx:10`) | `LeaderboardPage` — model/agent **Elo** | `admin` | none (subsumed by the Models console, ADR 0145) |
| `kicktodo-engagement` (`features/kicktodo-engagement/routes.tsx:15`) | `EngagementPage` — opt-in **gamification** board | `site` | a real rail entry, "Leaderboard" |

Measured across the whole manifest, this is the **only** duplicated path:

```
CLAIMANTS:         evals[tier=admin]  |  kicktodo-engagement[tier=site]
FIRST IN MANIFEST: evals
SITE-TIER WINNER:  kicktodo-engagement
DUPLICATE PATHS:   1
```

### The resolution inverts the familiar rule, which is how this survived

The usual guidance — and the architecture review's own lead check — is *"first registrant
wins; a later overlapping route is silently shadowed."* By that rule `evals` wins: it is
first in `FEATURES`.

It does not. `App.tsx:257` selects a **site-tier** route by path **before the router runs**:

```ts
const siteRoute = FEATURES.find((f) => f.tier === 'site' && matchPath({ path: f.path, end: true }, location.pathname) !== null);
```

Shell selection has to happen before routing, so a `site` claimant pre-empts an `admin`
one regardless of manifest order. **`/leaderboard` renders KickTodo's gamification page.**
Anyone reasoning from "first registrant wins" concludes the opposite.

### Two inbound links are user-visibly wrong

- `features/dashboard/tiles/ModelLeaderboardTile.tsx:24` — a tile documented as *"top
  models by Elo/win-rate"* maps each row to `to: '/leaderboard'`. Clicking a **model name**
  lands on the gamification board.
- `features/evals/ArenaPage.tsx:198` — a **"Back to leaderboard"** button. A back
  affordance that navigates to an unrelated feature is worse than a merely wrong link: the
  user is trying to return to where they were.

`/model-router`, the twin cited alongside it in `MHC-2`, is **not** duplicated and works
exactly as ADR 0145 intended. The row treated the two as the same nit; they are not.

### ADR 0145's promise is false for this route — and its test cannot fail

`chrome/__tests__/adr0145-rehoming.test.ts:38` is named:

> `keeps the legacy routes reachable for deep links (no redirect)`

and asserts `expect(byPath('/leaderboard')?.element).toBeTruthy()`, where
`byPath = (p) => FEATURES.find((r) => r.path === p)` (`:12`). `find` returns the **first**
match — `evals` — so the assertion passes on a manifest entry the router never reaches.

**The test measures manifest membership; the promise is about resolution.** It is green on
a route that is not reachable, under a name asserting reachability. Line `:35`
(`byPath('/leaderboard')?.nav` is undefined) has the same blind spot: it inspects the evals
entry while the *other* claimant supplies a nav entry for that path.

This is the third variant of one shape in five iterations — ADR 0714's fixture that
certified the defect it was named for, ADR 0715's ratchet that counted prose, and now a
guard that queries the wrong collection. **Each was green, each was named for the thing it
failed to check.**

## CORRECTION (ADR 0719, one iteration later) — the reachability claim below was FALSE

This ADR states that the model leaderboard "IS reachable, via its console tab", and D1
retargets two inbound links to `/models?tab=leaderboard` on that basis.

**The tab did not render.** It declared `featureId: 'evals'`, and `evals` graduated to
always-on, so its toggle is in `RETIRED_TOGGLE_IDS` and never appears in `/assignments`.
`useFeatureVisible` reads `byId['evals']?.enabled === true` against an absent entry —
`false` — and the projection filtered the tab out. With one tab left, the console took its
"one visible destination" branch and dropped the tab strip entirely, so the loss was
invisible. `useUrlTab` then fell back to the first tab, landing those retargeted links on
**Routing**.

**D1 remains correct** — the previous destination was a different feature's gamification
page — but its stated reason was wrong.

**And this ADR's own witness made the error it was written about.** The leg asserting
`evalsRoute?.hubTab?.hub === 'models'` under the label "is projected into the models
console" checks the DECLARATION, not the VISIBILITY. That is the fourth variant of the
shape catalogued below, committed while documenting the other three. ADR 0719 D1 removes
the stale id, D2 adds a cross-workspace guard where the toggle registry lives, and D3
rewrites that leg to assert through the real projection.

## Decision

### D1 — Point both inbound links at the canonical console

`/models?tab=leaderboard` (verified: the Models hub projects tab ids `model-router` and
`leaderboard`). This is what `MHC-2` already recommended, it works today, and it is the
"one destination" ADR 0145 exists to establish.

This does not restore `/leaderboard` for the model leaderboard — that path belongs to
`kicktodo-engagement`, which owns it with a nav entry and user-facing bookmarks. Taking it
back would break a shipped, user-visible surface to serve an admin page that already has a
canonical home.

### D2 — Make the guard measure RESOLUTION, and state the truth

`adr0145-rehoming.test.ts` gains a resolver that mirrors `App.tsx`'s real precedence
(site-tier first, then manifest order) and asserts against **that**, so a claim about
reachability is tested as reachability. The `/leaderboard` expectation is corrected to
state what is true — the path resolves to `kicktodo-engagement`, and the model leaderboard's
reachable home is the console tab.

Leaving the old assertion would leave a green test asserting a false promise, which is
exactly how this survived.

### D3 — A composition-time duplicate-path guard

`chrome/features.tsx` already enforces a site-route contract **at composition** (ADR 0641
phase 5, `:338-342`) precisely because *"a violation fails at import rather than when a
visitor happens to reach the route."* The same seam gains a duplicate-path check.

The one existing pair is recorded explicitly as a known, explained exception rather than
silently tolerated, so the guard fails on any **new** collision while documenting this one.
Shrink-only: the exception list may lose entries, never gain them.

## Alternatives weighed

- **Rename the evals route** (e.g. `/model-leaderboard`) to restore ADR 0145's promise.
  Rejected for now: it changes the console tab id, hence the `?tab=` URL and the
  `tab_leaderboard` i18n key across four locales, to un-shadow a path whose only inbound
  links D1 is already retargeting. Recorded as the option to take if the standalone route
  ever needs to be genuinely deep-linkable.
- **Take `/leaderboard` back for evals.** Rejected: `kicktodo-engagement` has the nav entry
  and the user-facing surface; an admin page with a canonical console home has the weaker
  claim.
- **Leave it as a Nice-to-have.** Rejected on measurement: a "Back" button that leaves the
  feature is not cosmetic, and the guarding test is green on a false promise.

## Not in scope

- **`MHU-2`** (a redundant `u-wrap` class on the tab strip) — cosmetic, unchanged.
- **`MHU-1` / `CDU-1`** — already closed by ADR 0715 (this loop's it.44); verified at HEAD
  (`ModelsHubPage` 1 boundary, `ChatDeploymentHubPage` 2) and ticked, not re-implemented.
