# ADR 0183 — Manual-test runner: feature-package + category hierarchy + durable per-user runs

**Status:** Accepted (2026-07-01)
**Track:** A (Software & App Architecture) — host-extension only; **no OpenWOP wire change → no RFC**.
**Owner:** the `/manual-tests` skill authors the suite content (`suites.ts`) + the `docs/steward/MANUAL_TESTS.md`
tracker; this ADR records the *architecture* change to the surface that renders them.

## Context

The manual-test runner at `/test` (authored by the `/manual-tests` skill) already matched the
myndhyve runner (`myndhyve.ai/docs/manual-tests`) — TestSuite → TestCase → TestStep, a progress
meter, filtering, toggle-aware "enable-first" recipes, and a Markdown "Copy run log" export — and
was **ahead** of myndhyve on two axes myndhyve lacks: **persistence** (myndhyve's run state is an
in-memory module var wiped on refresh; ours was localStorage) and **staleness tracking**
(`sourceCommit`/`sourceFiles` + the `docs/steward/MANUAL_TESTS.md` coverage audit). A deep-dive comparison found
myndhyve's genuine advantage is **navigation architecture**: a third grouping level
(**Category** → Suite → Case) with color-coded, collapsible sections + roll-up progress, plus a
path-linkifier. At 39 flat suites ours had outgrown a single grid.

Two standing convention gaps also applied regardless of myndhyve: the runner had **no i18n**
(every other page is 4-locale) and lived in a bespoke `src/test/` area registered directly in the
core `chrome/features.tsx` manifest rather than a `features/<id>/` package (ADR 0001).

## Decision

Bring the runner to full parity by **porting myndhyve's superior navigation architecture onto our
already-superior base** (never regressing persistence / toggle-recipes / export / tracker):

1. **Category hierarchy.** Add `TestCategory { id, title, colorKey }` and a `category` field on
   `TestSuite`; group the 39 suites into 7 product-area categories. The suite list renders as
   collapsible category sections with per-category roll-up progress. Port the **path-linkifier**
   (route substrings in steps/expected → clickable links).
2. **Feature-package.** Move `src/test/` → `frontend/react/src/features/manual-tests/`, wired via
   `FRONTEND_FEATURES` in `registry.ts` (remove the core-manifest entry). Admin-tier, Platform nav.
3. **i18n.** 4-locale catalogs (`en`/`pt-BR`/`fr`/`es`); all chrome via `useTranslation('manual-tests')`.
   Suite/case *content* stays English (it is test-authoring data, not product UI — the same posture
   myndhyve takes; localizing 84 cases is out of scope and low-value).
4. **Durable per-user runs.** A backend `features/manual-tests/` package persists run results in a
   `DurableCollection<ManualTestRun>('manual-tests:run', …, tenantOf)` keyed
   `${tenantId}:${subjectRef}:${suiteKey}` — the **per-user UI-state precedent** (ADR 0071
   `uiStateStore`): structural authorization (a caller reads/writes only their own rows), tenant
   index for bounded scans. The FE client reads/writes this over
   `/v1/host/openwop-app/manual-tests/*`, with **localStorage as an offline cache/fallback** so a
   run survives even when the backend is unreachable. Result: runs are per-user and cross-device,
   not device-local-anonymous.

## Boundaries audit

- **No route/namespace collision:** `/v1/host/openwop-app/manual-tests/*` is unclaimed; the FE
  `/test` route is preserved (moved, not renamed).
- **No duplicated store:** run state is a NEW concept (no existing owner); it composes the
  `DurableCollection` primitive + the `uiStateStore` subject/tenant pattern, not a fork.
- **No wire:** host-extension under `/v1/host/openwop-app/*`; nothing advertised at
  `/.well-known/openwop`. No RFC.
- **Content ownership unchanged:** `suites.ts` + `docs/steward/MANUAL_TESTS.md` remain the `/manual-tests`
  skill's authoring surface; this ADR only changes where they live + how they render + where runs persist.

## Alternatives considered

1. **Literal "copy myndhyve wholesale."** Rejected — it would regress persistence (→ in-memory,
   lost on refresh) and drop the toggle-recipes/export/tracker. We port only the parts where
   myndhyve is genuinely better (the category nav + linkifier).
2. **Keep localStorage only.** Rejected — runs stay device-local + invisible to teammates; the
   `uiStateStore` precedent makes per-user durable state cheap and correct.
3. **Localize the 84 test cases.** Rejected as out-of-scope/low-value — testers are internal;
   content stays English (myndhyve does the same). Only the runner *chrome* is localized.

## Phased plan

- **P1 — Backend:** `features/manual-tests/{manualTestsService.ts, routes.ts, feature.ts}` +
  register in `BACKEND_FEATURES`; route-harness test (own-rows-only isolation, save/get round-trip).
- **P2 — FE data model + categories:** `TestCategory` + `category` on `TestSuite`; assign 39 suites.
- **P3 — FE feature-package + runner rewrite:** move to `features/manual-tests/`, category-grouped
  collapsible list + roll-up progress + linkifier, `manualTestsClient.ts` (backend + localStorage
  fallback), 4-locale i18n, `routes.tsx` + `registry.ts`; remove the core-manifest entry.
- **P4 — Verify + tracker note:** backend tsc/vitest + FE build green; `docs/steward/MANUAL_TESTS.md` changelog
  note (the skill's tracker records the architecture move).

## Open questions

- [ ] Should suite content eventually be localized? (Deferred — internal testers; English content.)
- [ ] Server-driven suite catalog (vs the hand-maintained `suites.ts`)? Out of scope; the skill owns authoring.
