# ADR 0305 — App-Builder Editor Parity Program (MyndHyve full-feature migration)

Status: Implemented (2026-07-07) — all phases A–G landed (PRs #1448/#1451/#1454/#1456/#1457/#1459/#1460); H scoped via ADR 0307.

## Context

ADR 0153 Phase 2b shipped the app-builder's full-screen editor deliberately
minimal, and recorded the rest as follow-ups. What exists today
(`frontend/react/src/features/app-builder/`, `backend/typescript/src/features/app-builder/`):

- click-to-add palette over the **closed host catalog** (14 component types,
  `componentCatalog.ts`) — no drag-and-drop anywhere in the feature;
- selection via the component-tree outline only; no click-to-select on the
  rendered preview, no undo/redo, no screen CRUD (switch-only tabs);
- a catalog-driven property panel limited to
  `string/number/boolean/enum/longtext` prop defs — the `color` prop type is
  declared but never rendered; no style/spacing/action/responsive depth;
- a static, read-only, single-screen preview (`AppBuilderContentView` in one
  CSS device frame);
- optimistic-concurrency save into the seeded `host.canvas` working copy
  (the run artifact is never mutated) — this part is complete and correct;
- ADR 0173 code export: 6 server-side generators → secret-scrubbed ZIP as a
  Media token (react-styled is a partial mapper; GitHub-push/deploy deferred).

The MyndHyve baseline (`src/canvas-types/app-builder/` on CanvasShell) is the
target surface: native HTML5 drag-and-drop with nesting/reorder, ~50 component
types across 13 categories, 24 property editors (style, spacing, actions,
responsive overrides, data binding), an interactive Figma-style device-framed
preview route with share links, screen manager (create/rename/duplicate/
delete/reorder/set-initial), undo/redo plus version-history snapshots with
non-destructive restore, screen templates + template packs, a 4-stage AI
studio workflow (PRD → plan → design system → per-screen generation → quality
audit), GitHub push with env-vars handling, and a ~35-file VS Code IDE bridge.

Tracking drift found during the 2026-07-06 audit: the `app-builder` toggle has
no FEATURES.md row and no ROADMAP row of its own (only Code Export references
it); ADR 0153's status line still reads Proposed although Track 1 is complete;
the catalog header comment says "15" but the array has 14 types.

### Pre-existing-surface audit (what this program must reuse, not duplicate)

The architect review of this program (2026-07-06) enumerated the owners the
plan must extend — each was at risk of being shadowed by a naïve port:

| Concept | Existing owner | Consequence for this program |
|---|---|---|
| Public share links | `features/sharing` — opaque `randomBytes(32)` tokens in `DurableCollection('sharing:link')`, TTL + view caps, fail-closed resolve, public `GET /v1/host/openwop-app/shared/:token` already in `PUBLIC_PATH_PREFIXES` | Share = a new `ResourceType` + resolver in `sharingService`. **No new token scheme, no new public route.** |
| Canvas persistence + history | `host/canvasSurface.ts` (`DurableCollection('canvas')`) — shared by all canvas types; overwrites on save today | Snapshots live on the **host.canvas surface** (`DurableCollection('canvas:version')`), mirroring the CMS ADR 0206 `PageVersion` pattern (distinct-content dedup, `MAX_VERSIONS` cap, non-destructive restore). The app-builder feature only exposes routes over it. |
| Undo/redo | `builder/store/builderStore.ts` — fixed-depth deep-copy past/future stack, one entry per gesture, but hard-typed to the workflow graph | Extract the pattern into a generic shared `createHistory<T>` helper; the app-builder editor consumes it now; migrating `builderStore` onto it is a recorded follow-up. |
| Device preview | CMS page-builder client-side device widths (`DEVICE_MAXW`, `CmsPage.tsx`) + the existing `.canvas-ab__device` frame CSS | Preview is **frontend-only**; no backend preview endpoint. |
| Governed vendor writes | ADR 0028 governance + the `adapterOnly` manifest flag (`connectionInjection.ts` skips adapterOnly providers in `matchAllowedProvider`; `bigquery-write` precedent) | GitHub push must be an `adapterOnly` governed provider — never a raw `safeFetch`. ADR 0190:95 records GitHub-auth writes as gated; ADR 0306 supersedes that gate explicitly. |
| Template galleries | ADR 0190/0163 workflow-template gallery + preflight UX shells | Screen templates reuse the gallery UX shells; the screen-template catalog itself is new and distinct from workflow templates. |
| Route ordering | Express first-match; `canvases/from-artifact` already registers before `canvases/:canvasId` | All new routes stay `:canvasId`-scoped sub-paths; any literal registers before the param route. |
| Sub-surface toggles | The second-toggle convention (`registerToggleDefault`, category `Canvases`, `off`, bucket `tenant` — how `code-export` rides beside `app-builder`) | New gated sub-surfaces follow it. |

## Decision

Close the editor-parity gap in seven delivery phases under this one program
ADR, each independently shippable behind the (OFF) `app-builder` toggle, in
dependency order. GitHub publish and the IDE bridge get their own ADRs (0306,
0307) because they carry distinct security/artifact surfaces. Nothing in this
program touches the OpenWOP wire: every route is host-ext under
`/v1/host/openwop-app/app-builder/*`, and the normative
`canvas.app-builder.export[]` facet is never appended to (ADR 0173 rule).

### Principles (port-not-clone)

1. **One catalog remains the single source** for agent prompt, palette,
   validation, renderer, and all export generators. Catalog growth is a
   single-PR change across all five consumers, enforced by a parity test.
2. **Closed world stays closed.** No script/embed-bearing component types
   (lottie/map/chart-with-runtime) in v1; every exclusion is recorded below.
3. **Zero new runtime dependencies.** Native HTML5 DnD (the `builder/` palette
   `PALETTE_MIME` conventions), CSS device frames, snapshot stacks. The editor
   stays lazy-chunked; the entry-chunk budget is unaffected.
4. **MyndHyve's 24 property-editor components collapse into typed catalog
   prop-defs** (`color`, `spacing`, `radius`, `shadow`, `font`, `action`,
   responsive overrides) rendered by one catalog-driven panel.
5. **Additive schema evolution only** — existing `canvas.app-builder`
   artifacts must validate against every schema bump.

### Phases

| Phase | Scope | Gate |
|---|---|---|
| **A — this ADR + doc hygiene** | ADR 0305; ROADMAP program row + the missing app-builder row; FEATURES.md row for the `app-builder` toggle; ADR 0153 correction note (Track 1 complete; parity follow-ups now owned here); fix the "15 components" comment | ADR accepted; docs PR |
| **B — editor interaction core** (FE-only) | Palette→canvas HTML5 DnD (drop into hovered container or screen root) + outline reorder/re-parent + keyboard-equivalent add/move (the #457 a11y pattern); generic `createHistory<T>` undo/redo (Ctrl+Z/Y, one entry per gesture, batch drag/delete per the #129 lesson); screen CRUD (add/rename/duplicate/delete/reorder/set-home; ≤60 cap enforced both sides); click-to-select on the rendered preview + selection overlay. `canvasTree.ts` gains `moveNode`/`insertAt`/`duplicateAt`, unit-tested | FE build + vitest; no backend change |
| **C — catalog + properties + generator parity** (single PR) | Catalog 14→~35 curated types (cut list below); prop-def depth `color/spacing/radius/shadow/font/action` + responsive overrides; theme grows to tokens (primary/secondary/mode); additive `artifactTypes.ts` schema bump; renderers (escaped, `safeImageSrc` discipline); App Architect prompt regenerated from the catalog; all 6 generators map every new type (unmapped → `warnings[]`) and the react-styled partial mapper is finished; data binding v1 = list/text props bindable to `connectors[]` entries with sample-data resolution in preview. Pack `feature.app-builder.nodes` 1.1.0→1.2.0. Parity test: every catalog type has a renderer + 6 generator mappings | backend vitest + FE build; pack bump |

> **Correction note (2026-07-06, Phase C implementation):** data binding does NOT
> ride `connectors[]` as the row above says — connectors are *navigation edges*
> (`from`/`to` screen ids), the wrong facet for tabular sample data. Phase C added
> an additive `dataSources[]` facet ({id, name, fields[], sample `rows` ≤10, ≤20
> sources}) with `list.bind` + `{{field}}` interpolation instead; `connectors[]`
> is unchanged. Two further Phase-C decisions recorded here: (a) MyndHyve's
> free-form style editors collapse into closed TOKEN-SCALE enum props
> (padding/gap/radius/shadow/fontSize/tone) + strict-hex `color` props —
> free-form CSS, transform, animation, and gradient editing are deliberate
> exclusions; (b) responsive v1 is `hideOn` (never|mobile|desktop) +
> `grid.columnsMobile`, not per-breakpoint override maps. Cross-facet references
> (navigateTo/bind/connectors → missing target) are SOFT warnings via the new
> `validateAppDoc` (mid-edit states must stay saveable); catalog violations are
> hard 422s on the editor PATCH.
| **D — interactive preview + share** | Lazy route `/app-builder/:canvasId/preview`: interactive renderer (`action` props navigate screens), client-side device presets (~8 CSS frames: 2 phones, 2 tablets, 3 desktops, responsive), dark/light, fullscreen. Share = `app_builder_canvas` ResourceType + resolver in `sharingService` (opaque token, TTL, fail-closed) + a share affordance in the editor | FE build; sharing-resolver test |
| **E — version history** | `host/canvasSurface.ts`: throttled distinct-content snapshots into `DurableCollection('canvas:version')` on save (CMS `PageVersion` shape; `MAX_VERSIONS` cap); list/get/restore exposed via `:canvasId`-scoped app-builder routes; restore is non-destructive (writes a new version). FE history rail: version list, change summary, restore via `ui/confirm` | backend vitest incl. route-level authz tests |
| **F — templates + AI workflow depth** | Host screen-template catalog (~10 templates: dashboard, auth, settings, list-detail, profile, onboarding, commerce, feed, form, empty) + palette Templates tab (insert = tree merge with id-remap), reusing the ADR 0190 gallery UX shells; `feature.app-builder.workflows` chain pack (ADR 0157 pattern): PRD → implementation plan → design tokens → per-screen generation (`itemsFrom`) → quality audit, driven through the one chat by the App Architect | pack manifests validate; chain runnable |
| **G — GitHub publish (ADR 0306)** | `github` connection provider, **`adapterOnly: true`**, ADR 0028 governance-gated; repo-create/push of an export bundle; env-vars server-side only and secret-scrubbed; closes the ADR 0173 deferral and supersedes the ADR 0190:95 gate | ADR 0306 accepted; governance tests |
| **H — IDE bridge (ADR 0307)** | Scoping ADR only in this program: connect/sync/conflict-resolution against the export (C) and history (E) seams; the companion VS Code extension is a separate artifact decision recorded there | ADR 0307 authored |

### Catalog cut list (Phase C)

Additions (~21): `accordion`, `alert`, `avatar`, `breadcrumb`, `calendar`
(display-only), `carousel`, `chip`, `dialog`, `drawer`, `fab`, `icon`
(curated Lucide-name enum), `pagination`, `progress`, `radioGroup`, `rating`,
`slider`, `snackbar`, `spacer`, `stepper`, `tabs`, `toggle`.

Recorded exclusions (v1): `lottie` (script-bearing animation runtime),
`map` (external tile provider — CSP + network egress), `chart` (needs a
data-viz runtime; revisit once a safe closed renderer exists), `markdown`
(raw-content injection surface; the escaped `text`/`heading` types cover the
need), `post`/`like`/social composites (product-specific, composable from
primitives), `scaffold`/`home` (MyndHyve screen-level scaffolding — screens
already model this here).

## Alternatives considered

- **Port CanvasShell wholesale** (MyndHyve's generic shell + plugin registry).
  Rejected: a parallel editor engine beside `builder/` violates the
  architecture contract; the closed-catalog model makes the shell's open
  plugin surface unnecessary here.
- **A dnd library (dnd-kit/react-dnd).** Rejected: new runtime dependency,
  bundle pressure, and the in-repo native-DnD precedent already carries a11y
  conventions.
- **Signed share tokens (JWT-style).** Rejected by the architect review: the
  app's single share-token scheme is opaque-lookup; a second scheme is drift.
- **Snapshots inside the app-builder feature.** Rejected: `host.canvas` is the
  single owner of canvas persistence across canvas types.
- **Porting the 24 property-editor components.** Rejected: typed prop-defs on
  the one catalog keep prompt/palette/validation/renderer/generators in
  lockstep; bespoke editors would fork that.

## Open questions → resolution mechanisms

- **Final Phase C cut list** — fixed above; any change is an ADR amendment.
- **History retention** — `MAX_VERSIONS = 50` per canvas (CMS precedent),
  distinct-content dedup, snapshot-on-save throttle ≥ 30s between snapshots.
- **Share default TTL** — 7 days, view-cap optional, both per-link overridable
  (sharing-feature semantics apply as-is).
- **Toggle flips** — `app-builder` stays OFF through G; flip is a separate
  operator decision after live verification (the ADR 0292 seeding lesson).

## Phase → commit table (updated as phases land)

| Phase | Status |
|---|---|
| A | landed (PR #1448) |
| B | landed (PR #1451) — DnD + undo/redo + screen CRUD + click-select; 33 unit tests |
| C | landed (PR #1454) — catalog 14→35 + property depth + binding + generator parity |
| D | landed (PR #1456) — interactive device preview + share on the sharing seam (+ the resourceId secret-scrub fix) |
| E | landed (PR #1457) — version history on `host.canvas` + editor History modal |
| F | landed (PR #1459) — screen templates + the app-builder.design real-AI chain |
| G | landed (PR #1460) — ADR 0306 GitHub publish (governed `github-publish` provider) |
| H | scoped (ADR 0307) — the host bridge contract is the already-shipped seams (canvas GET/PATCH+409, version API, generators, publish); the VS Code extension is a separate-repo artifact behind its own gate; live-push is a recorded follow-on triggered by the extension materializing |
