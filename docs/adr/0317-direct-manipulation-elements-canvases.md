# ADR 0317 — Direct-manipulation editing for elements-trait canvases

Status: Accepted (2026-07-07)

## Context

ADR 0310 Phase C shipped the drawings/CAD/campaign editors as
**properties-driven**: select an element from the list, edit its numeric fields
in the property panel. The research doc (§5.5) recorded a direct-manipulation
canvas — click-select and drag on the rendered scene — as the type-specific
follow-up, and the ADR 0310 grade trackers carried it as open residue. Editing
a rectangle's position by typing X/Y is a poor fit for a visual tool; users
expect to grab and move it.

## Decision

1. **A chassis seam, `InteractivePreview`, on the elements trait.** A
   `CanvasTypeDefinition` MAY supply `InteractivePreview?: ComponentType<
   InteractivePreviewProps<Doc>>`. When present (and the type is elements-mode),
   the chassis renders it in the editor center INSTEAD of the read-only
   `Renderer`. `PreviewPanel` (the RFC 0130 pack plugin frame) takes precedence;
   absent both, the read-only `Renderer` is unchanged.
2. **The chassis owns selection + history; the preview only reports gestures.**
   `InteractivePreviewProps` gives the preview `doc`, the current `selection`,
   `onSelect`/`onClearSelection`, and `patchElement(col, idx, patch, phase)`.
   The `phase` maps onto the history model so a whole drag is **one undo step**:
   `'start'` pushes the pre-gesture snapshot (`history.set`), `'move'` updates
   live (`history.replace`), `'end'` finalizes the dirty flag. This reuses the
   exact editGen/dirty plumbing the property panel already uses — no second
   mutation path, and the property panel + element list stay fully functional
   (the interactive canvas is an ADDITIONAL affordance).
3. **Drawings: full manipulation.** Click a shape to select, drag its body to
   move (all 7 kinds), drag a handle to resize (rect SE corner, circle radius,
   ellipse SE corner, line endpoints). The geometry is a pure, unit-tested
   module (`shapeGeometry.ts`); the component is thin pointer→SVG plumbing over
   the SHARED safe `ShapeEl` renderer (one SVG: visuals + transparent hit layer
   + selection outline/handles).
4. **CAD: move.** Drag a solid's footprint to move it in X/Y. The projection
   auto-fits, so the camera `scale` is frozen at the gesture start (the fit
   would otherwise shift under the pointer) and the screen delta is converted
   back to model units with the model-y-up/screen-y-down flip. Dimensions stay
   in the property panel — a single handle has no unambiguous meaning for a 3D
   primitive in an orthographic footprint. The projection (`cadProjection`,
   `cadFootprint`, `CadSolids`) is extracted from the renderer so the editor's
   base layer and overlay share ONE transform and align by construction.

## Alternatives weighed

- **Per-type bespoke editors (no chassis seam)** — rejected: each would
  re-implement selection + history + save; the seam keeps ONE owner (ADR 0310).
- **Re-rendering shapes inside the interactive component** — rejected: it would
  fork the safety-sensitive renderer. Reusing `ShapeEl`/`CadSolids` keeps one
  render path (no `<script>`/`foreignObject`/raw markup ever reaches the DOM).
- **CAD resize handles now** — deferred: an orthographic footprint handle maps
  ambiguously to width/height/depth/radius; wants a camera/gizmo rework first.
- **Campaign interactive canvas** — N/A: campaign channels/funnel/assets have no
  spatial rendering; the list + panel is the right editor (no `InteractivePreview`).

## Wire / RFC

Frontend-only over the existing `host.canvas` PATCH surface — no wire change,
no RFC, no new toggle (rides each type's existing editor toggle).

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Chassis `InteractivePreview` seam + `patchElement` history mapping | PR C |
| 2 | Drawings move/resize (`shapeGeometry` + `InteractiveDrawing`) | PR C |
| 3 | CAD move (projection extraction + `InteractiveCad`) | PR C |

## Recorded follow-ups

- **Done (2026-07-07):** on-canvas per-vertex polyline/polygon editing (drag a
  point) + optional snap-to-grid — both extend the seam over pure, tested
  geometry (`shapeVertices`/`vertexMovePatch`/`snapPatch`).
- **Done (2026-07-07):** the **CAD gizmo** — a rotate knob + per-kind edge
  resize handles. Rotation is an additive `rotation` field on `canvas.cad`
  (host-owned schema, no RFC), applied as an in-plane SVG `rotate` — the ONLY
  rotation the orthographic front elevation can honestly depict (X/Y tilt still
  needs the Tier-2 WebGL viewer). Resize is CENTRE-PRESERVING (the footprint
  centre is the rotate pivot, so resize stays correct while rotated); depth
  stays in the panel. Pure geometry in `cadGeometry.ts` (`cadRotatePatch`,
  `cadResizePatch`, `rotatePoint`, `solidCenter`, `cadResizeHandles`).
- **Done (2026-07-07):** drawings **multi-select** — informed by a best-practices
  research pass (Figma/tldraw/Excalidraw/CAD/WCAG). Marquee INTERSECT-selects
  (design-tool default), Shift+click toggles, Shift+marquee unions; dragging any
  member moves the whole set (one undo step); "Delete N" removes them. Kept
  CANVAS-LOCAL (not a chassis selection-model rewrite): the chassis single-select
  is mirrored when N=1 (panel edits it) and cleared when N≠1 (panel shows doc
  props, never blank). Added two additive seam methods — `patchElements` (batch
  patch; looping `patchElement` clones the committed doc each call and loses all
  but the last) and `deleteElements` (index-descending, respects `min`). WCAG
  2.5.7: the marquee + group-drag are pointer enhancements; select-by-click,
  numeric-panel-move, and the Delete button are the single-pointer alternatives.
  Pure geometry (`boxesIntersect`/`unionBox`) + chassis batch seam unit-tested.
- **Done (2026-07-07):** Alt-for-contain marquee mode — hold Alt/Option while
  drag-selecting to pick only fully-enclosed shapes (`boxContains`); a solid
  marquee rule (vs the dashed intersect default) cues the mode. The Sketch/Miro
  convention, not AutoCAD's drag-direction trick.
- **Done (2026-07-07):** **ARIA-multiselectable element list** — the chassis
  element list is a `role=listbox aria-multiselectable` with roving tabindex,
  `role=option`/`aria-selected` rows, and Arrow/Home/End/Space/Enter + Shift
  extend, so keyboard users get full multi-select (the WCAG-canonical fallback).
  This unified the selection model: the chassis now owns a `multiSel`
  (`{col, idxs}`) as the ONE source of truth — `selEl` (the panel/arrange/delete
  single target) is DERIVED (size 1), and the interactive canvas reads/writes
  the same set via new `selectedIndices`/`onSetSelection` seam props (the
  canvas-local set from #1500 is gone). The property panel and arrange/delete
  logic are unchanged (they read the derived `selEl`).
- **Done (2026-07-07):** group RESIZE — the group bounding box (N>1) gets corner
  handles; dragging a corner UNIFORMLY scales the whole set about the fixed
  opposite corner (`scaleShapePatch`, one undo step via `patchElements`). Uniform
  so a circle stays a circle (the schema has no shape-morph path).
- **Done (2026-07-07):** group ROTATE + per-shape **rotation** — an additive
  `rotation` field on `canvas.drawing` shapes (host-owned schema, no RFC; a
  circle is rotationally symmetric so it's the one kind that omits it), applied
  as an in-plane SVG `rotate` about each shape's bbox centre (the `shapeCenter`
  pivot is exported from `DrawingPreview` so the renderer and the editor overlay
  agree). Single selection gets a rotate knob above its outline
  (`shapeRotatePatch`, knob-up = 0°); the group box (N>1) gets its own knob that
  rotates each member's position about the group centre AND adds the angle to
  each member's own rotation (`groupRotatePatch`, one undo step via
  `patchElements`). Rotated resize/vertex drags un-rotate the pointer into shape
  space first (`rotatePoint(...,-deg)`) so the handles track under rotation. Pure
  geometry (`rotatePoint`/`shapeRotatePatch`/`groupRotatePatch`) unit-tested.
  This closes the last recorded ADR 0317 follow-up — all group-transform and
  rotation enhancements are now shipped.
