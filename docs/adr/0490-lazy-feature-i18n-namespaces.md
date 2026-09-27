# ADR 0490 — `en` feature catalogs load with their page, not with the shell

Status: implemented (2026-07-25)

## Context

The eager `i18n` chunk had become the largest non-vendor asset in the app:
**233.0 kB gzip**, against a ceiling that had been raised **twice in two days**
(227 → 232 → 236 kB) by the feature-by-feature UX programme. Each raise was
individually defensible — real localized product copy, ~85 user-facing keys per
batch across four locales — and each was recorded rather than done silently. The
second note said explicitly that the next bump *"should code-split the locale
bundle per namespace instead"*, and then the third raise happened anyway.

The forcing question came from a parallel session measuring the run rate: the
programme costs **~0.27 kB per feature**, the remaining Admin section is 25+
features (**≈6.8 kB**), and only **3.0 kB** of headroom remained. A fourth raise
was arithmetically certain.

`en` is special: it is both the source-of-truth catalog and i18next's
`fallbackLng`, so it must paint with no network round-trip. That is what made
"just make it lazy like the other locales" (ADR 0329) look unavailable.

## Decision

**Split `en` by AUDIENCE rather than by locale: the shell stays eager, feature
catalogs ride the page that needs them.**

The insight that unlocked it (from the parallel session): the fallback argument
only holds for copy the **shell** renders before any route resolves. A feature's
catalog is not needed until that feature's page is on screen — and those pages
are *already* `lazy(() => import(...))`. The copy can travel with the code.

So this is **not** "all 92 namespaces go lazy". It is ~90 lazy, 2 named
exceptions, and the whole `src/<area>/i18n/` set untouched.

### What stays eager, and why it was measured rather than guessed

Two facts were established across the whole tree **before** anything moved:

1. **No feature component uses another feature's namespace** — 0 occurrences.
   A lazy catalog can therefore only ever be needed by its own page.
2. **Exactly two feature namespaces are rendered by non-feature code**:
   `comments` (`src/chat/MessageComments.tsx`) and `cad`
   (`src/chat/artifacts/BomPreview.tsx`) — both inside the chat feed, which is
   shell, not a route.

`notifications` was on that list until the build failed on the import: the bell
is shell-rendered, but its catalog lives at `src/notifications/i18n/` — an
**area**, already eager. Recorded because it is the kind of thing that reads as
obvious afterwards and was not obvious before.

### Mechanism

- `resources.ts` keeps the area + core globs eager, imports the two shell
  feature catalogs **statically**, and registers the rest as a **non-eager**
  `import.meta.glob`.
- A small i18next **backend** resolves a lazy namespace on demand, so
  `react-i18next`'s default `useSuspense` waits inside the route `<Suspense>`
  that already exists. A backend was chosen over wiring the load into each route
  because it covers every consumer of a namespace wherever it renders —
  including future cross-feature use, which today measures zero but is not
  structurally prevented.
- `vite.config.ts` stops forcing lazy catalogs into the `i18n` chunk, so Rollup
  places each beside the page that imports it.
- A **failed catalog chunk resolves empty**, so i18next falls back to the key's
  `defaultValue` rather than retrying forever. Copy degrades; the page does not
  break.

### An implementation trap worth recording

The first attempt filtered an `{ eager: true }` glob's result object. **The chunk
did not move.** An eager glob imports every match at build time; filtering the
object afterwards changes nothing about what is bundled. Only literal static
imports for the exceptions plus a genuinely non-eager glob for the rest actually
splits it. The measurement is what caught this — not review.

## Consequences

**Measured with the budget script's own method** (gzip of the built file):

| | before | after |
|---|---|---|
| eager `i18n` chunk | **233.0 kB** | **124.3 kB** (−47%) |
| per-namespace `en` chunks | 0 | 90 |
| global per-chunk ceiling | 236 kB | **150 kB** |

The ceiling **ratchets down** for the first time in this programme, with ~25 kB
of headroom so the next feature pass need not touch it. Feature copy no longer
lands in the eager chunk at all, which removes the growth path that caused the
three raises.

**Costs, stated:**

- One extra request per feature page (its catalog), alongside the page chunk it
  already fetches.
- The three lazy LOCALE chunks (~214–221 kB each) are now the largest assets.
  They are one-chunk-per-locale **by design** (ADR 0329), and are named in
  `PER_CHUNK_GZIP_BUDGET` rather than holding the global ceiling up. Applying
  this same namespace split to them is the obvious follow-up and is recorded as
  a decision, not an oversight.
- **The test suite preloads all lazy namespaces** (`src/test/i18n-setup.ts`).
  Without it, 112 assertions across 38 files failed — `render()` returns
  synchronously, the component suspends, and the assertion sees the fallback.
  Making every test author await a namespace would push a bundling concern into
  the suite forever; tests do not measure bundle size. The split is verified by
  the guard test and the budget, not by making 2,587 tests live with it.

**Guarded, not assumed:** `src/i18n/__tests__/namespaceSplit.test.ts` pins both
measured facts and pins the two hand-maintained shell lists (`resources.ts` and
`vite.config.ts`) to each other. Probed by sabotage: removing `cad` from the
eager set → 2 red; drifting the vite list → 1 red.

**Also fixed:** `vite build` and the budget checker disagree by ~5 kB on the same
file (vite printed 238.3 where the checker measured 233.0). Acting on vite's
number is how at least one raise happened; the budget comment now says which
number to read.

## Alternatives considered

- **Raise to 240 again.** Arithmetically certain to recur within one section, and
  the previous note had already ruled it out.
- **Make all `en` namespaces lazy.** Real flash-of-raw-keys risk on first paint,
  because `en` is the fallback locale. The audience split gets the same win with
  the risk confined to surfaces that are already lazy.
- **Load each namespace in its route definition.** Would miss any consumer that
  is not a route, and would need ~90 call sites instead of one backend.
