# ADR 0715 — Hub panels catch suspension but not failure, and the citation that says otherwise

Status: **implemented** (the fix ships in the same PR as this decision)

**Feature:** Access hub (`FEATURES.md` ordinal 212) · ADR 0144/0145 · feature-loop 2026-09 it.44
**Closes:** `AHU-1` (+ its four un-filed siblings) · **Files:** `AHU-5`

## Context

Every projection hub renders its active tab's lazily-imported route inside a
panel-level `<Suspense>`. `AccessHubPage.tsx:112-118` is representative:

```tsx
<TabPanel idBase="access" tabId={active}>
  {activeRoute ? (
    <Suspense fallback={<StateCard loading title={t('common:loading')} />}>
      <HubProvider scope={scope}>{activeRoute.element}</HubProvider>
    </Suspense>
  ) : null}
</TabPanel>
```

**`<Suspense>` catches suspension. It does not catch failure.** A rejected dynamic
import is an error, so it passes straight through and unwinds to the nearest error
boundary.

### The consequence is page-wide, not panel-scoped

The nearest boundaries are `App.tsx:439` and `chrome/SiteShell.tsx:100`, both
`<ErrorBoundary resetKey={location.pathname} label="…">`. So a failed chunk in ONE tab
replaces the ENTIRE console — header, scope pill and tab strip included.

And it stays replaced. Hub tabs are a **query parameter**: `useUrlTab` is built on
`useSearchParams` (`ui/Tabs.tsx:102-105`), so switching tabs never changes
`location.pathname`, so the boundary's `resetKey` never changes and the boundary never
resets. The user cannot reach the console's other, perfectly healthy tabs; only a full
reload recovers (the shell fallback's button is
`onRecover ?? (() => window.location.reload())`).

**This is not hypothetical on this host.** `CLAUDE.md` § "Deploying the demo app" records
that old assets are **pruned** on each frontend deploy and that `/` serves a stale shell
for a TTL window — a returning user requesting a pruned chunk is exactly this failure.

### The docblock above the gap describes the gap — for the other lane

The comment sitting directly above that `<Suspense>` explains why the boundary is there:

> PANEL-level Suspense. Every projected pane is a lazy feature route, so without a
> boundary here the suspension escapes to the SHELL boundary in `App.tsx`, which
> replaces the WHOLE page — the header and the tab strip with it. Switching tabs blanked
> the console and the user lost the control they had just used.
> `settings-shell/SettingsPage.tsx:54` already does this correctly; all four projection
> hubs now agree.

That is a precise description of the failure this ADR closes — written about
**suspension**, fixed for suspension, and left open for **errors**, whose blast radius is
identical and whose recovery is worse.

### The citation propagated the gap — both halves of it are wrong

`settings-shell/SettingsPage.tsx:54` is cited as the model. Measured:

- **The path is stale** — the file is `features/settings-shell/SettingsPage.tsx`.
- **The precedent does not do the thing it is cited for.** It has `Suspense` ×3 and
  `ErrorBoundary` ×**0**. It is a correct model for the suspension lane and no model at
  all for the error lane.

So "all four projection hubs now agree" is true, and that is the problem: they were made
to agree with a precedent covering one of two failure modes. This is `CLAUDE.md`'s own
recorded lesson — *a citation is a claim, not evidence* — reproduced exactly.

### Measured population

| Panel site | `Suspense` | `ErrorBoundary` |
|---|---|---|
| `features/access-hub/AccessHubPage.tsx` | ✅ | **0** |
| `features/models/ModelsHubPage.tsx` | ✅ | **0** |
| `features/chat-deployment/ChatDeploymentHubPage.tsx` | ✅ | **0** |
| `features/campaigns/CampaignStudioHubPage.tsx` | ✅ | **0** |
| `features/settings-shell/SettingsPage.tsx` (the cited precedent) | ✅ | **0** |

Five sites, not the one `AHU-1` filed. The row is a floor, as usual.

## Decision

### D1 — A panel-level `<ErrorBoundary>` at all five sites, keyed on the active tab

Wrap each panel's `<Suspense>` in the shared `ui/ErrorBoundary`, following the house
pattern already used at `App.tsx:439` and `SiteShell.tsx:100` (`resetKey` + `label`).
No new mechanism is introduced.

**`resetKey` must be the active TAB, not the pathname** — and this is the whole reason
the shell boundary cannot serve. Keying on `location.pathname` in a console whose tabs
are query params produces a boundary that never resets: one broken tab wedges the page
until reload. Keying on the tab id means a failed panel is scoped to that panel, and
moving to a healthy tab clears it.

### D2 — Correct the docblock, including the citation

The comment is rewritten to name **both** lanes and to stop presenting the settings page
as a model for error handling. The stale path is corrected in the same edit.

Leaving it would be worse than the original defect: the next reader would inherit a
citation that has already propagated this gap across four consoles once.

## Alternatives weighed

- **Rely on the shell boundary.** Rejected: measured above — it replaces the whole
  console and cannot reset on a query-param tab change.
- **Per-route boundaries inside each lazy feature.** Rejected: a chunk that fails to LOAD
  never executes, so a boundary inside it cannot exist yet. The boundary must be outside
  the lazy edge.
- **A `fallback` that silently renders nothing.** Rejected outright — that is the ADR 0708
  defect (a failure the user cannot see) in a new place.

## Not in scope

- **`AHU-2`/`AHU-3`/`AHU-4`** (cluster labelling, section accessible name, the silent
  English i18n fallback). `AHU-4` is the ADR 0708 family and deserves its own measured
  pass across every `defaultValue:` fallback, not a drive-by here.
- **`AHC-1b`** — re-verified still true and still zero-impact (all campaign tabs are
  `workspace`-tier); it needs a mixed-tier campaign tab to matter.
- **`AHC-1` is genuinely CLOSED**, verified at HEAD: `hubProjection.ts` carries
  `.filter((r) => r.tier !== 'admin' || isAdmin)` and all four callers pass `isAdmin`
  (grep-verified, no missed lane). Its honesty note — that the filter fires in zero real
  configs — was **re-measured and still holds**: access 6 tabs all `admin`, models 2 all
  `admin`, campaigns 4 all `workspace`, chat-deployment 2 all `workspace`. No console
  mixes tiers yet, so it remains defence-in-depth.

## A census error of mine, recorded

My first hub census reported **zero** tabs for the `access` hub and I nearly filed "the
Access hub surfaces nothing". False: `inHub` is `(route.hubTab.hub ?? 'access') === hub`
(`hubProjection.ts:19-21`), so access-hub tabs are exactly those that **omit** the `hub`
key — invisible to a grep for `hub: 'access'`. Checking the consumer before filing is
what caught it. A census that greps for a field is blind to that field's default.
