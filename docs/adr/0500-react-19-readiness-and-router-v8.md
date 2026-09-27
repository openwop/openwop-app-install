# ADR 0500 — React 19 readiness and the react-router v8 chain

Status: **Accepted** — decision recorded; the upgrade itself is deliberately NOT
scheduled here. Phase A of the plan; B and C are gated (see § Triggers).

## Context

`npm audit` reports two high advisories against `react-router`
(**GHSA-qwww-vcr4-c8h2**, an RSC-mode CSRF bypass). They have been excepted since
ENG-13 (#2638) and the exception was corrected in #2681 once the real blocker chain
was measured.

> **RESOLVED 2026-08-25 (ADR 0607) — and NOT the way this ADR predicted.** The
> advisory is gone at **react-router 7.18.2**, reached by a plain
> `npm audit fix` (`added: 0, removed: 0`, package.json untouched). The exception
> entry has been deleted; `check-audit` fails on a stale one, which is how this
> surfaced within minutes rather than sitting until the 2026-10-31 revisit.
>
> The entry's `removeWhen` said *"react-router is on >=8.3.0"* — it treated the
> **v8 migration** as the only exit, because the decision below is about whether
> that migration is worth doing. **A patch release inside the declared `^7.0.0`
> range was never in the exit condition.** Worth noting as a pattern: an exit
> condition written from the expensive fix can outlive the advisory it exists
> for, and the entry would have kept describing a blocker that no longer existed.
>
> **Everything below still stands.** The v8/React-19 analysis was never
> *justified* by this advisory — §"The advisory does not justify the work" says so
> in as many words — so removing the advisory removes nothing from the decision.
> This ADR remains `Accepted`, and the deferral remains correct.

The correction matters, because the record previously described the fix as *"a
7 → 8 migration with a regression surface across every route"*. Measured by
attempting it rather than reading release notes:

```bash
npm install react-router-dom@^8.3.0   ->  notarget
    react-router-dom DOES NOT EXIST at 8.x; it stops at 7.18.2. v8 folds the DOM
    exports back into `react-router`, so all 308 files importing from
    'react-router-dom' need their import SOURCE rewritten.

npm install react-router@^8.3.0       ->  ERESOLVE
    peer react >=19.2.7 AND react-dom >=19.2.7.  This app is on ^18.3.1.
```

So the advisory is not gated behind a router migration. It is gated behind a
**React major**. This ADR records what that would cost, what it would buy, and why
it is not being done now.

## The readiness evidence

This is the perishable part and the main reason to write this down: every figure
below can move, and re-deriving it costs a session.

**Every React-coupled dependency already accepts React 19.** Declared peer ranges,
read from **`frontend/react/package-lock.json` at `5ff27f2ff`** — deliberately the
lockfile rather than a local `node_modules`, because a working tree can be stale
against the commit it sits on (that exact trap produced a wrong react-router version
in the first draft of this analysis, and #2666 was a lockfile desync nobody saw for
hours):

| package | installed | react peer range |
|---|---|---|
| `@testing-library/react` | 16.3.2 | `^18.0.0 \|\| ^19.0.0` |
| `@tiptap/react` | 3.27.3 | `^17.0.0 \|\| ^18.0.0 \|\| ^19.0.0` |
| `@xyflow/react` | 12.10.2 | `>=17` |
| `react-i18next` | 16.6.6 | `>=16.8.0` |
| `react-markdown` | 10.1.0 | `>=18` |
| `react-easy-crop` | 5.5.7 | `>=16.4.0` |
| `@vitejs/plugin-react` | 4.7.0 | (no react peer) |

**Zero React 19 removals are present in app code:**

```text
ReactDOM.render 0 · ReactDOM.hydrate 0 · findDOMNode 0 · react-test-renderer 0
propTypes 0 · string refs 0 · entry already uses createRoot + StrictMode
```

Two greps looked like hits and were **false positives**, recorded so nobody
re-raises them: `defaultProps` is a local helper function in
`canvas/CanvasEditorPage.tsx:114`, not `Component.defaultProps`; and every `ref="`
match was the tail of `href="`.

**The router half is the easy half.** All 308 sites use only the stable declarative
API — `Link` 131, `useNavigate` 66, `useSearchParams` 45, `useParams` 29,
`Routes`/`Route` 26 each, `useLocation` 16, `Navigate` 5, `NavLink` 3, `Outlet` 1,
`BrowserRouter` 1. There is **no** `createBrowserRouter`, `RouterProvider`,
`loader`, `action` or `<Form>` — none of the data-router surface where v8's
breaking changes concentrate.

**Where the cost actually lands:** `@types/react` / `@types/react-dom` 18 → 19,
across 474 frontend test files. React 19's types tighten `useRef` (initial argument
required), move the JSX namespace, and narrow `ReactNode`. That is a typing slog,
not a redesign — but it is the whole bill, and it is not small.

## Decision

**Record readiness; do not schedule the upgrade on the advisory's account.**

The advisory does not justify the work. `GHSA-qwww-vcr4-c8h2` is an **RSC-mode**
CSRF bypass and this app is a plain `<BrowserRouter>` SPA: zero references to
`unstable_createCallServer`, `RSCHydratedRouter`, `@react-router/rsc` or
`unstable_RSC` anywhere in `frontend/react/src`. **The vulnerable code path does not
exist in this build.** Doing a framework major to clear a signal that represents no
reachable exposure is optimising the indicator rather than the outcome.

That distinction is not academic here. This codebase has repeatedly found checks
whose green meant nothing: `role="status"` present but never announced (#2620), a
`check-i18n` pass for a key that existed only inside a comment, `npm run ci`
reporting exit 0 having run nothing, `--force-with-lease` protecting against a race
but not against the wrong branch. **An advisory being reported is likewise not the
same as a risk being present**, and the exception mechanism exists precisely so
that call can be made explicitly instead of by reflex.

### Alternatives weighed

| option | cost now | debt left | reversibility |
|---|---|---|---|
| Upgrade now (React 19 + router v8) | Highest: types churn over 474 test files, 308 import rewrites, an exclusive frontend window against two live peer branches | none on this axis | Poor — not cleanly revertible once tests are rewritten |
| **Record readiness, gate the upgrade (chosen)** | Low: this document | Exception carries to its `revisitAfter`, already enforced | Excellent |
| Do nothing | Zero | Readiness data lost; the next attempt re-derives it | n/a |

### Costs this buys, stated plainly

Two high advisories stay reported for up to three more months, against a path that
cannot execute in this build. `npm audit` output stays noisy. Both are accepted.

## Consequences

**A new coupling to name before anyone adopts v8.** `react-router@8.3.0` requires
`react >=19.2.7` while the latest React was 19.2.8 **as of 2026-07-29** (28 stable
19.x releases) — its floor is effectively the then-current release. Adopting v8 ties
this app's React patch cadence to react-router's peer floor. That gap is the figure
to re-check rather than trust: if it has widened by the time you read this, this
coupling has loosened and the cost below is smaller than stated. Today `^7.0.0` is satisfied by a React from two years ago. That is a
permanent architectural cost the advisory framing hides, and it should be a
deliberate choice rather than a side effect of clearing a gate.

**jsdom cannot verify a React major.** The 474 frontend test files run in jsdom, and
React 19's changes are concentrated in runtime semantics — ref cleanup functions,
effect timing under `StrictMode`, hydration. jsdom will pass all of them. The real
net is the Playwright e2e lane, which is **opt-in** (`OPENWOP_CI_E2E=1`) and off by
default. Any future attempt at Phase B MUST run that lane; `npm run ci` green is
necessary and not sufficient here.

**The specific thing jsdom will not catch is the accessibility work shipped this
week, and Phase B/C MUST re-verify it.** Effect timing and ref cleanup — the two
areas React 19 changes most — are exactly the layer the announcement fixes depend
on. A live region announces on *mutation after mount*, so a change in when effects
run or when a conditionally-mounted node is inserted can silently un-announce every
one of them:

- `<Notice announce>` delegating to the shell's primed region (#2620)
- toast's 315 non-error uses routed through `announce()` at `push()` (#2632)
- the six action-result notices that told a user when they failed but not when they
  succeeded (#2637)

**Every one of those defects passed markup-level checks while announcing nothing.**
`role="status"` was present and silent; the tests asserted the attribute, not the
announcement. jsdom cannot tell the difference, and neither could we until the
mechanism was read from the spec. A React major that regresses them would be
invisible to `npm run ci`, to `check-failure-card-announce`, and to all 474 test
files simultaneously.

**Concretely, Phase B/C acceptance MUST include:** the `announce()` delegation tests
(`ui/__tests__/noticeAnnounce.test.tsx`, `toastAnnounce.test.tsx`,
`announce.test.ts`) green; the e2e lane run; and a manual pass on route-change focus
and skip-link behaviour, because Phase C rewrites all 308 navigation call sites
(`Link` 131, `useNavigate` 66, `NavLink` 3) and route-transition focus handling is
the classic SPA a11y regression.

**`ARCHITECTURE.md`'s contract is neutral, not satisfied.** That checklist governs
features, agents, workflows, routes and admin surfaces — things that can become
parallel systems. A dependency major creates none, so it neither passes nor fails.
Recorded so a future reviewer does not read silence as approval.

**Sequencing is a hard gate, not a size objection.** A 308-file import rewrite plus
`@types/react` churn would force any concurrent frontend branch into an
unresolvable rebase. Three sessions work this tree in parallel. Phase C needs an
exclusive window, announced.

## Triggers — what moves this from recorded to scheduled

Any ONE of these makes the upgrade the right call; none of them is "the advisory is
still reported":

1. **React 18 leaves security support.** The upgrade becomes maintenance, not choice.
2. **The app adopts a data router, SSR, or RSC.** This makes GHSA-qwww-vcr4-c8h2
   **reachable** and voids the exception's reachability argument immediately — check
   this FIRST when revisiting, ahead of the date.
3. **A product requirement needs a React 19 feature** — `use`, form actions, owner
   stacks, the new `<title>`/`<meta>` hoisting.
4. **`revisitAfter` (2026-10-31) arrives.** `check-audit` fails the build on an
   expired exception, forcing the assessment to be re-made rather than inherited.

## Open questions

- **OQ1 — is the e2e lane sufficient as the React 19 net?** It is opt-in today and
  its coverage of router navigation has not been measured against the 308 sites.
  Answer this BEFORE Phase B, not during it.
- **OQ2 — does react-router 8 fit the 130 kB entry budget?** Unmeasured. 7.18.1
  alone cost ~0.3 kB. The budget gate would catch a regression, but it should not be
  the first time anyone looks.
- **OQ3 — should the readiness table be re-measured on a schedule?** Every peer
  range above can move; a stale "all clear" is worse than none. The `revisitAfter`
  date is the natural point.

## Implementation record

| Phase | What | Status |
|---|---|---|
| A | This ADR — readiness measured, decision recorded | **done** |
| B | React 18 → 19 (`react`, `react-dom`, `@types/*`) | **gated** — see Triggers; requires the e2e lane (OQ1) |
| C | `react-router-dom` → `react-router` v8, 308 import sources, **delete the audit exception in the same PR** (`check-audit`'s STALE arm fails the build otherwise) | **gated** on B |
| D | Verify + frontend-only deploy | **gated** on C |

Related: #2681 (the corrected exception), #2638 / ENG-13 (the sweep that surfaced
it), `scripts/audit-exceptions.json` (`GHSA-qwww-vcr4-c8h2`),
`scripts/check-audit.mjs` (the three-arm gate this ADR relies on).
