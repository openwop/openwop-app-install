# ADR 0333 — Drawing best-in-class program: core canvas infrastructure + the vector ink layer

Status: implemented (2026-07-10 — Phases 1–8 shipped, PRs #1597–#1618 range; see the phase table)

## Context

`canvas.drawing` shipped as an ADR 0310 Phase-C elements-trait consumer with ADR 0317
direct manipulation: 7 vector shape kinds, marquee/multi-select, group
move/resize/rotate, vertex editing, snap-to-grid — but a **fixed `viewBox 0 0 w h`**
(no pan/zoom anywhere in elements canvases), no freehand ink, no tool modes (click
adders only), no z-order/group/lock model, raw string fields for colors, no export,
and a 30-step undo.

The industry deep-dive
([`docs/research/drawing-best-in-class.md`](../research/drawing-best-in-class.md),
PR #1596 — a 107-agent adversarially-verified research pass + four primary-source
inventories) established (a) the **vector-vs-raster verdict**: a best-in-class vector
surface (tldraw/Excalidraw/Concepts class) is fully reachable additively on the
chassis, while every headline raster feature (blend modes, wet mix, dab engines,
raster layers) presupposes a pixel compositor that fights the JSON doc, snapshot
history, one-safe-renderer, and replay invariants; and (b) the **two-layer taxonomy**:
navigation/scene-structure/snapping/export/color-widgets/a11y are generic
infinite-canvas infrastructure, ink is drawing-specific. That taxonomy maps exactly
onto the ADR 0310 boundary (`src/canvas/` vs `features/drawings/`).

## Decision

Implement the research doc's §4 blueprint as an 8-phase additive program. The
placement rule is normative for this program: **a capability lands in `src/canvas/`
iff another canvas type (CAD, slides, campaign, app-builder, Tier-1 packs) would
plausibly consume it; otherwise it lands in `features/drawings/`.** The chassis never
draws content; the type owns its renderer and geometry (ADR 0310). All schema changes
are additive on the host-owned `canvas.drawing` artifact type — **no wire/RFC
surface** (the standing non-normative rule). Everything rides the existing `drawings`
toggle; no FEATURES.md change.

Core capabilities (research doc §3.1, C1–C16): viewport
(pan/zoom/fit/100%/to-selection + edge scrolling + culling prefilter), a `tools[]`
definition seam with chassis-owned mode state, z-order ops + `groupId` grouping +
`locked`/`hidden`/`name` element chrome, a snapping/smart-guides engine +
align/distribute, an `export` definition seam (SVG + PNG rasterize helper),
parametric history depth, a declarative shortcut registry + `?` cheatsheet, canvas
a11y (reading-order traversal, announcements, focus ring), a real color-picker
property widget with theme-indirected named palettes, per-kind style memory, and an
`emptyState` onboarding slot.

Drawing capabilities (§3.2, D1–D12): a `stroke` element kind (point+pressure spine,
perfect-freehand-style outline in pure `strokeGeometry.ts`, streamline EMA + RDP
simplification, ≤600 pts/stroke split-and-continue), a `usePointerStroke` hook
(pointer capture, coalesced+predicted events, pressure/`simulatePressure`,
pen-vs-finger policy), pen/highlighter/eraser + drag-to-draw shape tools + `arrow`
kind, QuickShape hold-to-fit ink beautification, grid + symmetry assisted drawing,
the drawing style panel over the core color/style widgets, doc `background`, inline
text editing, and the SVG/PNG serializer feeding the core export seam.

Non-goals (recorded, §3.3): raster brush engine / raster layers / blend modes
(future separate `canvas.painting` type if ever), multiplayer (own ADR + RFC),
ICC/P3/print, timelapse, minimap, QuickMenu radial (follow-up once tool count
grows).

## Alternatives considered

- **Raster-first drawing (Procreate class)** — rejected on the substrate mismatch
  above; recorded as the `canvas.painting` escape hatch, never a retrofit.
- **Adopt tldraw/Excalidraw as a dependency** — rejected: forks the renderer safety
  model (one safe `ShapeEl` path, no third-party DOM injection into docs), fights
  the chassis selection/history ownership (ADR 0317's one-owner rule), and imports
  a second undo/selection/tool system wholesale (the "no second chat system"
  lesson applied to canvases). We adopt their *specs* (verified in the research
  doc), not their code.
- **Viewport inside `features/drawings/`** — rejected: CAD needs it identically,
  `GraphSurface` already half-owns the math; duplicating pan/zoom per type is the
  exact chassis-rot ADR 0310 exists to prevent.
- **A layers panel with raster-style layers** — rejected: the research's factoring
  shows the generic half is z-order/groups/lock/hide, which the element list already
  hosts; blend/alpha semantics have no substrate here.

## Wire / RFC

None. Additive host-owned schema + existing `host.canvas` PATCH surface; host-ext
routes unchanged. `OPENWOP_REQUIRE_BEHAVIOR` unaffected.

## Phases

| Phase | Layer | Scope | Gate |
|---|---|---|---|
| 1 — Viewport | CORE | `canvas/viewport.ts` (pure math, parametrized zoom clamps; `graph/edgeRouting` DELEGATES its viewport formulas — one owner) + `useCanvasViewport` (Space/middle/two-pointer pan, Ctrl/⌘-wheel focal zoom + pinch, native non-passive wheel per the F2 precedent, plain wheel PANS — the GraphSurface convention is normative app-wide) + `ViewportSurface` (chassis-owned wrapper TRANSFORM — consumers' `getScreenCTM` pointer math works unchanged; NO viewBox rewriting) + zoom chrome (−/readout/+/fit-to-artboard/100%). Mounted around `InteractivePreview` in the chassis: **no `InteractivePreviewProps` change, no feature-file edits**; drawings + CAD adopt for free. Viewport state is ephemeral (never in history). | viewport unit suite (zoom-at-cursor invariant, fit round-trip, clamps); zoom-chrome jsdom tests; drawings/CAD/graph suites green byte-identical; /browser light+dark |
| 2 — Tools & scene ops | CORE | `tools[]` seam MINIMAL (id/icon/i18n; chassis-owned active-tool state + toolbar + Esc-to-select; the pointer-session API ships with its first real consumer — Phase 3's pen, the ADR 0310 proving-phase precedent); `bboxFor` on `ElementsCollectionDef` → overlap-aware `reorderElements` in `elementOps` + arrange UI/shortcuts (z-order = array order, round-trips through today's validators) + zoom-to-selection as VIEWPORT chrome (`selectionBounds` prop); `ViewportSurface` gains a controlled mode (`vp?` prop; uncontrolled default unchanged) + `fitBounds`; `viewport`/`activeTool` passthrough on `InteractivePreviewProps` (all-optional, consumers compile unchanged); edge scrolling + arrow-key pan; declarative shortcut registry = the ONE chassis window-keydown owner (undo/redo absorbed; ⌘K reserved to ui/; definition extras lose collisions with a dev warning) + `?` cheatsheet; per-kind style memory (session-ephemeral by design). **Phase-2 architect gate:** element chrome (`locked`/`hidden`/`name`) + `groupId` MOVED to Phase 3 — the drawings/CAD validators reject unknown element fields (`validateDrawingDoc.ts` + `additionalProperties:false`), so chrome must land WITH its backend mirror, not as a 422-on-save or silently-ephemeral toggle. | chassis suites; ADR 0317 interactive suites unchanged; reorder/registry unit suites |
| 3 — Ink | DRAWING | schema `stroke` + element chrome fields (`locked`/`hidden`/`name`) + `groupId` grouping (moved from Phase 2 — lands WITH the validator mirror; BOTH mirrors move together + a dual-mirror fixture) + validators; **the Phase-2 "pointer-session API" resolves to ONE additive seam: `addElements(col, els) → number[]` on `InteractivePreviewProps`** (one undo step; live stroke = type-local overlay; eraser rides `deleteElements`) — the proving-phase outcome; pure spine→outline math lives BESIDE the renderer (`chat/artifacts/strokePath.ts`, the one-render-path rule; `features/drawings/strokeGeometry.ts` adds editor-only streamline/RDP/bbox/hit-test); `usePointerStroke`; pen/highlighter/eraser via `activeTool`; `ShapeEl` stroke branch; history depth via a `historyDepth` definition seam (drawings: 200); bbox culling prefilter; chassis element-list chrome gated by a `chrome?: boolean` collection flag (drawings on; CAD after its validator mirror — recorded) with the locked guard at the chassis GESTURE seams only (patch/patchBatch/delete — the panel/list stay open: they're how you unlock); groupId select-as-unit expands TYPE-side (the marquee precedent), ⌘G/⇧⌘G group/ungroup in the chassis registry | geometry unit suite; one-undo-per-stroke; dual-mirror backend fixtures |
| 4 — Shape tools & QuickShape | DRAWING | drag-to-draw all kinds + `arrow`; Shift/Alt constraints; QuickShape fit + regularize; inline text editing | fit suite; constraint tests |
| 5 — Snapping & alignment | CORE | `canvas/snapping.ts` + guides overlay + align/distribute/tidy; drawings adopts | snapping unit suite; app-builder unaffected |
| 6 — Color & style | CORE+DRAWING | `ui/ColorField` + `color` widget + named theme palette; drawing style panel; PropDefs upgraded; slides/campaign adopt | picker a11y; token gates |
| 7 — Guides & symmetry | DRAWING | grid overlay + snap config; symmetry V/H/quadrant/radial live assist | symmetry geometry suite |
| 8 — Export & polish | CORE+DRAWING | export seam + SVG/PNG/clipboard; serializer; `emptyState` onboarding; a11y batch; touch gestures (two/three-finger undo/redo, pinch nav, long-press eyedropper) | export smoke; /ux-review pass |

Per phase: `/architect` gate before implementation; `npm run ci` green;
`/code-review` + `/ux-review` with fixes applied; one PR citing
`(ADR 0333 §Phases / Phase N)`; DCO-signed; this table updated as phases land.

> **Phase-3 a11y note (WCAG 2.5.7).** Freehand ink has no keyboard creation
> path by design — path-dependent input falls under the "dragging is
> essential" carve-out (signature-field precedent). Every non-ink authoring
> action keeps a keyboard equivalent (adders, panel fields incl. the chassis
> chrome fields, arrange buttons, shortcuts); the property panel is the
> canonical keyboard/AT surface for name/lock/hide (the list toggles are
> pointer sugar).

> **Grade-pass hardening (2026-07-10, independent code/ux/data triple audit).**
> The shipped program was adversarially re-graded by scouts (none the author);
> 8 blockers were found + fixed with fixtures — transport≪cap (scoped 8mb
> parser on the canvas base paths), typed-artifact no-truncate, per-pointer
> touch tap-undo, export `currentColor` resolution, atomic add-at-cap +
> announcement, a **safe-color paint grammar** in both mirrors + a render-time
> belt (an SVG paint `url()` was a zero-click cross-origin beacon), closed +
> finite `points` validation (dual-mirror drift), stroke group-resize,
> stroke-split overlap, `e.button` guard, mid-stroke tool capture, and
> per-render reparse/grid memoization. **Standing policy: the `canvas.drawing`
> caps are RATCHET-UP-ONLY** — `restoreCanvasVersion` writes a snapshot without
> re-validating (safe because a historical doc was valid under an
> equal-or-smaller cap); a cap DECREASE would strand old docs and MUST instead
> re-validate at restore. Recorded residue lives in CODEBASE/DATA-ASSESSMENT
> (`DRAW-R*` / `DATA-D*`): structural-shared clone, interaction test suite,
> history-by-bytes, idem-row cascade, Esc-drag-revert, FE propDef bounds.
>
> **Grade-pass residue — CLEARED (2026-07-10, PRs #1637/#1640/#1642/#1644 + this
> one):** DRAW-R1 structural-shared clone + bounded history (#1637); DRAW-R2
> interaction test suite (#1640); DRAW-R3 Esc-drag-revert (#1642); DRAW-R4 +
> DATA-D9 FE propDef bounds — panel edits clamp instead of 422ing (#1644);
> **DATA-D6/7/8 (this PR):** restore now RE-VALIDATES the snapshot against the
> type schema before writing (the "MUST re-validate at restore" contingency above
> is now implemented — errors 422 with nothing mutated, warnings restore + echo),
> the ephemeral create/write idempotency rows get a TTL sweep (from-artifact
> reopen-dedup exempt), and the version-LIST read projects to light metadata
> (never decodes snapshot blobs; destructive eviction stays on the authoritative
> primary read).

## Recorded follow-ups (deferral section)

**Triage (2026-07-10 grade-pass wrap).** The residue splits three ways:

**DONE this grade pass.** ~~**GraphSurface adopts `useCanvasViewport`**~~ **DONE
(ADR 0337 Phase 2c)** — the graph's gesture state machine migrated onto the hook
(ADR 0323/0325 pins preserved via the `backgroundPan` opt-in + a `fitBounds`
per-fit ≤1:1 clamp), netting the free arrow-key pan. ~~**Screen-constant
selection handles**~~ **DONE (this PR)** — `InteractiveDrawing` owns its viewport
via the existing CONTROLLED-mode seam (no `ViewportSurface` API change → no
collision with the concurrent ADR 0337 viewport work) and sizes the whole
selection-overlay chrome (outline, handles, rotate stalk, vertices) in SCREEN
space via `hz = screenConstant(unit, zoom)`; the committed scene stays doc-space,
and the scene shape list is memoized so owning the vp doesn't re-render every
shape per pan/zoom frame. **Stroke weight is now screen-constant too** (follow-up
PR): a `--hz` (= 1/zoom) custom property published inline on the svg drives the
overlay stroke-widths + dash patterns via `calc(n * var(--hz, 1))` — the inline
def satisfies `check-css-tokens` (it sanctions the `style={{'--x':…}}` pattern),
so the earlier "skipped to stay inside the token gate" worry was unfounded.
**Verification** is no longer only-click-through: an integration test drives the
real `ViewportSurface` zoom chrome and asserts the handle geometry × zoom stays
≈ the zoom-1 baseline (true screen-constancy); the light/dark *aesthetic* remains
owed to the runtime pass, but the *sizing behavior* is now CI-asserted.
**Keyboard pan** (WCAG) already shipped in Phase 2 (arrow-key pan on the focused
viewport).

> **Bundle note (2026-07-10).** The entire ADR 0333 program (all 8 phases + the
> grade pass) adds **zero bytes to the entry chunk**: `DrawingsEditorPage` is a
> `lazy()` route import, so `InteractiveDrawing` / `useCanvasViewport` / the
> `cv-draw-interactive` CSS all live in the separate `DrawingsEditorPage` chunk
> (verified absent from `index-*.js`). The entry's 185.5/186.0 kB-gzip tightness
> is pre-existing chat-shell weight (react-dom + react-router + the eager `/`
> shell) with its own documented code-split lever — NOT a drawings cost, and not
> resolvable from this surface.

**OUT OF SCOPE — need their own decision record before any host work:**
- **`canvas.painting`** (a RASTER paint surface — brushes, layers, a bitmap
  document) is a NEW canvas TYPE, not a `canvas.drawing` extension: it needs a
  raster document model, tile/layer storage, and a GPU/canvas render path with
  none of the vector doc's structural-sharing or SVG-safety assumptions. It MUST
  get **its own ADR** (document model + storage + perf budget) before code. Not a
  grade-pass item.
- **Multiplayer / live co-editing** is **RFC-gated**: concurrent editing touches
  the OpenWOP wire (a presence/CRDT/op-sync surface, conflict semantics, and an
  auth/scale profile), so per `CLAUDE.md` it needs a **new RFC in `../openwop`**
  reaching at least `Accepted` before/with any host work — an ADR here cannot
  license a wire change. Not a grade-pass item.

**Deferred product increments (each its own scoped work, not a grade-pass
fix).** Spatial-index culling (>2k elements — speculative until the 2000-node cap
is actually stressed; a fixed-viewBox SVG doesn't need it yet), partial stroke
erase (spine-splitting — a real new eraser mode + geometry, not a polish),
isometric/perspective guides, arrow-to-shape bindings (a binding/reflow model),
QuickMenu radial, minimap, gap-snapping + Figma-tidy distribute, shapes-symmetry
+ axis repositioning, QuickShape second-tap regularize.

## Phase → commit (updated as phases land)

| Phase | Status |
|---|---|
| 1 — Viewport | implemented — PR #1597: `canvas/viewport.ts` + `useCanvasViewport` + `ViewportSurface`; edgeRouting delegates; drawings + CAD compose the surface; pure suite + chrome tests; full FE build + vitest green |
| 2 — Tools & scene ops | implemented — PR #1598: minimal `tools[]` seam + chassis tool state + Esc; `bboxFor`/`styleKeys` seams; overlap-aware `reorderElements` + arrange buttons + ⌘]/⌘[ shortcuts; shortcut registry (ONE keydown owner) + `?` cheatsheet; style memory; `ViewportSurface` controlled mode + zoom-to-selection + arrow-key pan + edge scrolling |
| 8 — Export & polish | implemented — core `canvas/exportUtils.ts` (stripped-clone SVG serialization — one render path; classed editor chrome removed; standalone sizing — + PNG rasterize + download + guarded clipboard); export UI in the drawings bar (chassis menu seam recorded until CAD consumes); chassis touch tap-undo (two-finger undo / three-finger redo on the preview container; a second touch cancels live touch-ink — two fingers never draw); `deleteElements` count announcement (the eraser was silent); pristine-doc onboarding hint (type-local; chassis `emptyState` slot recorded). **Honest gate note:** the runtime /browser light+dark pass deferred at Phase 1 is owed to the `/manual-tests` + deploy-smoke flows — the editor needs auth+org+toggle+doc, so a headless static run only reaches the login wall; all static gates (tsc, token/CSS/i18n/budget, vitest, lint) ran green per phase. |
| 7 — Guides & symmetry | implemented — flat doc guide fields (gridSize/gridShow/gridSnap/symmetry/symmetryRotational; dual mirrors + whitelist + fixtures; the panel IS the config UI via docPropDefs); doc-driven grid (bar checkbox = session override); symmetry LIVE assist for ink (pure `symmetryVariants` — V/H/quadrant/radial ×(rotational|kaleidoscope D4); variants land in ONE addElements batch sharing a `nextGroupId` — extracted to elementOps, one owner); axis overlay. Recorded: shapes-symmetry, axis repositioning, QuickShape-fit variants |
| 6 — Color & style | implemented — shared `ui/ColorField` (theme-token swatches resolved at runtime + none + recents + EyeDropper) replaces the canvas `color` built-in internals; ALL `type:'color'` props inherit it; drawings paint fields (fill/stroke/color) upgraded to `color`; stale FE `max: 500` aligned to the backend 2000 (+ the capParity pin) |
| 5 — Snapping & alignment | implemented — PR #1604: pure `canvas/snapping.ts` (sibling edge/center candidates once per gesture; Ctrl/⌘ bypass; grid checkbox wins; gap-snapping = recorded follow-up) + `snapAngle` Shift-rotate 15°; guides overlay in drawings; chassis align/distribute via the NEW `movePatchFor` collection seam + `canvas/alignOps.ts` (one batch, locked/hidden skipped; Figma tidy = recorded follow-up) |
| 4 — Shape tools & QuickShape | implemented — drag-to-draw rect/ellipse(+shift=circle)/line/arrow tools (Shift constrain, Alt center, click=default-size); `arrow` kind (dual-mirror; computed polygon heads — never SVG markers); QuickShape hold-to-fit (pure `quickShape.ts`: ellipse-normalized roundness + RDP corner skeleton; fit REPLACES the pen commit, one undo step; second-tap regularize = recorded follow-up); inline text editing (positioned textarea, Esc cancels/blur commits) |
| 3 — Ink | implemented — schema `stroke` + chrome + `groupId` (dual-mirror fixtures); `addElements` seam (the pointer-session resolution); `strokePath.ts` beside the renderer + editor geometry in `shapeGeometry.ts`; `usePointerStroke` (coalesced events, pen pressure, pen-seen-finger-navigates); pen/highlighter/eraser tools; `ShapeEl` stroke branch + hidden skip; `historyDepth` 200; chassis chrome (lock/hide/name, `chrome` flag) + ⌘G/⇧⌘G grouping + group select-as-unit. **Correction:** the "bbox culling prefilter" moved to the recorded follow-ups — a fixed-viewBox SVG at ≤2000 simple nodes doesn't need it yet, and honest culling wants the spatial index anyway; hidden-skip ships now. |
| 3 — Ink | — |
| 4 — Shape tools & QuickShape | — |
| 5 — Snapping & alignment | — |
| 6 — Color & style | — |
| 7 — Guides & symmetry | — |
| 8 — Export & polish | — |
