# ADR 0487 — `/` is always the public home; the Dashboard moves to `/dashboard`

Status: implemented

Supersedes the 2026-07-16 "dashboard graduated to `/`" correction in ADR 0375 /
ADR 0027.

## Context

`/` was **dual-purpose**: an anonymous first-time visitor saw the public marketing
home (`PublicShell`, ADR 0027), while a signed-in — or "app-entered" — browser saw
the **Dashboard** (which owned `path: '/'` after the 2026-07-16 graduation). Which
page rendered was gated in `App.tsx` by:

```
showFrontPage = onRoot && !user && !appEntered && pointer.enabled
```

`appEntered` was a `localStorage` marker (`openwop:app-entered`) stamped the moment
a browser rendered the app shell even once, and cleared only on explicit sign-out.

**The failure:** on a deployment with no real sign-in (the demo / white-label —
subjects are settled-anonymous, so there is no "signed-in" state to distinguish),
and any time the marker got stamped (a first-render race, or one prior app
navigation), `/` served the **Dashboard to a logged-out visitor** and the public
marketing home became effectively unreachable at `/`. A user reported exactly this
from a fresh incognito window.

The root cause is structural: a **dual-purpose root URL gated on a stateful marker**
is inherently fragile — marketing vs app at the same path, decided by localStorage.

## Decision

**Split the two surfaces onto distinct URLs.**

- **`/` is ALWAYS the public marketing home** for an anonymous visitor (rendered in
  `PublicShell`, gated only by the operator's front-page pointer being enabled). No
  `app-entered` marker; no dual-purpose root.
- **The Dashboard owns `/dashboard`** (its own stable URL), still leading the pinned
  nav cluster.
- **A signed-in visitor who lands on `/`** falls through to the app shell, whose `/`
  route (`RootRedirect`) redirects to `/dashboard`. **REVERSED 2026-09-11 — see the
  correction note below.** Legacy chat deep links
  (`/?conversation=` / `?agent=` / `?new=`) still forward to `/chat` first — that
  contract is load-bearing (stored notification actionUrls) and is UNCHANGED.

This restores ADR 0027's intent **unconditionally**: marketing for anonymous
visitors, never hidden behind a sign-in gate or a stateful marker.

## Changes

| Piece | Before | After |
|---|---|---|
| `features/dashboard/routes.tsx` | `path:'/'`→Dashboard; `/dashboard`→redirect to `/` | `path:'/dashboard'`→Dashboard; `path:'/'`→`RootRedirect` (→`/dashboard`, legacy→`/chat`) |
| `App.tsx` root gate | `onRoot && !user && !appEntered && pointer.enabled` | `onRoot && !user && (loading \|\| fpLoading \|\| pointer.enabled)` |
| `App.tsx` | stamps `openwop:app-entered` when the app shell renders | marker + effect + `APP_ENTERED_KEY` deleted |
| `auth/useAuth.ts` | clears the marker on sign-out | marker gone — nothing to clear |
| `chrome/Sidebar.tsx` | in-app brand → `/` | in-app brand → `/dashboard` |

Post-sign-in needs no explicit redirect: once `user` is set, `/` falls through the
front-page gate to the app shell, whose `RootRedirect` sends the visitor to
`/dashboard`. The account-deletion reload still targets `/` (a deleted account is
logged out → the public home, which is correct).

### Correction (code review): the gate must let legacy chat deep links through

`RootRedirect` (which forwards `/?agent=`/`/?conversation=`/`/?new=` to `/chat`)
lives in the app-shell route tree, so it only runs when the app shell renders. The
old `app-entered` marker used to keep `showFrontPage` false once the app had
rendered, so those deep links reached it. Removing the marker exposed a gap: on a
no-real-sign-in deploy (settled-anonymous — the whole demo/white-label population),
`/?agent=…` matched `onRoot && !user && pointer.enabled` and short-circuited to the
marketing page **before** `RootRedirect` could forward it — breaking every live
"Ask `<agent>`" button (ADR 0058). Fix: the marketing gate **excludes** legacy chat
params, so those URLs fall through to `RootRedirect` for anon too. The gate + the
param set now live in ONE side-effect-free module (`chrome/rootRoute.ts`,
`shouldShowFrontPage` / `LEGACY_CHAT_PARAMS`) shared by `App.tsx` and the dashboard
forwarder, and are unit-tested directly (`chrome/__tests__/rootRoute.test.ts`).
Also: in-app `navigate('/')` after deleting a canvas → `navigate('/dashboard')`
(an anon user must not be ejected to the marketing page).

## Boundaries audit

- **No core→feature import.** The dashboard feature still declares its own routes;
  core never claims `/` or `/dashboard` (ADR 0001 preserved).
- **No wire change.** This is entirely frontend routing — no RFC.
- **Legacy deep links preserved.** `RootRedirect` keeps the `/?conversation=`→`/chat`
  contract the home-graduation grade pass pinned.

## Alternatives weighed

- **Keep the dual `/`, just fix the anon-detection.** Smaller, but leaves the
  fundamentally fragile "marketing-or-app at the same URL" model — the thing that
  surprised the user. Rejected in favor of the clean split (the operator's choice).

## Follow-ups / open questions

- `navigate('/')` calls elsewhere in the app now resolve to `/dashboard` via
  `RootRedirect` (one extra hop, functionally correct). A sweep to point in-app
  "home" intents directly at `/dashboard` is a harmless cleanup, not required.
- The demo funnel into the app is the PublicShell "Explore the demo → /chat" chip +
  Sign-in; unchanged.

## Correction 2026-09-11 — the signed-in redirect is reversed

**What changes.** `/` renders the public front page for **every** visitor when the
operator's front-page toggle is on, not for anonymous visitors only. A signed-in
visitor gets an "Open app" affordance on the page instead of being redirected past
it. With the toggle **off**, `/` is the app shell for everyone and `RootRedirect`
still sends a signed-in visitor to `/dashboard` — unchanged, and exactly what that
toggle's OFF case promises.

**Why this is a bug fix and not only a preference.** The operator control did not
do what it said. Its label is unqualified:

> "Show the front page at / (off ⇒ / is the app for everyone)"

The parenthetical defines the OFF case as *everyone*; by symmetry ON means the
front page for everyone. The confirmation toast agrees — *"Front page is now shown
at /"* — and names no visitor class. Neither mentions that a signed-in visitor is
excluded. A downstream operator turned it on, was told it was on, and still could
not reach the page.

**It was enforced twice, which is why it read as immovable rather than as a bug.**
`chrome/rootRoute.ts` ANDed `!hasUser` into the gate, and `App.tsx` separately
passed `!user` into `useFrontPage`, so the pointer was never even fetched for a
signed-in visitor and `frontPageEnabled` fell back to `false`. Removing either one
alone changes nothing.

**A gate that discards an input also hides that input's DEFAULT — and this one was
never chosen.** `OPENWOP_FRONTPAGE_DEFAULT_ENABLED` is ON unless explicitly set to
`'false'` (`host/siteConfig/service.ts:31`), and nothing in the tree sets it: a
definition, a `.env.production` comment saying it belongs on Cloud Run, two doc
mentions, and one test that deletes it. No deployment opts out.

While `!hasUser` was ANDed into the gate, that default was **inert for signed-in
visitors** — the clause discarded it before it could decide anything. Removing the
clause did not only fix the gate. It promoted the default from inert-for-signed-in
to load-bearing-for-everyone, on every existing deployment, with no config change
anywhere to mark the moment.

So the sentence a future reader needs is not only *"the gate was wrong"*. It is
*"and `/` moved on deployments that changed no configuration"*, because that is the
question they will actually arrive with. The toggle's value did not change; its
consequences did, and nobody selected them. An operator who wants the previous
signed-in behavior sets `OPENWOP_FRONTPAGE_DEFAULT_ENABLED=false` or toggles the
front page off — the OFF case is unchanged and still sends a signed-in visitor to
`/dashboard`.

This is the reason the correction is filed as a reversal *plus* a default-semantics
note rather than as a one-line code fix: the code defect was two clauses, and the
deployment-visible change is a third thing neither clause names. Found in review by
a second reader (`openwop-app-1`) after merge, not by either author's gates —
neither of which covered the combination.

**This ADR's own reasoning does not block the reversal.** 0487 reversed the
2026-07-16 "dashboard graduated to `/`" because a dual-purpose root *"was fragile
and could strand LOGGED-OUT visitors on the dashboard"*. Always-front-page-at-`/`
is the opposite failure direction: it cannot strand a logged-out visitor anywhere.
The concern that motivated this ADR is not recreated by correcting it.

**What is NOT reversed.** The URL split itself — the Dashboard keeps its own stable
`/dashboard`, and the legacy chat deep-link forward to `/chat` is untouched. Those
were the load-bearing halves of this decision and they stand.

Raised by a downstream white-label distribution (KickTodo), whose operator asked
why `kicktodo.com/` redirected them past their own marketing page.

## Implementation record

| Piece | Location |
|---|---|
| Route split + `RootRedirect` | `features/dashboard/routes.tsx` |
| Root gate + marker removal | `App.tsx`, `auth/useAuth.ts` |
| In-app brand + manifest note | `chrome/Sidebar.tsx`, `chrome/features.tsx` |
| Tests | `features/dashboard/__tests__/homeContract.test.tsx`; e2e `smoke.spec.ts` + `keyboard.spec.ts` boot the app at `/dashboard` |
