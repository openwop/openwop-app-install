# ADR 0630 — The adopter/steward reachability invariant, enforced where "reachable" is decided

Status: Accepted — P0 + P1 implemented (2026-09-04); P1b/P1c/P1d, P2, P3 open

Closes the decision half of issue #3627 (the `build` / `build:steward` split
proposal). Corrects ADR 0366 (a correction note is filed there). Grew out of
the KickTodo distribution build (ADR 0414, PRD §9).

## Context

#3610 fixed four build-chain gates that asserted steward-only conditions and
made `npm run build` unpassable in every shipped white-label bundle. #3627
proposed splitting the chain into `build` (adopter) and `build:steward`
(governance) so the next such gate has an obvious home. Taking a real
distribution through a real build then surfaced four more leaks, and none of
them is a build-chain gate:

| # | where the leak is | what a script split does to it |
|---|---|---|
| 1 | `App.tsx` lazy-imports feature pages DIRECTLY, bypassing the registry the distribution filter operates on | nothing — same module graph either way |
| 1b | `site` (and `settings-shell`) have NO registry id, so no manifest can name them | nothing — there is nothing to exclude them BY |
| 2 | `brand/defaults.ts` bakes `https://openwop.dev/` in as the shipped default | nothing — a default is a value |
| 3 | `check-branding.sh` greps the bundle for `Demo host` and matches prose | nothing — the gate is wrong about a correct build |
| 4 | `manual-tests` (a steward QA surface) sits in `bundles.json` `core`, "the substrate a distribution can never exclude" | nothing — the leak is in the tier model |

MEASURED on `82b803cc5` (`OPENWOP_DISTRIBUTION=kicktodo npm run build`, then
grep over `dist/`): the manifest of that day excluded `commerce`, `crm`, `docs`,
`forms`, `funnels`, `job-search`; all six shipped, three of them in the ENTRY
chunk; `openwop.dev` appeared in 11 chunks including four i18n bundles.
`gen-distribution --check` was green throughout — it validates the manifest,
and the manifest was fine.

MEASURED again on `2c6604f12` while building the gate (numbers the gate now
reports rather than anyone remembers): 42 out-of-registry `features/*` imports
across 14 files and 23 (file × feature) pairs; 29 further imports of CORE
features (permitted, see below); 75 feature→feature edges INSIDE
`src/features/` with no frontend closure check; `docs`, `podcasts`, `twin` have
frontend code and no `FrontendFeature` entry, so `no-sales` (which excludes
`docs`) drops its backend and ships `DocsPublicPage`. The `kicktodo` manifest
has since grown the commerce/crm/content/marketing bundles, so today it is
defeated by `forms`, `job-search`, `cad`, `app-builder` — a different four.
The gate prints the current set; this paragraph is a snapshot.

Instance 3 was worse than reported. `BRAND_DEFAULTS.instanceName` has been
`OpenWOP` since `a244b0253` (#260) purged demo branding; `Demo host` cannot
occur in an un-overridden build, so the check had been INERT on the thing it
existed to catch and could only ever match prose. And the stock default
compiles into every bundle whether or not `VITE_BRAND_INSTANCE_NAME` is set
(measured: `instanceName:"OpenWOP"` beside
`instanceName:Ze(Ne.VITE_BRAND_INSTANCE_NAME,…)` in the entry chunk), so no grep
over `dist/assets` can distinguish set from unset. The same is true of instance
2's `homeUrl`.

## Decision

**Adopt the invariant #3627 proposed; reject its instrument.**

> **INVARIANT.** Nothing a distribution excludes, and nothing steward-only, is
> reachable from an adopter's build.

"Reachable" is decided in three places that no single test can see, so the
invariant is enforced as three gates that each state it verbatim in their
failure message — the third must read as the same rule, not a third convention:

1. **Module graph** (static, before any build exists) — a `features/<id>`
   module may be imported only through the feature registry, because the
   ADR 0366 filter operates on the registry's static imports and nothing else.
   `scripts/check-feature-import-boundary.mjs`, in `npm run ci` beside
   `gen-distribution --check`. This is the layer that makes "instance #8" fail
   in steward CI rather than in an adopter's terminal.
2. **Bundle content** (post-build, over `dist/`) — for a manifest with an
   exclude set, no excluded feature's identifiable symbols appear in any chunk.
   Observable only in a built artifact, so it cannot be a unit test. Open.
3. **Tier model** (`gen-distribution --check`) — no steward-only feature in
   `core`. Needs a steward-only mark on the registry entry, which also gives
   layer 2 its symbol list. Open.

Instance 3 is NOT governed by the invariant and is fixed on its own merits
(P0 below): a gate that cries wolf gets skimmed, and in the run that found
these it was also carrying six genuine native-shell leaks.

### Layer 1 — the four verdicts

The gate scans every `.ts`/`.tsx` importer OUTSIDE `src/features/` (tests
excluded) for relative specifiers resolving into `src/features/<dir>/…`, maps
`<dir>` to its id through the frontend registry (`product-discovery` →
`discovery`) or, failing that, the backend registry (dir name = id), and
classifies:

| verdict | condition | why it is (or is not) a violation | fix |
|---|---|---|---|
| core | id ∈ `bundles.json` `core[]` | core is never excludable; the import defeats no manifest. Counted, not flagged | none |
| `excludable` | in the FE registry, not core | the import ships the feature regardless of the manifest. Message names the committed distributions that exclude it, or "any include-mode manifest that omits it" | route the public page/matcher through the registry (a `publicRoutes` seam) |
| `frontend-unregistered` | backend id, no `FrontendFeature` entry | the FE filter has nothing to remove; the UI ships while the backend is dropped | add the `FrontendFeature` entry |
| `unregistered` | in neither registry | outside the mechanism — nothing to exclude it BY | give it an id (separate PR) |

Imports of `features/registry.js` and `features/types.js` are the registry API
and are out of scope by construction.

### The allowlist is the backlog, not a bypass

`scripts/feature-import-boundary.allowlist.json` — one entry per (file,
feature) with `owner` (the ADR 0001 feature package; the repo has no
CODEOWNERS, so the package IS the owner), `why`, `since`, `tracking`. The gate
landed with every existing violation entered there rather than rewriting them
in the same PR: an empty gate that passes because everything was fixed at 2am
is not reviewable, and the allowlist is the reviewable artefact. It is
**shrink-only and exact**: an entry that matches no import FAILS the gate
(stale entries are how allowlists rot into fiction), and a new import not in
it fails the gate.

### P0 — instance 3, the instance-name check

The brand Vite plugin (which already emits `manifest.webmanifest` from the
resolved brand) now also emits `dist/brand-info.json`: the resolved
`productName` / `instanceName` / `primaryDomain` / `homeUrl` / `documentTitle`
/ `faviconSrc` and an `isDefault` map computed against `BRAND_DEFAULTS` in
TypeScript, never hard-coded in bash. `check-branding.sh` §5 asserts
`isDefault.instanceName === false`. Deterministic, minifier-proof, and it
cannot rot when a default changes because the default is read from the same
resolver that renders the sidebar (`WorkspaceSwitcher` → `brand.instanceName`).
A dist without the file is a hard error (exit 2), not a pass: a check that is
green on the wrong artifact is the failure mode the script exists to prevent.
Every value stamped is already in the bundle in plain text.

## Alternatives weighed

- **`build` / `build:steward` split (#3627 as filed).** Rejected as the
  instrument — see the table in Context: none of the five instances is a
  script-chain problem, and a split would have shipped with all of them intact.
  A home for future governance gates is still worth having; it is not this ADR.
- **Rewrite the 42 imports in the landing PR.** Rejected — the acceptance
  criterion on the bus was explicit and right: land RED with the backlog
  documented, so the review is of the gate and the backlog, not of a 30-file
  refactor that happens to make a new gate green.
- **An ESLint `no-restricted-imports` rule.** It can say "unregistered import";
  it cannot say "and `kicktodo` excludes it", because that needs the manifests
  and `generate()`. The actionable message is the point.
- **Grep the bundle for the resolved instance name (instance 3).** Measured
  impossible: the default literal is in every bundle. Asserting on the
  minified `coalesce(env.X, default)` shape would work today and go silently
  inert on the next minifier change — the exact class the old check was in.
- **Fold the frontend cross-feature edges into layer 1 now.** 75 edges,
  ADR 0194's concern (`dependsOn` closure exists for the backend only). Folding
  them in would triple the allowlist without a closure model to grade them
  against. Recorded as P1b, not silently claimed or silently excluded.

## Trade-offs

- The gate is repo-root (`scripts/`), not in the frontend `build` chain, because
  it reads `distributions/` and `gen-distribution.mjs`. Adopters still ship
  those files (the frontend `prebuild` runs the generator), but the gate is
  steward governance and belongs in `npm run ci` — which is also what #3627
  asked for.
- Core imports are permitted. If a feature later moves OUT of core, its
  out-of-registry imports become violations at that moment, which is correct:
  the move is what makes them defeat something.
- `brand-info.json` is a new public static file. It discloses nothing the
  bundle does not already carry.

## Phases

| Phase | Scope | Status |
|---|---|---|
| P0 | instance 3: `brand-info.json` emission + `check-branding.sh` §5 on the resolved value; `check-branding-instance-name.test.ts` pins the false positive gone, the inertness gone, and missing-file = error | implemented 2026-09-04 (this ADR's PR) |
| P1 | layer 1 gate + allowlist + `ci.sh` wiring; `check-feature-import-boundary.test.ts` pins each verdict, the exact-allowlist contract, and the SABOTAGE (real tree, empty allowlist, real entry point → red naming a real import and a real distribution) | implemented 2026-09-04 (this ADR's PR) |
| P1b | frontend feature→feature closure (75 edges) — the ADR 0194 `dependsOn` model applied to `src/features/**` | open |
| P1c | `site` and `settings-shell` get registry ids | open — separate PR, the gate flags them |
| P1d | `docs`, `podcasts`, `twin` get `FrontendFeature` entries | open |
| P1e | the 42-import backlog burned down (a `publicRoutes` seam for App.tsx's anonymous pages; artifact-renderer seams for chat's cad/app-builder imports) | open — the allowlist IS the tracker |
| P2 | bundle-content gate over `dist/` | open |
| P3 | tier-model gate: steward-only mark + no steward-only feature in `core` (`manual-tests`, `tutorials` first) | open |
| — | instance 2 (`homeUrl` default): decide whether the shipped default is neutral / adopter-required (fail loudly) rather than the steward's domain | open, not sequenced here |

## Open questions

- Whether `publicRoutes` on a `FrontendFeature` can serve anonymous visitors
  without the entitlement guard, or whether the registry needs a second,
  unguarded mount list. Decides P1e's shape.
- What "identifiable symbols" means for P2 without a per-feature manifest of
  exported names — the steward-only mark from P3 may be the cheapest source.
- Whether the shell-catalog i18n imports in `i18n/resources.ts` (comments,
  cad, campaign-studio) should follow the feature into exclusion or are
  legitimately shell-owned strings.

## Falsifiability

If the gate is ever green on a tree where a committed manifest excludes a
feature whose page is reachable from `App.tsx`, layer 1 is wrong. The sabotage
test exists so that claim is checked on every run, not asserted once.
