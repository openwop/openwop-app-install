# ADR 1031 — The adopter feature seam: feature packages from paths openwop-app never writes

Status: Accepted (David, steward, 2026-11-02) — P1 implemented by PR #5495; P2 implemented by PR #5502 (addendum below); the P3 prerequisite (adopter pack trust, ADR 1048) by PR #5547; round 3 (host tables) by PR #5549 and PR #5550 (addendum below); P3 implemented by PR #5512 (addendum below)

Requested by the owner (David, 2026-11-02) as phase P1 of the plan that moves
KickTodo's product code out of openwop-app and into the KickTodo repo.
Builds on ADR 0001 (feature-package architecture), ADR 0366 (distribution
manifests), ADR 0414 (`kicktodo-core`), ADR 0630 (adopter/steward reachability)
and ADR 0916 (white-label adoption seams). Host-internal: no wire change.

## Context

KickTodo is a white-label downstream distribution of openwop-app, deployed to
kicktodo.com. Its product code is authored here and reaches KickTodo through the
white-label bundle sync:

- frontend `frontend/react/src/features/kicktodo*` (nine packages);
- backend `backend/typescript/src/features/kicktodo-*` (nine packages);
- two packs, `packs/feature.kicktodo.nodes` and `packs/vendor.openwop-app.kicktodo.agents`;
- `distributions/kicktodo.json`.

ADR 0414 put `kicktodo-core` in this repo when KickTodo was the first proof of the
white-label model and there was no other place to put it. That has a running cost
on both sides. Every KickTodo product change is an openwop-app PR, gated by the
openwop-app CI, and reaches kicktodo.com only after the next bundle sync. Every
openwop-app adopter receives KickTodo's code and tests whether they want them or
not. And openwop-app's shared code has grown KickTodo-specific call sites (the
P2 list below).

The plan the owner approved moves ownership to the KickTodo repo. A downstream
cannot simply edit upstream-owned files: KickTodo's own rule is that every
modified upstream file is a merge conflict on every sync, forever (its overlay
holds that list to four files). So the move needs a place in the tree where an
adopter can ADD feature packages that openwop-app never writes, and that the
registries pick up without an edit to any upstream-owned file. This ADR adds that
place. It is useful beyond KickTodo: any adopter (Book AI is the next) can ship
its own feature packages the same way.

### How this interacts with ADR 0630

ADR 0630's invariant is that nothing a distribution excludes, and nothing
steward-only, is reachable from an adopter's build. Its layer-1 gate
(`check-feature-import-boundary.mjs`) flags imports into `src/features/<id>/`
from outside the feature tree. Two consequences, both recorded here:

1. **Adopter features are not excludable.** They are not static imports of either
   canonical registry, so the ADR 0366 filter cannot remove them and a manifest
   cannot name them (`gen-distribution` now says so explicitly instead of the
   generic "resolves in NEITHER registry"). They ship in every build of the repo
   that wrote them, which is what the adopter wrote them for. The 0630 invariant
   holds: there is no exclusion for them to defeat.
2. **Adopter feature code is feature code, not shell.** An import from
   `src/adopter/features/<id>/` into a first-party feature is the same
   feature-to-feature edge as one inside `src/features/` — layer 1b, which ADR
   0630 records as open. The layer-1 scan now skips `src/adopter/features/` the
   same way it skips `src/features/`. The backend `dependsOn` closure, which
   does exist, now includes adopter features (below).

## Decision

### D1 — Where adopter code lives

| What | Path | Owner |
|---|---|---|
| Frontend feature package | `frontend/react/src/adopter/features/<id>/routes.tsx` exporting `<camelId>Feature: FrontendFeature` | adopter |
| Its i18n catalogs | `frontend/react/src/adopter/features/<id>/i18n/<locale>.ts` (namespace `<id>`) | adopter |
| Backend feature package | `backend/typescript/src/adopter/features/<id>/feature.ts` exporting `<camelId>Feature: BackendFeature` | adopter |
| Adopter pack pins | `backend/typescript/src/adopter/packPins.ts` exporting `ADOPTER_PACK_PINS` (optional) | adopter |
| Tests | `backend/typescript/test/adopter/**`, `frontend/react/src/adopter/**/__tests__/` | adopter |
| Packs | `packs/<name>/` with a name upstream never uses | adopter |

Backend code is inside `backend/typescript/` because the Cloud Run image is built
from that subtree only. The directory name IS the feature id, kebab-case, and
both halves enforce it. Nothing is committed under any `src/adopter/` path in
openwop-app: `scripts/build-whitelabel-zip.sh` fails the bundle build if one is
tracked (the guard, since there is nothing to strip).

### D2 — Frontend registration: an eager glob

`features/adopterFeatures.ts` globs `/src/adopter/features/*/routes.tsx` with
`{ eager: true }` and `registry.ts` composes `FRONTEND_FEATURES =
composeFrontendFeatures([…first-party…], ADOPTER_FRONTEND_FEATURES)`. Eager
because `routes.tsx` is route and nav metadata (pages stay `lazy`), exactly like
the first-party static imports. An empty glob yields `{}`.

It survives a named-distribution build: the ADR 0366 filter rewrites
`registry.ts` text by the `import { <camel>Feature }` convention, and the adopter
import does not match it, so the generated `registry.distribution.ts` keeps it.
Measured with a throwaway fixture: the adopter route is in the entry chunk of both
the default build and `OPENWOP_DISTRIBUTION=kicktodo`, whose bundle drops the
excluded `sales-commissions` as before.

**i18n.** `i18n/resources.ts` also globs `/src/adopter/features/*/i18n/{en,pt-BR,fr,es}.ts`.
Adopter namespaces are lazy feature namespaces (they join `LAZY_EN_NAMESPACES`
and the per-locale feature partition). A collision with an existing namespace
throws at load. `vite.config.ts` `manualChunks` treats the adopter paths as
feature catalogs (own async chunk, not the eager `i18n` chunk), and
`check-i18n` discovers them for key resolution and locale parity. Measured: the
fixture's `en` and `fr` catalogs each landed in their own lazy chunk.

### D3 — Backend registration: a generator

Node has no glob import and esbuild bundles static imports only.
`backend/typescript/scripts/gen-adopter-features.mjs` scans
`src/adopter/features/*/feature.ts` and writes two GITIGNORED modules:

- `src/features/adopterFeatures.generated.ts` — `ADOPTER_BACKEND_FEATURES` and the
  index-aligned `ADOPTER_FEATURE_DIRS`;
- `src/features/adopterPackPins.generated.ts` — `ADOPTER_PACK_PINS`, re-declared at
  `Readonly<Record<string, string>>` so the adopter's literal is type-checked.

`features/index.ts` composes `BACKEND_FEATURES = composeBackendFeatures([…],
ADOPTER_BACKEND_FEATURES, ADOPTER_FEATURE_DIRS)`; the generated
`index.distribution.ts` keeps the call for the same reason as D2.

It runs from every entry point that compiles or loads the registry:
`scripts/build.mjs` (so `npm run build` and the Docker image build, which copies
`backend/typescript/scripts`), `predev`, `pretest`, `pretypecheck`, `prelint`,
`pretest:conformance`, and `vitest.config.ts` at config load. It writes only
when the content changed, through a temp file and a rename. It fails loud on a
non-kebab directory, a directory without `feature.ts`, a `feature.ts` without the
`<camelId>Feature` export, and a `packPins.ts` without `ADOPTER_PACK_PINS`.

**Deviation from the brief: two generated files, not one.** `features/packPins.ts`
imports the pins module, and ADR 0919 keeps pin resolution off the feature graph
(a pin bump must not re-run every `createApp` test under Tracegate). One module
holding both would have pulled every adopter feature into pin resolution.

### D4 — Duplicate ids fail fast, at boot

`composeBackendFeatures` throws at module load (every entry point imports the
registry) on: a duplicate id anywhere in the composed list, naming both sides; an
adopter feature whose `id` is not its directory; and a generated module out of
step with its directory list. `composeFrontendFeatures` throws on an adopter id
already taken. `pinnedPackRef` throws `pack_pin_conflict` when an adopter pins a
pack `features/packPins.ts` already pins. A contributed dashboard tile or demo
seeder reusing an id throws too (D5).

### D5 — Runtime hooks, so a feature plugs into shared surfaces unnamed

| Surface | Hook | Before |
|---|---|---|
| Background daemons | `BackendFeature.onStart(ctx) → { stop() } \| null`, run by `startFeatureDaemons` from `main()` after the host's daemons; handles stopped on SIGTERM. `ctx` = `{ storage, hostSuite, listRosterTenants }` | `src/index.ts` imported `startVerifierSampleDaemon` from `kicktodo-metrics` by name. **Converted** (behaviour-identical: same env flag, same arguments, same start order, `createApp` still starts nothing) |
| Demo / example data | `BackendFeature.demo = { seeders?, enableToggles?, unseededReason? }`, recorded at `registerBackendFeatures` into `host/featureDemoContributions.ts`; joins `EXAMPLE_DATA_SEEDERS` (after the host's), `DEMO_FEATURE_TOGGLE_IDS` and the seed-coverage gate's acknowledgements | hand-kept host arrays only |
| Dashboard tiles | `FrontendFeature.dashboardTiles`, composed after the host tiles in `allTiles.ts`; `DashboardTileDef.i18nNamespace` lets a feature tile translate in its own catalog, which `DashboardPage` loads | tiles hard-coded in `allTiles.ts` |
| Review cards | `FrontendFeature.reviewArtifactRenderers`, which the ADR 0459 review-renderer registry (`chat/reviews/reviewArtifactRenderers.tsx`) registers on its FIRST lookup via `featureReviewArtifactRenderers()`. On first lookup, not at registry load: that module is in a lazy chunk, and registering from `registry.ts` would have pulled it into the entry chunk | renderers registered by name in `reviewArtifactRenderers.tsx` |
| Chat cards / commands | none needed: `chat/registry/CardRegistry.ts` and `CommandRegistry.ts` are already tiny module-scope registries a feature can call from its `routes.tsx` | — |
| Chain-backed workflows | none needed: a feature can call `registerChainBackedWorkflow` from its own `registerRoutes`, which runs before `validateChainBackedSubChainBinds` | `features/index.ts` names the kicktodo source arrays |

### D6 — Distribution tooling and ratchets

- `gen-distribution.mjs`: the `dependsOn` closure includes adopter features (an
  adopter feature that hard-depends on an excluded feature is a violation; the
  backend scanner is reused from the backend package). An exclude list naming an
  adopter id gets its own error.
- `check-distribution-composition.mjs` counts adopter ids as registered.
- Runtime-denominator ratchets already cover adopter features, because they read
  the live registry: `required-packs-pin-parity` (BACKEND_FEATURES, now resolving
  adopter pins; measured red for a fixture pin with no pack, green with the pack),
  `agent-tool-reach-ratchet` and `schema-read-exemption-completeness` (live tool
  registry after `createApp`), `seed-coverage` (BACKEND_FEATURES).
- Source-walking ratchets need an explicit root. `test/helpers/featureSourceRoots.ts`
  returns `src/features` plus `src/adopter/features` when present;
  `teardown-reachability-coverage` uses it. The rest are P2 (below).
- `vitest` and `tsc` include globs already cover `src/**` and `test/**`.

### Invariants

1. **Feature ids and pack ids are never renamed** by the move. `kicktodo-core` is
   `kicktodo-core` in `src/features/` today and in `src/adopter/features/` after
   P3; toggles, stored overrides, routes, `feature.kicktodo.*` typeIds and pack
   pins all key on them.
2. **Duplicate ids fail fast** (D4), never last-writer-wins.
3. **Zero behaviour change upstream.** openwop-app has no adopter directories, so
   every adopter list is empty and every composition returns the first-party list
   unchanged. The one moved call site (the verifier daemon) is behaviour-identical.
4. **Wire: none.** Everything here is host-internal composition.

## The three phases

| Phase | Scope | Where |
|---|---|---|
| **P1** | This seam: registries, generator, hooks, tooling, ratchet roots, bundle guard | openwop-app (this PR) |
| **P2** | Make the `kicktodo*` packages self-contained: convert every KickTodo-specific site in shared code (list below) to a hook — or add the missing hook — until no shared file names KickTodo. Packages stay in `src/features/` | openwop-app |
| **P3** | In ONE bundle sync: delete the `kicktodo*` packages, packs and `distributions/kicktodo.json` upstream, and add them in KickTodo under the D1 paths, ids unchanged | both repos, same sync |

**P3 prerequisite: ADR 1048** (adopter pack attestation + the runtime side-effect
floor). Without it KickTodo's packs are refused at boot once P3 removes their
steward entries; with it KickTodo commits a generated `packs/.adopter-manifest.json`
in the same sync merge.

**Change freeze.** From the end of P2 until P3 lands, no change to any `kicktodo*`
package merges upstream. A change in that window would be deleted by P3 without
reaching the downstream copy.

### P2 call-site list (measured at `f2eefb56e`)

Backend:
- `features/featureRoute.ts` — `requireKicktodoManage` / `hasKicktodoEnrollmentAuthority`, `KICKTODO_MANAGE_SCOPE`, imports `kicktodo-core/enrollmentService`.
- `features/index.ts` — the nine imports, and `registerLegacyDefsChainBacked(kicktodo{,Creator,Integrations,Accountability}BuiltinWorkflows)` (move into each feature's `registerRoutes`, D5).
- `features/kicktodoFactoryAi.ts` — a KickTodo module at the `features/` root.
- `host/appMigrations.ts:773` — `CRM_DEPENDENT_TOGGLES` names `kicktodo-commerce`.
- `host/seedCoverage.ts` — nine `kicktodo-*` acknowledgements (→ `demo.unseededReason`).
- `host/demoKicktodoSeed.ts`, `host/seed-data/kicktodoDemo.ts`, and the `demo-kicktodo` entry in `host/exampleDataSeeders.ts` (→ `demo.seeders`).
- `host/approvalService.ts`, `approvalAudience.ts`, `approvalDecision.ts` — the `kicktodo-plan-proposal` approval kind (needs an approval-kind registration hook).
- `host/operatorActivationLedger.ts` — `kicktodo-operator`.
- `executor/sideEffects.ts:114` — the `feature.kicktodo.nodes.session-reminder` side-effect pattern.
- `features/goals/*`, `host/runStartGrant.ts`, `host/accessControlService.ts` and over 100 other shared files mention KickTodo (141 outside the packages, tests and catalogs excluded); most are comments, some are logic. Re-derive with `git grep -il kicktodo -- backend/typescript/src ':!backend/typescript/src/features/kicktodo-*'`.

Frontend:
- `features/dashboard/allTiles.ts` — the `kicktodo-today` / `kicktodo-progress` tiles and `tiles/KickTodo*Tile.tsx` (→ `dashboardTiles`, with their `dashboard` catalog keys moved to the feature's namespace).
- `chat/reviews/reviewArtifactRenderers.tsx`, `ChallengePlanReview.tsx`, `LessonBatchReview.tsx` and the `chat` catalog keys they use (→ `reviewArtifactRenderers`).
- `client/kicktodo*Client.ts` (eleven clients) → into the feature packages.
- `features/challenge-outline/definition.tsx` — rides the `kicktodo-creator` toggle.
- `features/manual-tests/suites.ts` — KickTodo suites.
- e2e: `admin-governance`, `announcement-delivery`, `route-snapshots`, `serviceWorkerOffline.offline`, `snapshotPaths`.

Tests and gates with hard-coded KickTodo entries an adopter cannot edit:
- `schema-read-exemption-completeness` `CLASSIFICATION`, `agent-tool-reach-ratchet`
  (imports `KICKBOT_TOOL_ALLOWLIST` from `kicktodo-core`), `idempotency-lane-tripwire`
  `MUTEX_ALLOWLIST`, `subject-erasure-feature-stores` and the teardown tables,
  `scripts/check-distribution-composition.mjs` `REQUIRED.kicktodo`.
  P2 needs a feature-declared form of each exception (for example
  `schemaCarrying` declared at `registerFeatureAgentTool`), or an adopter-owned
  extension file each test globs from `test/adopter/`. Until then an adopter
  feature registering a new tool or store reddens an upstream-owned table, which
  is the correct failure but has no adopter-side fix.

## Alternatives considered

- **Keep KickTodo upstream (status quo).** Rejected by the owner: it couples
  KickTodo's release cadence to openwop-app's gate and sync, and ships KickTodo to
  every adopter.
- **Fork-edit downstream (KickTodo edits `registry.ts`, `features/index.ts`, …).**
  Each edited file is a merge conflict on every sync, forever; the registries are
  the hottest upstream files there are. KickTodo's overlay rule exists to stop
  exactly this.
- **Strip KickTodo from the bundle but keep the upstream copy.** Two copies with
  one of them authoritative only by convention. The stripped copy still costs
  upstream CI and review, and every upstream refactor of a shared seam must still
  update code its owner no longer reads.
- **Backend discovery at runtime (`readdir` + dynamic `import()`).** esbuild
  cannot bundle a computed specifier, so the image would lack the code. Rejected
  for the generator.
- **Commit the generated module upstream (empty) and let adopters overwrite it.**
  Every adopter build would dirty an upstream-owned tracked file. Rejected for
  gitignored generation.

## Consequences

- **For other adopters.** Book AI, or any adopter, can ship feature packages under
  the D1 paths with no edit to an upstream file and get registration, i18n,
  dashboard tiles, review renderers, daemons, demo data and pack pins. Its
  features are always composed and cannot be excluded by a manifest.
- **A fresh clone needs the generator before a bare `tsc`.** Every npm script and
  `vitest` runs it; a bare `node node_modules/typescript/bin/tsc` on a never-built
  clone reports `Cannot find module './adopterFeatures.generated.js'`. Run
  `node backend/typescript/scripts/gen-adopter-features.mjs` once.
- **Exception tables stay upstream-owned** until P2 (above).
- **Entry-chunk cost** is zero upstream; for an adopter it is its own `routes.tsx`
  metadata, tile metadata and review components, as for a first-party feature.

## Implementation record

| Phase | Commit / test | Status |
|---|---|---|
| P1 | this PR — `backend/typescript/test/adopter-feature-seam.test.ts` (21), `frontend/react/src/features/__tests__/adopterFeatures.test.ts` (11); throwaway fixture proved route 200 in a real boot, entry-chunk route + lazy i18n chunks in the default and `kicktodo` builds, duplicate-id and id/dir boot errors, closure violation, adopter pin parity | implemented |
| P2 | `feat/kicktodo-self-contained` (stacked on P1 `256dbc874`) — see the P2 addendum; KickTodo test set 145 files / 1346 tests green before and after the test move (1341 at the P1 base); round 2 (security surface, host tables, styles, gate rows, test splits) in the same PR | implemented (draft PR) |
| P3 | #5512 (`feat/kicktodo-p3-remove`, upstream half) + the KickTodo adoption PR, one sync | open: #5512 |

## Addendum — P2 (2026-11-02)

P2 makes the `kicktodo*` packages self-contained inside openwop-app. Feature ids,
pack ids, toggle ids, KV keys, approval kinds, artifact type ids and workflow ids
are unchanged; there is no wire change. Branch `feat/kicktodo-self-contained`,
stacked on P1 (`256dbc874`).

### New seams (answers to the two open questions, and what P2 found missing)

| Seam | Shape | Replaces |
|---|---|---|
| Feature-owned approval kinds | `host/approvalKindRegistry.ts`: `registerFeatureApprovalKind(kind, { audience, decision })`. Types by module augmentation of `approvalService.ts` (`FeatureApprovalKinds`, `PendingApproval` fields). `insertApproval(row, { ifAbsent })` is the generic create. A host kind cannot be re-registered; a kind in neither the host table nor the registry fails CLOSED (superadmin tenant), never tenant-wide | six KickTodo kinds in `APPROVAL_KINDS`, `APPROVAL_AUDIENCE`, `KIND_DISPATCH`, four payload fields, four creators, three handler hooks, five redactor maps |
| Ratchet declarations | `<feature>/ratchetDeclarations.ts` exports `ratchetDeclarations: FeatureRatchetDeclarations` (`features/types.ts`); `test/helpers/featureRatchetDeclarations.ts` collects them from both feature roots; each ratchet runs its unchanged assertions over host table ∪ declared, and a row in both fails. Floors are host floor + declared count | KickTodo rows in `schema-read-exemption-completeness`, `agent-tool-reach-ratchet`, `idempotency-lane-tripwire`, `teardown-reachability-coverage`, `subject-erasure-feature-stores` COS-1 |
| Distribution must-ship | `distributions/<name>.json` `mustShip: { id: why }`, read by `check-distribution-composition.mjs` | `REQUIRED.kicktodo` in the script |
| Chain-backed workflows | `BackendFeature.chainBackedWorkflows`, registered after the host lists, before the bind check | four `registerLegacyDefsChainBacked(kicktodo*)` calls in `features/index.ts` |
| Nav group placement | `FrontendFeature.navGroups: [{ label, after }]`, spliced into `GROUP_ORDER` | `'KickTodo'` in `chrome/features.tsx` |
| Manual-test suites | `<feature>/manualTests.ts` (`manualTestSuites`, `manualTestCategoryOf`), eager glob over both roots | eleven suites in `manual-tests/suites.ts` |
| Migration 23 CRM dependents | derived from the `dependsOn` closure (`crmDependentToggles`) | `CRM_DEPENDENT_TOGGLES` naming `kicktodo-commerce` |

**Correction to D1/D4 (frontend).** P1 required an adopter frontend package's
directory to equal its `FrontendFeature.id` and every id to be unique. On the
frontend that id names the BACKEND feature a package belongs to, and one backend
feature has several packages (`kicktodo` and `kicktodo-admin` are both
`kicktodo-core`; `kicktodo-studio` is `kicktodo-creator`). Six of KickTodo's
nine frontend packages would have thrown at P3. The directory and its
`<camelDir>Feature` export are the package key (as `gen-distribution` already
assumed); `composeFrontendFeatures` refuses only an adopter package attaching to
a first-party feature id.

### What moved (all inside the KickTodo family now)

Backend: the manage/enrollment authority helpers (`kicktodo-core/manageAuthority.ts`),
`kicktodoFactoryAi.ts` (`kicktodo-core/factoryAi.ts` — core, because core's readiness reads it and creator depends on core), the `demo-kicktodo`
seeder and its data (`kicktodo-core/demoSeed*.ts`, via `demo.seeders`), the nine
seed-coverage acknowledgements (`demo.unseededReason`), the six approval kinds
(`kicktodo-core/approvalKinds.ts`). Frontend: the eleven clients
(`features/kicktodo/client/`), the two home tiles (`dashboardTiles`), the three
review renderers (`reviewArtifactRenderers`, lazy behind their own `<Suspense>`,
entry-chunk matchers pinned to the parsers), their catalog keys, the manual-test
suites, and the KickTodo e2e cases (`e2e/kicktodo-*.spec.ts`). Backend tests:
`test/kicktodo/`.

### P2 round 2 — the seams that closed the rest (2026-11-02)

The first round listed eight sites that were not self-contained. Each now has a
declaration the package owns:

| Seam | Shape | Replaces |
|---|---|---|
| Feature security surface | `BackendFeature.security` (`scopes`, `activationRoles`, `publicRoutes`, `logReasonCodes`), recorded and sealed by `features/featureSecurity.ts`; see "Security" below | `host:kicktodo:manage` in `accessControlService.ts`, `KICKTODO_OPERATOR_ROLE`, the two `/public/kicktodo/*` prefixes in `auth.ts`, seven `kicktodo_*` reason codes |
| Small host tables | `BackendFeature.hostContributions` (leaf `host/featureContributions.ts`): `participantFacingRunPurposes`, `enforcedPlanLimitKeys`, `subjectErasers`, `sideEffectingNodeTypes`; `BuiltinTool.safeModeApproval` on `log-checkin`; `listExceptions(…, { degradedHref })` from the caller | `runNoticeAudience`, `planLimitsSeam`, `subjectEraserManifest`, `firewallHook`'s `log-checkin`, `exceptionProjection`'s `/admin/kicktodo`, `sideEffects.ts`'s KickTodo regex |
| Package stylesheets | `<feature>/styles.css`, imported through the generated `styles/features.generated.css` right after `global.css` (same cascade position) | 313 KickTodo rules (823 lines) in `global.css` |
| Frontend declarations | `FrontendFeature.navMessages` (entry, ADR 0916); `FrontendFeature.lazyExtensions` → `{ dashboardTiles, reviewArtifactRenderers, reviewCardSections, chatWorkflowNames, cardOwnedCredentialRefPrefixes }`, read through `features/featureExtensions.ts`; `<feature>/manualTests.ts` `manualTestSuiteCases` | four `nav.ts` keys, `credentialRef`'s `kicktodo-factory:` prefix, `ReviewCard`'s plan-proposal panel + `fetchProposalPreview`, two chat catalog rows, RVW-06 |
| Lazy declarations | Only lazy surfaces read the five `lazyExtensions` fields: the dashboard, the review registry, the review card, the chat run header and the Keys page. `featureExtensions.ts` is imported only by those surfaces. Its top-level await resolves every composed feature's `() => import('./extensions.js')` once, so the accessors stay synchronous. The registry starts those fetches after the first paint. A chunk that fails to load contributes nothing. The P1 sync `dashboardTiles` / `reviewArtifactRenderers` fields still work, and they come first | P1/P2 tile, renderer and section metadata in the entry chunk. The entry headroom goes from 262 B (round 1) to 433 B |
| Gate rows | frontend `<feature>/gateDeclarations.json` (`scripts/featureGateDeclarations.mjs`); backend `<feature>/ratchetTables.json` (`pathTables`, `idTables`, read synchronously by `test/helpers/featureRatchetTables.ts`) | KickTodo rows in `check-notice-announce`, the 0598 cohort, and 14 more backend ratchets |
| Offline lane | `build-offline-fixture.mjs` writes a throwaway `src/adopter/features/offline-fixture/` package; `gen-service-worker` scans adopter dirs | KickTodo as the offline fixture |

Mixed tests are split by owner: the KickTodo half of each is under `test/kicktodo/`
(or the package's `__tests__/`), and the generic half uses neutral fixtures.

### Security: the feature-extensible security surface

**What is now extensible.** A composed backend feature may ADD, and only add:

- an admin-tier management scope `host:<ns>:<verb>` — granted to built-in admin
  and owner at a fixed position, mintable on a developer key, never carryable by a
  custom role (`isCustomRoleScope` admits protocol and delegable host scopes only);
- one activation-only role per declared default workspace (ADR 0910) — its scopes
  join a member's union only while a live operator activation exists;
- public unauthenticated routes of the shape `/public/<seg>/<seg>…`;
- log reason codes, which the logger writes past the PII mask.

Nothing can be removed or narrowed from the host vocabularies, and the host's own
lists keep their byte order (`managementScopes()`, `adminScopes()`, `ownerScopes()`
put feature scopes exactly where `host:kicktodo:manage` used to sit).

**Threat.** A feature package — first-party or an adopter's — widens the surface as
a side effect of some other change: a new admin scope, a broader operator role, an
unauthenticated route, or a log value that bypasses the PII mask. Before P2 that
change had to edit a host security table, so review saw it. A registration hook
without controls would make it invisible.

**Controls.**

1. *Composition only.* The stores are written by one function,
   `sealFeatureSecurity(BACKEND_FEATURES)`, called in `features/index.ts` right
   after composition. A feature that a distribution leaves out adds nothing, and a
   module that is not a feature has nothing to add.
2. *Closed at boot.* The same call seals the three leaf stores
   (`host/featureScopes.ts`, `middleware/featurePublicRoutes.ts`,
   `observability/logReasonCodes.ts`). Any later write throws, and so does a second
   seal. A lazy import or a request handler cannot widen RBAC or the auth bypass.
3. *Shape and vocabulary checks, at module load.*
   - A scope must match `host:<ns>:<verb>` and may not be a host scope.
   - An activation role may not reuse a built-in role id, and it may carry
     management scopes only.
   - A public route must match `^/public(/[a-z0-9][a-z0-9-]{0,63}){2,6}$`. It may
     not equal, contain or sit inside a host public prefix or another feature's
     route. It matches on the same segment boundary as the host list.
   - A reason code must match the static rule `LOG_REASON_CODE_FORMAT`
     (`^[a-z][a-z0-9_]{2,63}$`). That rule keeps PII out of the masked lane: a
     literal-only lowercase code cannot carry an email or a token.
   - The leaves import nothing. The host modules hand over their vocabulary when
     they finish loading, so these checks run whatever the evaluation order is.
4. *NO-GROWTH census.* `test/feature-security-census.test.ts` compares every
   registered entry and its owner with the owning package's committed
   `security.census.json`. Adding, removing or widening an entry without that
   baseline diff fails, so the diff is the review surface. KickTodo's baselines
   hold 11 entries: 1 scope, 1 role, 7 codes and 2 routes. Baselines may live
   only in composed feature directories.

**Behaviour is byte-identical.** The KickTodo half of the census
(`test/kicktodo/kicktodo-security-surface.test.ts`) pins three things:

- the positions of the moved scope in the ordered admin, owner, management and
  mintable-key lists;
- the two public routes, which are public on a segment boundary only;
- the 11-entry floor.

The adversarial authz suites (`kicktodo-authz-*`, `adr0910-operator-access`) pass
unchanged, apart from now reading the composed registry.

**Sabotage evidence.** Each control was broken once on purpose, and the named
case went red:

- registering after the seal (S1);
- making an unregistered path or a non-boundary sibling public (S2);
- deleting a baseline row (S3);
- widening the operator role (S4).

### Residue after P2 (the P3 deletions, not seams)

`git grep -i kicktodo` over `backend/typescript/src`, `frontend/react/src` and
`scripts`, excluding the KickTodo packages and `test/kicktodo/`, finds only comments
and these lines:

| Line(s) | Why it is legitimate | P3 action |
|---|---|---|
| `features/index.ts` imports and list entries; `features/registry.ts` imports and list entries | the composition itself | delete; the generated adopter lists take over |
| `features/packPins.ts` `feature.kicktodo.nodes`, `vendor.openwop-app.kicktodo.agents` | replay pins for packs this repo ships | move to the adopter's `ADOPTER_PACK_PINS` |
| `executor/sideEffectFloor.generated.ts` | generated from `packs/` | regenerates when the packs move |
| `scripts/test-deploy-gates.sh` one case label and its `kicktodo-prod` fixture argument | a deploy-gate regression named after the incident it pins | none (a string fixture) |

Backend tests outside `test/kicktodo/` keep KickTodo only as a sample string
(an ICS `PRODID`, a custom-domain hostname, an SEO title, a DSN), never an
import. The one exception is `test/fixtures/pack-surface-arg-parity.json` and
`packSurfaceParityScan`'s `bindKicktodoSurface`. That fixture is a whole-repo
measurement over `packs/`, so P3 re-measures it.

### P3 is a move plus a mechanical import rewrite

Moving `src/features/<pkg>/` to `src/adopter/features/<pkg>/` adds one directory
level, so every relative import that leaves the KickTodo family (`../../host/…`,
`../registry.js`, `../../ui/…`) needs one more `../`; intra-family imports
(`../kicktodo-core/…`) do not change. Every per-package declaration file moves
with its directory and is found from either root, so none needs editing:
`styles.css`, `gateDeclarations.json`, `ratchetTables.json`,
`ratchetDeclarations.ts`, `security.census.json` and `manualTests.ts`. The PR body
carries the exact recipe.

## Addendum — round 3 (2026-11-03): the host tables an adopter still could not extend

**Why.** The architect review of adopter packs (2026-11-03, "other findings" 6–10)
swept the P3 tree. It found five more host tables that an adopter app (KickTodo,
Book AI, the next one) cannot extend without editing an upstream-owned file. The
seams follow P2's `hostContributions` pattern, with no new mechanism:

- the declaration lives on the package's `BackendFeature`;
- `host/featureContributions.ts` records it once, at composition;
- every table is **add-only**. A host module hands its own values to the leaf
  (`reserveHostValues`), and a feature that redeclares one is a boot error,
  whichever of the two loads first;
- the security-widening tables are census-tracked in the package's
  `security.census.json`.

There is no wire change and no RFC. Every table is host-internal policy on
host-local surfaces, and every declaration lives in host TypeScript, never in a
pack manifest.

| # | Table | Verdict | Shape / evidence |
|---|---|---|---|
| 1 | `host/approvalGateTypeIds.ts`: a hard-coded gate list. This is a **safety** item: an adopter's or registry pack's `role:"gate"` node was a false negative, so a Builder Pair AI edit of it could be auto-kept (ADR 0582). | **Done** (PR #5549, on `main`) | `isApprovalGateTypeId` = host list ∪ manifest `role:"gate"`; add-only; fail-closed. Not a feature declaration: the manifest already carries the role, so it covers registry packs too. Witness red on `9a05b6cb8`, 4 of 7 cases: an adopter stub gate gave `[false,false,false]`, and **seven first-party pack gates were missed** (`brand.theme.review`, `core.chat.clarificationGate`, …). ADR 0773 OQ4 is answered there. |
| 2 | `features/kb/kbService.ts`: `TENANT_SCOPED_KB_ORGS` named `_kickbot`; the `ManagedSource` union and `MANAGED_COLLECTION_OWNER` named `kickbot` | **Done** (this round, on P2) | `hostContributions.kbTenantNamespaces` (`_<name>`) and `.kbManagedSources` (`{ source: ownerToggle \| null }`); the TYPE comes from augmenting `FeatureManagedSources`, P2's `FeatureApprovalKinds` shape. The host keeps `_team` and its four sources. `TENANT_SCOPED_KB_ORGS` is now a live `.has` view, because features record after kbService loads, and `FeatureSurfaceOrgPolicy.tenantScopedOrgs` takes that view. An undeclared managed source still fails CLOSED at the plan gate. KickTodo's declaration moved to kicktodo-core (`KICKBOT_KB_ORG`, `KICKBOT_KB_MANAGED_SOURCE`). |
| 3 | `host/agentToolProvider.ts` `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` | **Done** (this round, on P2) | `hostContributions.projectableComputeNodes: [{ typeId, schemaCarrying? }]`. `registerDeclaredComputeProjections()` runs once, right after the record, from `features/index.ts`. A tool name that is already registered (a host projection, a builtin or a feature tool) is a boot error, never a replacement. The tool is gated on the **declaring** feature's toggle and plan, not on the `feature.<id>.nodes.*` regex, which named no feature for a grandfathered id like `feature.kicktodo.nodes.*`. It refuses at call time unless the manifest says `role:"pure"`, before any toggle read. Not manifest-derived: ADR 0081 P3 rejected "no requires ⇒ pure" as a heuristic, and a pack must not be able to promote its own node into a chat tool. No adopter projects a node today, so this is a forward seam. |
| 4 | `types.ts` `NotificationType` | **Not a seam: already open** | **Not on the wire.** The inbox is host-local (`/v1/host/openwop-app/notifications`, `features/notifications`). The OpenWOP spec, schemas, AsyncAPI and conformance have no inbox notification type, measured in `../openwop` `spec/v2`, `schemas/` and `api/`. **Already open at the field:** `NotificationRecord.type` is `NotificationType \| string`, and three features already emit types outside the union without editing it: `chat.channel_post`, `approval.content-review-*` and KickTodo's `kicktodo.award-earned`. The union is documentation of first-party literals, not a gate. Residual, recorded rather than seamed: the per-type prefs list (`KNOWN_TYPES`, mirrored in the frontend) does not list adopter types. They still deliver and default to unmuted, but get no per-type toggle in the prefs UI. |
| 5 | `host/autonomyPolicy/actionClasses.ts` `NODE_ACTION_CLASSES` | **Skipped: extending it is wrong** | It has **no runtime consumer**: the only reader in `src/` is the `autonomyPolicy/index.ts` re-export, and nothing in `frontend/`, `scripts/` or `packs/` reads it. Its ratchet walks only `core.openwop.workflows.campaign-*` chains, and an adopter cannot author in `core.openwop.*`. Its own header says enforcement never trusts it: every effect chokepoint resolves the policy itself (ADR 0942 D5). A seam would let an adopter label nodes for a display nothing renders. Revisit if a consumer appears, as a feature declaration in this same leaf. |

**Census and sabotage.**
- `test/feature-security-census.test.ts` control 1 now compares
  `featureSecuritySurface() ∪ featureHostTableSurface()` with each package's
  baseline. kicktodo-core's baseline gains `kb-tenant-namespace _kickbot` and
  `kb-managed-source kickbot -> (not plan-gated)`.
- `test/adr1031-round3-host-tables.test.ts` is the generic seam: stub features on
  a fresh module graph.
- `test/kicktodo/kicktodo-kb-namespace.test.ts` is the KickTodo half: real
  `ensureKickbotKnowledge`, a member's recall, and the org floor.
- The generic probes that named `_kickbot` (`adr0830-kb-org-scope-probes`,
  `adr0832-org-scope-seam-probes`) now name only `_team`, so they survive P3.
- `adr0830-kb-ratchets` checks "listed" against the composed registry and walks
  both feature roots.
- The sabotage record is in the PR body.

**What changes for P3 and KickTodo #142.** The two `_kickbot` / `kickbot` literals
leave the host. That residue was not in the P2 residue table, which listed only the
composition, pins and generated floor. kicktodo-core now owns it, so P3 moves it
with the package and the "Residue after P2" table is unchanged. Two things change
at the P3 move:

- the module augmentation's relative specifier goes from `'../kb/kbService.js'` to
  `'../../../features/kb/kbService.js'`, the same one-more-`../` rewrite as every
  other import;
- `test/kicktodo/kicktodo-kb-namespace.test.ts` moves with the other KickTodo tests.

Nothing else in KickTodo's tree needs editing to use the seams.

## Addendum — P3 (2026-11-03, upstream half)

`feat/kicktodo-p3-remove` deletes everything the P2 recipe lists, so openwop-app
carries no KickTodo code, packs, chain examples, tests or distribution. KickTodo
adopts the same files in the sync that carries this deletion, using its own
`scripts/kicktodo-adopt-features.mjs`.

**What the deletion found that P2 had not:**

- **One host projection still named a KickTodo field.** `reviewProjection.ts`
  projected `planProposal` ids, and it only compiled because KickTodo augmented
  `PendingApproval`.
  - The fix: `FeatureApprovalKindDef.reviewFields(row)` returns the extra
    review-card fields for a feature's kind, typed by augmenting
    `FeatureReviewFields`.
  - The wire stays byte-identical (same keys, same position).
  - KickTodo registers it for `kicktodo-plan-proposal` as part of its adoption.
- **Ratchet floors counted KickTodo's population** (call sites, chains, packs,
  toggled features, `__test` declarers). They are re-measured, never deleted.
- **Six host test seams lose their only readers here.** Their readers were
  KickTodo's tests, which moved downstream.
  - They stay as named `ADOPTER_TEST_SEAMS` rows in
    `test-seam-export-ratchet.test.ts`.
  - A row reds if its symbol is deleted, or if the symbol gains a reader in
    this repo.

**`_kickbot` / `kickbot`:** no longer host code. Round 3 (above) moved both into kicktodo-core's `hostContributions`, so they leave with the package, and the generic probes name only `_team`.

## Open questions

- [x] The P2 shape for exception tables: feature-declared metadata —
      `<feature>/ratchetDeclarations.ts` (P2 addendum).
- [x] An approval-kind registration hook — `registerFeatureApprovalKind`, all six
      KickTodo kinds (P2 addendum).
- [x] `distributions/kicktodo.json` moves downstream in P3 (David, steward,
      2026-11-02). Kept upstream, it would name KickTodo ids that are no longer
      registered there, and `check-distribution-composition` would flag them.
      Downstream, it is an ADDED main-only file in KickTodo, so it costs no merge
      tax. It drops the 15 `kicktodo*` ids from `features[]`, because adopter
      features always compose and cannot be named there, and keeps `mustShip`.
      `gen-distribution --check` and `check-distribution-composition` scan
      `distributions/` wherever they run, so KickTodo's own gate still proves
      every KickTodo module ships. The KickTodo build's
      `OPENWOP_DISTRIBUTION=kicktodo` resolves to the same path. Upstream deletes
      it in the P3 PR, and the KickTodo sync PR re-adds it in the same merge.
