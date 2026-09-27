# ADR 0719 — Two console tabs never render: their `featureId` names a toggle that was retired

Status: **implemented** (the fix ships in the same PR as this decision)

**Feature:** Chat deployment console (`FEATURES.md` ordinal 216) · ADR 0145/0200 · feature-loop 2026-09 it.48
**Corrects:** ADR 0718 (this loop's it.47) — a reachability claim of mine that was false

## Context

`visibleHubRoutes` gates each projected tab on `isVisible(r.hubTab.featureId)`, and
`useFeatureVisible` is (`FeatureAccessContext.tsx:152`):

```ts
(featureId?: string) => !featureId || byId[featureId]?.enabled === true;
```

`byId` is built only from `/assignments`, which returns **registered toggles**. When a
feature GRADUATES to always-on it declares no `toggleDefault`, `registerToggleDefault` is
never called for it, and `listEffectiveConfigs` — which seeds from `listToggleDefaults()`
— never lists it. Its stored rows are deleted at boot by design (*"Delete stored toggle
configs whose feature no longer declares a default (it GRADUATED to always-on)"*).

So for a graduated id, `byId[id]` is `undefined`, `undefined?.enabled === true` is `false`,
and the tab is filtered out.

**`useFeatureVisible` cannot distinguish "this toggle does not exist" from "this toggle is
off."** The same file already draws that distinction elsewhere — `resolutionFailed`
(TWIN-UX-1) exists precisely so *"every `enabled:false` below is 'unknown', not 'off'"* on
a failed read. The absent-id case has no such treatment.

### Measured

Two tabs declare a `featureId` whose toggle is in `RETIRED_TOGGLE_IDS`:

```
models:          declared=2 visible=1  LOST=leaderboard      (featureId 'evals')
chat-deployment: declared=2 visible=1  LOST=scheduled-chats  (featureId 'scheduled-agent-chats')
campaigns:       declared=4 visible=4  LOST=none
access:          declared=6 visible=6  LOST=none
```

Both consoles then take their *"one visible destination: a one-position switch is noise"*
branch and render the surviving pane with **no tab strip at all** — so the missing tab
leaves no trace in the UI.

`model-router` and `chat-widget` are graduated too and get this right by **omitting**
`featureId`. The two broken tabs kept an id that was retired out from under them.

### This falsifies a claim I shipped one iteration ago

ADR 0718 D1 retargeted two inbound links to `/models?tab=leaderboard`. That tab does not
render, so `useUrlTab` falls back to the first tab and the user lands on **Routing**.

Worse, ADR 0718's own witness asserted:

```ts
expect(evalsRoute?.hubTab?.hub, '…and is projected into the models console').toBe('models');
```

That checks the **declaration**, not the **visibility** — the same error as the guard it.47
was written to fix. It is the fourth variant of one shape in six iterations (0714 fixture
certified its own defect · 0715 ratchet counted prose · 0718 guard queried the wrong
collection · this one asserted a declaration and called it reachability), and I authored
this one while documenting the other three.

**ADR 0718's fix is still correct** — the old destination was a different feature's page —
but its stated reason was wrong, and D3 below corrects it rather than leaving it.

## Decision

### D1 — Drop the retired `featureId` from both tabs

`scheduled-chats/routes.tsx` and `evals/routes.tsx` omit `featureId`, matching
`model-router` and `chat-widget`. `isVisible(undefined)` is `true`, so the tab renders —
which is correct, because an always-on feature has nothing to gate on.

This is not a widening. Both features are graduated: their gates are open by decision, and
the route's own `tier` still governs who may reach it.

### D2 — A cross-workspace guard, where the SSoT lives

The frontend cannot know which toggles are registered — that is exactly why this was
invisible. The backend owns both `RETIRED_TOGGLE_IDS` and the registry, and this repo
already has backend tests that read `frontend/react` (`access-header-parity.test.ts` and
others), so the check belongs there:

**every `hubTab.featureId` in the frontend manifest must name a feature that registers a
toggle default.** A featureId naming a retired or non-existent toggle fails the suite with
the consequence spelled out, instead of silently removing a tab.

### D3 — Correct ADR 0718's claim and its witness

The leg that asserted `hubTab.hub === 'models'` under the label "is projected into the
models console" is rewritten to assert **visibility through the real projection**. The ADR
text gains a correction note pointing here.

Leaving it would leave a green test asserting reachability it never checked — which is the
precise defect ADR 0718 was written about.

## Alternatives weighed

- **Make `useFeatureVisible` return `true` for an unknown id.** Rejected: that is
  fail-OPEN for every consumer of the hook, not just hub tabs — a genuinely off toggle
  whose registration is late or missing would render its surface. The bug is the stale
  `featureId`, not the hook's conservatism.
- **Warn at runtime when a projection drops a tab for an unknown id.** Useful, but a
  console warning nobody reads is not a guard; D2 fails the build instead. Worth adding
  later as a dev-mode aid.
- **Leave the tabs gated and rely on the standalone routes.** Rejected: ADR 0145's whole
  point is one canonical destination per surface, and `/leaderboard` is not even reachable
  for evals (ADR 0718 — a different feature owns that path).

## Not in scope

- **`CDU-2` / `MHU-2`** (a redundant `u-wrap` class) — cosmetic, unchanged.
- **`CDC-1` / `CDC-2`** — re-verified CLOSED at HEAD: the projection carries the tier
  filter, and ADR 0610 D6 relocated `/chat-deployment`, `/scheduled-chats` and `/widgets`
  to `tier:'workspace'` with `archetype:'standard-index'`, matching their
  `workspace:write` backends.
