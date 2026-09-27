# ADR 0366 — White-label distribution manifests: build-time feature composition over the ADR 0001 seam

Status: Implemented (2026-07-14; Phase 4 2026-07-18) — Phases 1–4 landed. The
Phase-0 trigger fired 2026-07-14: the product owner declared white-label
distribution the business model and directed the build (the owner-declarable
trigger this ADR was amended to record). Phase 4 (full-catalog classification +
the shop's three tiers) landed on a further owner directive — "support all
features/feature groupings" — see the Phases table + the §Correction on the
excludable-universe flip.

## Context

Feature toggles govern *behavior*, not *presence*: every first-party feature
is compiled into both artifacts regardless of toggle state. That is the right
trade for the hosted product — per-tenant flips, canaries, A/B variants, no
redeploys — and the user-paid cost is already flat (entry chunk budget-gated
≤188 kB gzip; feature pages are lazy chunks fetched only on navigation; 318
chunks in a ~44 MB dist of which a session pulls a sliver).

What toggles CANNOT answer is the white-label artifact question: a customer
who did not license CRM still receives CRM code in their image and dist.
The drivers there are **licensing/contractual** and **attack/audit surface**,
not performance. Three composition lanes exist or are proposed:

1. **Core substrate** (auth, orgs, chat, workflow engine, design system) —
   always compiled, never composable.
2. **First-party feature bundles** — THIS ADR: compiled, but included or
   excluded per DISTRIBUTION at build time.
3. **Runtime packs** (nodes/agents/artifact types/connections, ADR 0300
   sandboxed UI plugins) — already installable/removable with zero rebuild;
   the existing marketplace's honest scope.

**Rejected up front (quality floor):** moving first-party surfaces into the
runtime-pack lane. Pack UI loads in a sandboxed iframe (opaque origin,
`allow-scripts` only — ADR 0300) and dynamically loaded code escapes every
compile-time gate that defines this app's quality (tsc across the seam, the
token/i18n/bundle gates, the vitest suites, the pinned CSP script hashes).
Module-federation-style dynamic first-party bundles were likewise rejected:
version skew between core and bundle chunks, no cross-boundary type checking,
and a direct conflict with `check-csp-script-hash`.

## Decision

A **distribution manifest** composes a build from named feature sets, filtered
at the ONE existing seam — the flat registries (`BACKEND_FEATURES`,
`backend/typescript/src/features/index.ts:154`; `FRONTEND_FEATURES`,
`frontend/react/src/features/registry.ts:94`):

1. **Manifest** (`distributions/<name>.json`): `{ name, bundles: [...],
   features: [...] }` — bundles resolve through the ADR 0194 `dependsOn`
   graph to a feature-id closure. The DEFAULT distribution includes
   everything (today's build, byte-identical — the no-manifest path never
   changes).
2. **Registry filter at build time**: a generated include-list module (from
   the manifest, at build start) that the registry files import — so
   vite/esbuild TREE-SHAKE excluded feature packages out of both artifacts.
   Excluded feature = absent routes, absent chunks, absent toggle default
   (the toggles admin never shows it), absent nav.
3. **Closure validation gates the build**: a manifest whose included set
   violates the `dependsOn` closure (includes a feature whose hard
   dependency is excluded) FAILS CI — never ships incoherent.
4. **Capability honesty per distribution**: `/.well-known/openwop`
   advertisements derive from the INCLUDED set; a slim build must not
   advertise what it excluded (`OPENWOP_REQUIRE_BEHAVIOR=true` stays green
   on every distribution). This is the one wire-adjacent constraint — it is
   an honesty requirement on an existing surface, NOT a wire change.
5. **Quality by construction**: every distribution build runs the identical
   full gate suite (`npm run ci`: tsc, token/CSS/i18n gates, bundle budget,
   both vitest suites) plus a per-distribution boot-smoke. A slim build is
   exactly as verified as the full one.
6. **Toggles compose, not compete**: within any distribution, runtime
   toggles work unchanged (flips, canaries, tenantOverrides, the ADR-0194
   locks, the provenance/drift chips). Exclusion removes presence;
   toggles govern behavior of what is present.
7. **Marketplace as manifest editor (final phase)**: "shopping" a bundle
   (e.g. CRM) EXTENDS the existing `marketplace` feature — adding a bundle
   to the customer's manifest and triggering the automated
   build+gate+deploy pipeline. Install latency is a CI run (minutes), and
   the UI must say so honestly. No new feature package; no new toggle.

## Evaluation-matrix notes (the N/A rows are deliberate)

- **Feature-package/toggle**: none — this is build infrastructure above the
  toggle system; the P3 UI extends `marketplace` (toggle id stable).
- **Node/agent packs, ctx.<feature>, envelopes, public surface**: N/A (no
  runtime capability is added).
- **RBAC**: P3 manifest editing is operator/superadmin-only (it triggers
  deploys); the pipeline credential never lives in the app.
- **Replay/fork**: unaffected — run artifacts don't reference distribution
  identity; a run created on a distribution replays there.
- **RFC verdict: none needed.** Host build composition under the existing
  non-normative surfaces; the `/.well-known` constraint is per-deployment
  honesty on an existing contract.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 0 | Trigger — a contract/compliance requirement for artifact-level exclusion, **or the product owner declaring white-label distribution the business model** (the trigger is a business fact the owner holds; engineering must not infer it either way) | owner's call |
| 1 | **CORE LANDED (2026-07-14)**: manifest schema (`distributions/*.json`, Phase-1 exclude semantics) + `scripts/gen-distribution.mjs` (generated `*.distribution.ts` registries, gitignored) + the two loud gates — dependsOn-closure validation (caught a REAL violation on first run: `discovery`→`commerce`) and unresolvable-id validation — with `--check` CI mode + 4 generator tests. Trigger: the owner directed the build (2026-07-14 /goal) | landed |
| 1b | **LANDED (2026-07-14)**: BOTH substitutions are load-hook based, keyed on the RESOLVED path (correction: specifier-based aliasing engaged on only 2 of 5 backend importers and vite `resolve.alias` never engaged at all — both artifacts silently kept the full registry; the sourcemap, not the minified JS, exposed the frontend leak). esbuild `onLoad` plugin in `backend/typescript/scripts/build.mjs` (replaces the package.json one-liner verbatim; default byte-path unchanged); vite `load()` plugin in `vite.config.ts`. Proof: slim backend bundle drops excluded features (boot green under `OPENWOP_REQUIRE_BEHAVIOR=true`); slim frontend entry chunk measurably shrank (187.2→185.6 kB gzip) with zero excluded-feature traces incl. sourcemaps. `npm run ci:distribution` = manifest check + both slim builds | landed |
| 2 | **LANDED (2026-07-14)**: `distributions/bundles.json` (bundle catalog — bootstrap: `sales` + `commerce` proven clusters; everything unbundled = core, refined iteratively) + INCLUDE-mode manifests (`bundles[]`/`features[]` — the licensing-safe direction: a feature added to a bundle later does NOT silently ship to existing include-mode distributions) + catalog-drift gate in `--check` (a bundle naming an unregistered feature fails) + the `no-sales` include-mode proof + tests. Architect ruling: classification-completeness is enforced by construction (core = unbundled); the drift gate covers the other direction | landed |
| 3 | **LANDED (2026-07-14)** — the bundle shop rides the EXISTING marketplace feature (no parallel listing system): read-only `GET …/marketplace/feature-bundles` (the `/listings` gate posture) projects `distributions/bundles.json` enriched with compiled toggle labels + a `registered` honesty flag; `/marketplace/bundles` composes an include-mode manifest client-side and EXPORTS it (download/copy). **Pipeline security ruling:** there is deliberately NO write twin — a manifest becomes a build only via a repo PR + the gated `gen-distribution` pipeline (`npm run build:distribution`, OPENWOP_DISTRIBUTION-driven). **Deploy fix folded in:** ADR 0366 P1b had silently broken the Docker image build (the builder never COPYed `backend/typescript/scripts/`, and `build.mjs` hard-invoked the repo-root generator absent from the builder context) — builder now COPYs the scripts dir and `build.mjs` skips the generator for the default distribution when the repo root is absent, still failing loud for a named one. | landed; route pins (`marketplace-feature-bundles.test.ts`) + FE shop tests |
| 4 | **LANDED (2026-07-18)** — full-catalog classification + the shop's three tiers (owner directive: "support all features/feature groupings"). `distributions/bundles.json` gains an explicit **`core[]`** (the always-included substrate) and one **bundle per sellable toggle `category`** (12 bundles); every registered feature is now CLASSIFIED — 59 core, 50 bundled, 6 **standalone** (derived = `registered − core − bundled`, not enumerated, so a new feature is auto-selectable). The shop projects all three tiers (`bundles` + `standalone` + read-only `core`); a standalone feature is individually selectable via the manifest's `features[]`, and the composer **closes the `dependsOn` graph** over the selection so an export never fails the build's closure gate. Four new `--check` invariants (every core/bundle id registered; no id in two tiers; **`core` is dependsOn-closed** — so every offered exclusion is buildable; an **always-on feature MUST be core**). See the §Correction below on the excludable-universe flip. | landed; `gen-distribution.test.ts` (P4 invariants) + `marketplace-feature-bundles.test.ts` (three tiers) + FE shop tests |

## Correction (2026-07-18, Phase 4) — the excludable-universe flip

Phase 2 recorded that "classification-completeness is enforced by construction
(core = unbundled)": the include-mode excludable universe was `union(all bundle
features)`, so every UNbundled feature silently stayed IN. That made standalone
(non-bundled) features **un-excludable** — the opposite of what the owner's
"select any individual feature for the package" directive needs.

Phase 4 flips the seam: the excludable universe is **`registeredFeatureIds() −
core`**, so EVERY non-core feature is composable (bundled or standalone) and
defaults OUT of an include-mode build (opted IN via `bundles[]`/`features[]`).
Consequences, folded in: `core` is now an EXPLICIT list (the licensing boundary,
PR-reviewable data) that must be `dependsOn`-closed; the `no-sales` proof manifest
+ its test were rewritten (it no longer keeps unbundled features by default);
and the always-on invariant is enforced statically (a feature package with no
`toggleDefault:` property — matched as the PROPERTY, not the bare word, so a
comment or an imperative `registerToggleDefault()` call like `cms`'s does not
count — MUST be core, or a slim build would drop boot-critical substrate). The
runtime catalog projection sources the feature-id universe from
`listRegisteredFeatureIds()` (the ADR 0194 dependency-graph keys), NOT
`BACKEND_FEATURES`, to avoid an `index → marketplace → routes → bundleCatalog`
import cycle.

## Correction (2026-09-04, ADR 0630) — the seam only governs what goes THROUGH it

Everything above assumes the registry is the only path from the entry module
to a feature package. It is not, and nothing checked. MEASURED on `82b803cc5`
(#3627): `App.tsx` lazy-imports ten feature dirs' public pages directly, so a
manifest that excluded six of them still shipped every one — three in the
ENTRY chunk — while `--check` stayed green (it validates the manifest, and the
manifest was fine). Two further shapes the seam cannot see: a feature with
frontend code but no `FrontendFeature` entry (`docs`, `podcasts`, `twin`) is
dropped on the backend and SHIPPED on the frontend by any manifest that
excludes it, because the filter has nothing to remove; and a dir with no
registry id at all (`site`, `settings-shell`) cannot be excluded by
construction. The exclusion mechanism is correct; its PRECONDITION — that the
module graph reaches features only through the registry — was never stated
and never enforced. ADR 0630 states it as the adopter/steward reachability
invariant and enforces its module-graph layer (`scripts/check-feature-import-
boundary.mjs`, in `npm run ci`, red-with-allowlist on landing). Decision
points 2–3 above stand; read them as conditional on that gate.

## Open questions

- Per-distribution demo/seed content (the demo-* seeders assume the full set).
- Support matrix honesty: N distributions × the e2e suite — which smoke set is
  per-distribution vs default-only.
- Whether backend exclusion needs migration guards (an excluded feature's
  historical rows must not break boot — expected fine: migrations are
  feature-agnostic, but pin it in Phase 1).

## Falsifiability

If no contract ever demands artifact-level exclusion, Phase 1+ stays unbuilt
and nothing is lost — the runtime posture already keeps the user-paid
footprint flat. Conversely, if CDN/image size itself becomes a measured cost
or the admin-surface clutter becomes a sales objection, those are weaker but
real secondary triggers; re-run /architect with the numbers.
