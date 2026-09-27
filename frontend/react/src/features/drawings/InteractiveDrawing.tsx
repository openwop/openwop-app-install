/**
 * Direct-manipulation editor for `canvas.drawing` (ADR 0310 Phase C + the 0317
 * gizmo/multi-select follow-ups). Renders the scene via the shared safe
 * `ShapeEl` inside ONE SVG, then overlays a transparent hit layer, selection
 * outlines, resize + vertex handles, and a marquee. Gestures:
 *   - click a shape → select it; drag its body → move; drag a corner handle →
 *     resize; drag a vertex (polyline/polygon) → reshape.
 *   - drag on empty canvas → a marquee that INTERSECT-selects (design-tool
 *     default); Shift+marquee unions; Shift+click toggles one shape.
 *   - with N>1 selected, dragging any selected shape moves the whole set (one
 *     undo step via `patchElements`); "Delete N" removes them (`deleteElements`).
 * Optional snap-to-grid rounds positions. Mutation flows through the chassis
 * (one undo step per gesture); the geometry math is in `shapeGeometry.ts`.
 *
 * The interactive canvas is an ADDITIONAL affordance — the keyboard/a11y path
 * stays the element list + property panel (the hit layer is aria-hidden), and
 * the marquee + group-drag have single-pointer alternatives (click/Shift-click
 * to select each; numeric panel fields to move; Delete button) per WCAG 2.5.7.
 */
import { Button } from '../../ui/Button.js';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { announce } from '../../ui/announce.js';
import type { InteractivePreviewProps } from '../../canvas/types.js';
import { ViewportSurface } from '../../canvas/ViewportSurface.js';
import { PeerSelectionOverlays } from '../../canvas/PeerSelectionOverlay.js';
import { SelectionPill } from '../../canvas/SelectionPill.js';
import { useCanvasViewport } from '../../canvas/useCanvasViewport.js';
import { screenConstant, type ViewBounds } from '../../canvas/viewport.js';
import { ShapeEl, parseDrawing, shapeCenter } from '../../chat/artifacts/DrawingPreview.js';
import type { DrawingDoc } from './definition.js';
import {
  shapeBBox, shapeHandles, shapeMovePatch, shapeResizePatch, shapeVertices, vertexMovePatch, snapPatch,
  boxesIntersect, boxContains, unionBox, scaleShapePatch, rotatePoint, shapeRotatePatch, groupRotatePatch,
  strokeHit, rdpIndices, symmetryVariants, type Pt, type Box, type SymmetryMode,
} from './shapeGeometry.js';
import { strokeOutlinePath } from '../../chat/artifacts/strokePath.js';
import { usePointerStroke } from './usePointerStroke.js';
import { fitQuickShape, type QuickFit } from './quickShape.js';
import { recallStyle } from '../../canvas/styleMemory.js';
import { nextGroupId } from '../../canvas/elementOps.js';
import { copyPngToClipboard, downloadBlob, inlineSvgImageHrefs, svgElementToCleanString, svgStringToPngBlob } from '../../canvas/exportUtils.js';
import { toast } from '../../ui/index.js';
import { XIcon } from '../../ui/icons/index.js';
import { buildGapCandidates, buildSnapCandidates, combinedSnapDelta, snapAngle, type GapCandidates, type SnapCandidates, type SnapGuide, type SpaceSpan } from '../../canvas/snapping.js';

const KNOB = (w: number, h: number): number => Math.max(w, h) / 12; // rotate-stalk length
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const COL = 'shapes';
const SNAP_GRID = 10;
const clone = (s: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(s)) as Record<string, unknown>;

function toSvg(svg: SVGSVGElement, clientX: number, clientY: number): Pt {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

type GroupItem = { idx: number; startShape: Record<string, unknown>; ctr: Pt };
type Drag =
  | { kind: 'move' | 'resize' | 'vertex' | 'rotate'; idx: number; handleId?: string; vertexIndex?: number; ctr: Pt; rot: number; start: Pt; startShape: Record<string, unknown>; moved: boolean }
  | { kind: 'group'; items: GroupItem[]; start: Pt; moved: boolean }
  | { kind: 'groupResize'; items: GroupItem[]; origin: Pt; startVec: number; start: Pt; moved: boolean }
  | { kind: 'groupRotate'; items: GroupItem[]; center: Pt; startAngle: number; start: Pt; moved: boolean };

interface Marquee { start: Pt; cur: Pt; additive: boolean; contain: boolean }
const DRAG_THRESHOLD = (w: number, h: number): number => Math.max(w, h) / 200;

export function InteractiveDrawing({ doc, selectedIndices, onSetSelection, patchElement, patchElements, deleteElements, activeTool = 'select', addElements, cancelSignal, elementActions, peerSelections }: InteractivePreviewProps<DrawingDoc>): JSX.Element {
  const { t } = useTranslation('drawings');
  // DRU-3 — a stable id for the SR-only keyboard-path hint (the canvas describes
  // itself by it when a shape is selected). Mirrors the Cad3dView precedent.
  const resizeHintId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [snap, setSnap] = useState(false);
  const [snapTouched, setSnapTouched] = useState(false);

  const [marquee, setMarquee] = useState<Marquee | null>(null);
  // ADR 0333 Phase 3 — ink tools. The live stroke is LOCAL overlay state; the
  // commit is ONE addElements step at pen-up (the chassis owns history).
  const ink = usePointerStroke();
  const [erasing, setErasing] = useState<Set<number> | null>(null);
  const erasingRef = useRef<Set<number> | null>(null);
  const inkTool = activeTool === 'pen' || activeTool === 'highlighter';
  // ADR 0333 grade pass CODE-D5 — the stroke commits as the tool it STARTED
  // as; a mid-stroke tool switch (or Esc) must not retag a highlighter as a pen.
  const inkToolAtStart = useRef<string>('pen');
  const selectMode = activeTool === 'select';
  // ADR 0333 Phase 4 — drag-to-draw shape tools + QuickShape + inline text.
  const shapeTool = activeTool === 'rect' || activeTool === 'ellipse' || activeTool === 'line' || activeTool === 'arrow';
  const [drawShape, setDrawShape] = useState<{ start: Pt; cur: Pt; shift: boolean; alt: boolean } | null>(null);
  const drawShapeRef = useRef<typeof drawShape>(null);
  const [quickFit, setQuickFit] = useState<QuickFit | null>(null);
  const quickFitRef = useRef<QuickFit | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [textEdit, setTextEdit] = useState<{ idx: number; value: string; left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A pending QuickShape hold-timer must die with the component (Phase-4
  // /code-review) — otherwise it fires setState into an unmounted tree.
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);
  // ADR 0333 grade pass DRAW-R3 — Esc (chassis-bumped `cancelSignal`) drops
  // EVERY live overlay gesture: an in-flight drag (the chassis reverts its
  // history entry separately), a live ink stroke, an eraser sweep, a
  // drag-to-draw, a QuickShape fit. Skip the initial mount (signal 0/undefined).
  const cancelSeen = useRef(cancelSignal);
  useEffect(() => {
    if (cancelSignal === cancelSeen.current) return;
    cancelSeen.current = cancelSignal;
    drag.current = null;
    ink.cancel();
    drawShapeRef.current = null; setDrawShape(null);
    erasingRef.current = null; setErasing(null);
    quickFitRef.current = null; setQuickFit(null);
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    setMarquee(null);
    setGuides([]);
  }, [cancelSignal, ink]);
  // ADR 0333 Phase 5 — smart guides: sibling candidates built ONCE at drag
  // start (the architect-gate perf ruling); guides render while snapped.
  const snapCand = useRef<SnapCandidates | null>(null);
  // §7.4 / CV-6 — equal-spacing candidates, built alongside the align set at
  // gesture start (the moved size is constant for the gesture).
  const gapCand = useRef<GapCandidates | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [spans, setSpans] = useState<SpaceSpan[]>([]);

  const w = typeof doc.width === 'number' && doc.width > 0 ? doc.width : 400;
  const h = typeof doc.height === 'number' && doc.height > 0 ? doc.height : 300;
  const records = doc.shapes;
  // ADR 0333 grade pass CODE-D1 — memoize the safe reparse on doc identity;
  // it was re-serializing + reparsing the WHOLE doc on every render (per
  // pointermove during a drag).
  const rendered = useMemo(() => parseDrawing(JSON.stringify(doc))?.shapes ?? [], [doc]);
  const unit = Math.max(w, h) / 90;
  // ADR 0333 grade pass (deferred "screen-constant selection handles") — own the
  // viewport (CONTROLLED mode) so the selection-overlay chrome can size in SCREEN
  // space: `hz`/`stalk` divide the doc-space base by the zoom, so handles, the
  // outline, and the rotate stalk stay a CONSTANT on-screen size at any zoom
  // (Figma/tldraw parity) instead of ballooning at 8× / vanishing at 0.25×. At
  // zoom 1 (fit) `hz === unit`, so the fitted view is byte-identical. Scene +
  // committed geometry keep doc-space `unit` (a render-only divisor must never
  // reach a persisted patch/addElements payload).
  const vp = useCanvasViewport();
  const hz = screenConstant(unit, vp.zoom);
  const stalk = screenConstant(KNOB(w, h), vp.zoom);
  // `--hz` = 1/zoom, published on the svg so the overlay's CSS STROKE widths +
  // dash patterns (which `hz`, an SVG geometry value, can't reach) also render
  // screen-constant via `calc(n * var(--hz, 1))`. At zoom 1 it's 1 → identical.
  const hzFactor = screenConstant(1, vp.zoom);
  // Owning the viewport re-renders this component on every pan/zoom frame; the
  // committed scene doesn't depend on the viewport, so memoize it on doc+eraser
  // identity — a pan/zoom then only recomputes the (cheap) selection overlay,
  // not the whole shape list. (grade-pass perf, paired with the vp adoption.)
  const sceneShapes = useMemo(() => rendered.map((s, i) => (erasing?.has(i)
    ? <g key={`v${i}`} opacity={0.25}><ShapeEl s={s} /></g>
    : <ShapeEl key={`v${i}`} s={s} />)), [rendered, erasing]);
  // ADR 0333 Phase 7 — doc-level guides. The bar checkbox is the SESSION
  // override of the doc's gridSnap default; grid size/visibility are doc's.
  const gridSize = typeof doc.gridSize === 'number' && doc.gridSize >= 1 ? doc.gridSize : SNAP_GRID;
  const gridShow = doc.gridShow === true;
  const symmetry: SymmetryMode = doc.symmetry === 'vertical' || doc.symmetry === 'horizontal' || doc.symmetry === 'quadrant' || doc.symmetry === 'radial' ? doc.symmetry : 'off';
  const symRotational = doc.symmetryRotational === true;
  const effSnap = snapTouched ? snap : doc.gridSnap === true;
  // ADR 0333 grade pass CODE-D10 — the grid as one memoized path; step is
  // floored so ≥~200 lines/axis never render (a 1px grid on a 4000px board
  // would otherwise emit thousands of nodes per render).
  const gridPath = useMemo(() => {
    const step = Math.max(gridSize, w / 200, h / 200);
    const r1 = (n: number): number => Math.round(n * 10) / 10; // SVG coord, not a locale number
    let d = '';
    for (let gx = step; gx < w; gx += step) d += `M${r1(gx)} 0V${h} `;
    for (let gy = step; gy < h; gy += step) d += `M0 ${r1(gy)}H${w} `;
    return d;
  }, [w, h, gridSize]);
  // The chassis owns the multi-selection (shared with the element list), so the
  // canvas reads/writes it directly — the list and the marquee stay in sync.
  const selected = new Set(selectedIndices(COL));
  const singleIdx = selected.size === 1 ? [...selected][0]! : -1;

  // DRU-2 — the SVG is one `role="img"`, so a screen-reader user can't perceive
  // selection state. Speak each selection change through the ADR 0363 imperative
  // live region: the shape KIND for a single selection ("Rectangle selected"),
  // the COUNT for a multi-selection. `selSig` (the sorted index list) is the
  // change signal — so this fires on a real selection change but NOT on a
  // pan/zoom/move re-render, and re-announces when the selection moves to another
  // shape of the same kind. `records`/`t` are read at fire time via a ref.
  const selSig = [...selected].sort((a, b) => a - b).join(',');
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!selSig) return; // nothing selected (incl. a clear) — stay silent
    const idxs = selSig.split(',').map(Number);
    const tr = tRef.current;
    if (idxs.length === 1) {
      // Guard `typeof === 'string'` before building the key, mirroring the
      // `labelFor` precedent (definition.tsx) — never emit a raw `kind_[object]`.
      const kind = recordsRef.current[idxs[0]!]?.kind;
      const kindKey = typeof kind === 'string' ? `kind_${kind}` : 'kind_shape';
      announce(tr('shapeSelected', { kind: tr(kindKey) }));
    } else {
      announce(tr('nSelected', { count: idxs.length }));
    }
  }, [selSig]);

  const setSelection = (next: Set<number>): void => onSetSelection(COL, [...next]);

  const centerPt = (i: number): Pt => { const c = rendered[i] ? shapeCenter(rendered[i]!) : { cx: 0, cy: 0 }; return { x: c.cx, y: c.cy }; };
  const groupItem = (i: number): GroupItem => ({ idx: i, startShape: clone(records[i]!), ctr: centerPt(i) });

  /** Sibling candidate lines for smart guides — the moving set, locked, and
   *  hidden shapes never attract. */
  function armSnapGuides(movingIdxs: Set<number>): void {
    const sibs: Box[] = [];
    records.forEach((s, i) => {
      if (movingIdxs.has(i) || s.locked === true || s.hidden === true) return;
      const b = shapeBBox(s);
      if (b) sibs.push(b);
    });
    snapCand.current = sibs.length ? buildSnapCandidates(sibs) : null;
    // §7.4 / CV-6 — the equal-spacing set needs the dragged UNION's size
    // (constant for the gesture) + at least one sibling PAIR to mirror.
    const movingBoxes = [...movingIdxs].map((i) => (records[i] ? shapeBBox(records[i]!) : null)).filter((b): b is Box => b != null);
    const u = movingBoxes.length ? unionBox(movingBoxes) : null;
    gapCand.current = u && sibs.length >= 2 ? buildGapCandidates(sibs, { w: u.w, h: u.h }) : null;
  }
  function disarmSnapGuides(): void {
    snapCand.current = null;
    gapCand.current = null;
    setGuides((g) => (g.length ? [] : g));
    setSpans((s) => (s.length ? [] : s));
  }
  /** The smart-guide delta for the moving bbox (grid snap wins when the grid
   *  checkbox is on; Ctrl/⌘ bypasses — the tldraw convention). Alignment wins
   *  per axis; equal-spacing fills the axes alignment missed (§7.4 / CV-6). */
  function guideDelta(movedBox: Box | null, e: React.PointerEvent): Pt {
    if (!movedBox || (!snapCand.current && !gapCand.current) || effSnap || e.ctrlKey || e.metaKey) {
      setGuides((g) => (g.length ? [] : g));
      setSpans((s) => (s.length ? [] : s));
      return { x: 0, y: 0 };
    }
    const r = combinedSnapDelta(movedBox, snapCand.current, gapCand.current, unit * 1.2);
    setGuides(r.guides);
    setSpans(r.spans);
    return { x: r.dx, y: r.dy };
  }

  function begin(a: { kind: 'move' | 'resize' | 'vertex' | 'rotate'; idx: number; handleId?: string; vertexIndex?: number }, e: React.PointerEvent, shift: boolean): void {
    e.stopPropagation();
    const svg = svgRef.current;
    const target = records[a.idx];
    if (!svg || !target || e.button !== 0) return;
    // ADR 0333 Phase 3: locked = not draggable (the chassis seams also guard;
    // this skip keeps the cursor honest). Selection via the list stays open.
    if (target.locked === true) return;
    if (shift) {
      // Toggle this shape in/out of the set (no drag) — the additive model.
      const next = new Set(selected);
      if (next.has(a.idx)) next.delete(a.idx); else next.add(a.idx);
      setSelection(next);
      return;
    }
    if (a.kind === 'move' && selected.has(a.idx) && selected.size > 1) {
      // Pointer-down on a member of a multi-selection → move the WHOLE set,
      // preserving the selection (the #1 multi-select rule from the research).
      drag.current = { kind: 'group', items: [...selected].map(groupItem), start: toSvg(svg, e.clientX, e.clientY), moved: false };
      armSnapGuides(selected);
    } else {
      // ADR 0333 Phase 3 — a grouped shape selects its WHOLE group as a unit
      // (the marquee precedent: the type requests the set; the chassis owns it).
      const gid = typeof target.groupId === 'string' ? target.groupId : '';
      if (gid && a.kind === 'move') {
        const members = new Set<number>();
        records.forEach((s, i) => { if (s.groupId === gid) members.add(i); });
        if (members.size > 1) {
          setSelection(members);
          drag.current = { kind: 'group', items: [...members].map(groupItem), start: toSvg(svg, e.clientX, e.clientY), moved: false };
          armSnapGuides(members);
          svg.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (!(selected.size === 1 && selected.has(a.idx))) setSelection(new Set([a.idx]));
      drag.current = { ...a, ctr: centerPt(a.idx), rot: num(records[a.idx]!.rotation), start: toSvg(svg, e.clientX, e.clientY), startShape: clone(records[a.idx]!), moved: false };
      if (a.kind === 'move') armSnapGuides(new Set([a.idx]));
    }
    svg.setPointerCapture(e.pointerId);
  }

  /** Object-erase hit test at a canvas point: strokes by spine distance,
   *  everything else by bbox (cheap, honest for an object eraser). Locked and
   *  hidden shapes are never erased by gesture. */
  function eraseHits(p: Pt, into: Set<number>): void {
    records.forEach((s, i) => {
      if (s.locked === true || s.hidden === true) return;
      if (s.kind === 'stroke') {
        if (strokeHit(s, p, unit)) into.add(i);
        return;
      }
      const b = shapeBBox(s);
      if (b && p.x >= b.x - unit && p.x <= b.x + b.w + unit && p.y >= b.y - unit && p.y <= b.y + b.h + unit) into.add(i);
    });
  }

  /** Build the shape a drag-to-draw session commits (constraints applied). */
  function shapeFromDrag(d: { start: Pt; cur: Pt; shift: boolean; alt: boolean }): Record<string, unknown> | null {
    const kind = activeTool;
    if (kind === 'line' || kind === 'arrow') {
      let { x, y } = d.cur;
      if (d.shift) {
        // Snap the segment's angle to 15° increments (the vector-app grammar).
        const dx = x - d.start.x, dy = y - d.start.y;
        const len = Math.hypot(dx, dy);
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        x = d.start.x + Math.cos(ang) * len;
        y = d.start.y + Math.sin(ang) * len;
      }
      const base = { x1: Math.round(d.start.x), y1: Math.round(d.start.y), x2: Math.round(x), y2: Math.round(y), strokeWidth: 2 };
      return kind === 'arrow' ? { kind, ...base, endHead: 'arrow' } : { kind, ...base };
    }
    // rect / ellipse from the drag box; Alt = centered on the start point.
    let x0 = Math.min(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y);
    let bw = Math.abs(d.cur.x - d.start.x), bh = Math.abs(d.cur.y - d.start.y);
    if (d.shift) { bw = bh = Math.max(bw, bh); if (d.cur.x < d.start.x) x0 = d.start.x - bw; if (d.cur.y < d.start.y) y0 = d.start.y - bh; }
    if (d.alt) { x0 = d.start.x - bw; y0 = d.start.y - bh; bw *= 2; bh *= 2; }
    if (kind === 'rect') return { kind, x: Math.round(x0), y: Math.round(y0), width: Math.round(bw), height: Math.round(bh) };
    if (kind === 'ellipse') {
      if (d.shift) {
        const r = Math.round(Math.max(bw, bh) / 2);
        return { kind: 'circle', cx: Math.round(x0 + bw / 2), cy: Math.round(y0 + bh / 2), r };
      }
      return { kind, cx: Math.round(x0 + bw / 2), cy: Math.round(y0 + bh / 2), rx: Math.round(bw / 2), ry: Math.round(bh / 2) };
    }
    return null;
  }

  /** Schedule/refresh the QuickShape hold detector (~350 ms stationary). */
  function armQuickShape(): void {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    quickFitRef.current = null;
    if (quickFit) setQuickFit(null);
    holdTimer.current = setTimeout(() => {
      const s = ink.live;
      if (!s || s.points.length < 3) return;
      const fit = fitQuickShape(s.points, unit);
      if (fit) { quickFitRef.current = fit; setQuickFit(fit); }
    }, 350);
  }

  function onBackgroundDown(e: React.PointerEvent): void {
    const svg = svgRef.current;
    // Only the primary button starts a gesture (ADR 0333 grade pass CODE-D8 —
    // right-click previously started ink/marquee then captured while the
    // context menu opened, leaving a stuck half-gesture).
    if (!svg || e.button !== 0) return;
    // ADR 0333 Phase 3 — tool routing. Pen-seen fingers navigate, not ink
    // (the Procreate convention; the viewport owns two-finger gestures).
    if (inkTool) {
      if (e.pointerType === 'touch' && ink.penSeen) return;
      // A SECOND touch while touch-ink is live = a gesture, never more ink —
      // cancel the young stroke so two-finger tap-undo works (Phase 8).
      if (ink.live && e.pointerType === 'touch') {
        ink.cancel();
        if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
        return;
      }
      inkToolAtStart.current = activeTool;
      ink.begin(e, (cx, cy) => toSvg(svg, cx, cy));
      armQuickShape();
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (shapeTool) {
      const p = toSvg(svg, e.clientX, e.clientY);
      const d = { start: p, cur: p, shift: e.shiftKey, alt: e.altKey };
      drawShapeRef.current = d;
      setDrawShape(d);
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (activeTool === 'eraser') {
      const marked = new Set<number>();
      eraseHits(toSvg(svg, e.clientX, e.clientY), marked);
      erasingRef.current = marked;
      setErasing(new Set(marked));
      svg.setPointerCapture(e.pointerId);
      return;
    }
    const p = toSvg(svg, e.clientX, e.clientY);
    // Alt/Option = CONTAIN mode (only fully-enclosed shapes); default INTERSECT.
    setMarquee({ start: p, cur: p, additive: e.shiftKey, contain: e.altKey });
    svg.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent): void {
    const svg = svgRef.current;
    if (!svg) return;
    if (ink.live) {
      ink.extend(e, (cx, cy) => toSvg(svg, cx, cy));
      armQuickShape(); // moving resets the hold detector (and any live fit)
      return;
    }
    if (drawShapeRef.current) {
      const d = { ...drawShapeRef.current, cur: toSvg(svg, e.clientX, e.clientY), shift: e.shiftKey, alt: e.altKey };
      drawShapeRef.current = d;
      setDrawShape(d);
      return;
    }
    if (erasingRef.current) {
      const marked = erasingRef.current;
      const before = marked.size;
      eraseHits(toSvg(svg, e.clientX, e.clientY), marked);
      if (marked.size !== before) setErasing(new Set(marked));
      return;
    }
    const cur = toSvg(svg, e.clientX, e.clientY);
    if (marquee) { setMarquee({ ...marquee, cur }); return; }
    const d = drag.current;
    if (!d) return;
    let dx = cur.x - d.start.x, dy = cur.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD(w, h)) return;
    if (d.kind === 'group') {
      // Smart guides (ADR 0333 Phase 5): the UNION box attracts to siblings.
      const startBoxes = d.items.map((it) => shapeBBox(it.startShape)).filter((b): b is Box => b !== null);
      const u = startBoxes.length ? unionBox(startBoxes) : null;
      const gd = guideDelta(u ? { x: u.x + dx, y: u.y + dy, w: u.w, h: u.h } : null, e);
      dx += gd.x; dy += gd.y;
      const patches = d.items.map((it) => {
        let p = shapeMovePatch(it.startShape, dx, dy);
        if (effSnap) p = snapPatch(p, gridSize);
        return { idx: it.idx, patch: p };
      });
      patchElements(COL, patches, d.moved ? 'move' : 'start');
    } else if (d.kind === 'groupResize') {
      // Uniform scale of the whole set about the fixed opposite corner.
      const factor = d.startVec > 0 ? Math.hypot(cur.x - d.origin.x, cur.y - d.origin.y) / d.startVec : 1;
      const patches = d.items.map((it) => ({ idx: it.idx, patch: scaleShapePatch(it.startShape, factor, d.origin) }));
      patchElements(COL, patches, d.moved ? 'move' : 'start');
    } else if (d.kind === 'groupRotate') {
      let deg = (Math.atan2(cur.y - d.center.y, cur.x - d.center.x) - d.startAngle) * 180 / Math.PI;
      // Shift = 15° increments (ADR 0333 Phase 5, the vector-app grammar).
      if (e.shiftKey) deg = snapAngle(deg);
      const patches = d.items.map((it) => ({ idx: it.idx, patch: groupRotatePatch(it.startShape, deg, d.center, it.ctr) }));
      patchElements(COL, patches, d.moved ? 'move' : 'start');
    } else if (d.kind === 'rotate') {
      const rp = shapeRotatePatch(d.ctr.x, d.ctr.y, cur.x, cur.y);
      if (e.shiftKey && typeof rp.rotation === 'number') rp.rotation = snapAngle(rp.rotation);
      patchElement(COL, d.idx, rp, d.moved ? 'move' : 'start');
    } else {
      // Resize/vertex operate in the shape's LOCAL frame — un-rotate the pointer
      // about the shape centre so a rotated shape resizes/reshapes correctly.
      const loc = d.rot ? rotatePoint(cur.x, cur.y, d.ctr.x, d.ctr.y, -d.rot) : cur;
      if (d.kind === 'move') {
        // Smart guides on single moves (ADR 0333 Phase 5).
        const sb = shapeBBox(d.startShape);
        const gd = guideDelta(sb ? { x: sb.x + dx, y: sb.y + dy, w: sb.w, h: sb.h } : null, e);
        dx += gd.x; dy += gd.y;
      }
      let patch = d.kind === 'move' ? shapeMovePatch(d.startShape, dx, dy)
        : d.kind === 'resize' ? shapeResizePatch(d.startShape, d.handleId ?? '', loc.x, loc.y)
          : vertexMovePatch(d.startShape, d.vertexIndex ?? -1, loc.x, loc.y);
      if (effSnap) patch = snapPatch(patch, gridSize);
      if (!Object.keys(patch).length) return;
      patchElement(COL, d.idx, patch, d.moved ? 'move' : 'start');
    }
    d.moved = true;
  }

  function onPointerUp(e: React.PointerEvent): void {
    svgRef.current?.releasePointerCapture(e.pointerId);
    // ADR 0333 Phase 3 — commit the live stroke: RDP-simplify (pressure track
    // realigned by kept indices), split at the 600-point budget, ONE undo step.
    if (ink.live) {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      // ADR 0333 Phase 4 — QuickShape: a live fit commits the FITTED kind
      // instead of the raw stroke (same single addElements step). Fitted
      // shapes are stroke-drawn (fill none) in the theme's currentColor.
      const fit = quickFitRef.current;
      quickFitRef.current = null;
      setQuickFit(null);
      if (fit && addElements) {
        ink.finish();
        const penW = Math.max(1.5, Math.round(unit * 0.9 * 10) / 10);
        const paint = fit.kind === 'line'
          ? { strokeWidth: penW }
          : { fill: 'none', stroke: 'currentColor', strokeWidth: penW };
        addElements(COL, [{ ...fit, ...paint, ...recallStyle('canvas.drawing', COL, fit.kind) }]);
        return;
      }
      const s = ink.finish();
      // A single-point spine is a deliberate pen TAP — it commits as a dot
      // (strokeOutlinePath renders an 8-gon; the standard ink behavior).
      if (s && s.points.length >= 1 && addElements) {
        const keep = rdpIndices(s.points, 0.4);
        const pts = keep.map((i) => ({ x: Math.round(s.points[i]!.x * 100) / 100, y: Math.round(s.points[i]!.y * 100) / 100 }));
        const prs = s.pressures.length ? keep.map((i) => Math.round((s.pressures[i] ?? 0.5) * 100) / 100) : [];
        const committedTool = inkToolAtStart.current;
        const size = committedTool === 'highlighter' ? Math.max(4, unit * 2.5) : Math.max(1.5, unit * 0.9);
        const els: Record<string, unknown>[] = [];
        for (let o = 0; o < pts.length; o += 599) {
          // Overlap one point between chunks (ADR 0333 grade pass CODE-D7) so
          // the segment across a split boundary is drawn — "split-and-CONTINUE".
          const from = o === 0 ? 0 : o - 1;
          const chunk = pts.slice(from, o + 599);
          if (chunk.length < 1 || (chunk.length < 2 && els.length)) break;
          els.push({
            kind: 'stroke',
            points: chunk,
            ...(prs.length ? { pressures: prs.slice(from, o + 599) } : {}),
            ...(s.simulatePressure ? { simulatePressure: true } : {}),
            size,
            ...(committedTool === 'highlighter' ? { opacity: 0.35 } : {}),
          });
        }
        // ADR 0333 Phase 7 — symmetry assist: the finished spine lands with
        // its mirrored/rotated copies in the SAME addElements batch (one undo
        // step), linked by a shared groupId so they move/erase as a unit.
        if (els.length && symmetry !== 'off') {
          const gid = nextGroupId(records);
          const copies: Record<string, unknown>[] = [];
          for (const el of els) {
            const spine = el.points;
            if (!Array.isArray(spine)) continue;
            for (const variant of symmetryVariants(spine as Pt[], symmetry, w / 2, h / 2, symRotational)) {
              copies.push({ ...el, points: variant.map((pt) => ({ x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 })) });
            }
          }
          const all = [...els, ...copies].map((el) => ({ ...el, groupId: gid }));
          addElements(COL, all);
          return;
        }
        if (els.length) addElements(COL, els);
      }
      return;
    }
    if (drawShapeRef.current) {
      // ADR 0333 Phase 4 — commit the drag-drawn shape (ONE addElements step).
      // A click without a real drag places a default-size shape at the point
      // (the pointer twin of the keyboard adders).
      const d = drawShapeRef.current;
      drawShapeRef.current = null;
      setDrawShape(null);
      if (addElements) {
        const span = Math.hypot(d.cur.x - d.start.x, d.cur.y - d.start.y);
        const el = span < DRAG_THRESHOLD(w, h)
          ? defaultShapeAt(d.start)
          : shapeFromDrag(d);
        if (el) addElements(COL, [{ ...el, ...recallStyle('canvas.drawing', COL, String(el.kind)) }]);
      }
      return;
    }
    if (erasingRef.current) {
      const marked = erasingRef.current;
      erasingRef.current = null;
      setErasing(null);
      if (marked.size) deleteElements(COL, [...marked]);
      return;
    }
    if (marquee) {
      const box: Box = { x: Math.min(marquee.start.x, marquee.cur.x), y: Math.min(marquee.start.y, marquee.cur.y), w: Math.abs(marquee.cur.x - marquee.start.x), h: Math.abs(marquee.cur.y - marquee.start.y) };
      if (box.w < DRAG_THRESHOLD(w, h) && box.h < DRAG_THRESHOLD(w, h)) {
        // A click on empty canvas (no real marquee) → clear (unless additive).
        if (!marquee.additive) setSelection(new Set());
      } else {
        const hit = new Set<number>(marquee.additive ? selected : []);
        const inMarquee = marquee.contain ? (b: Box): boolean => boxContains(box, b) : (b: Box): boolean => boxesIntersect(box, b);
        records.forEach((s, i) => { const b = shapeBBox(s); if (b && inMarquee(b)) hit.add(i); });
        setSelection(hit);
      }
      setMarquee(null);
      return;
    }
    const d = drag.current;
    if (d?.moved) (d.kind === 'group' || d.kind === 'groupResize' || d.kind === 'groupRotate' ? patchElements(COL, [], 'end') : patchElement(COL, d.idx, {}, 'end'));
    drag.current = null;
    disarmSnapGuides();
  }

  // ---- export (ADR 0333 Phase 8) — the scene svg is serialized as a
  // stripped CLONE (one render path; classed editor chrome removed).
  const [exporting, setExporting] = useState(false);
  async function exportScene(kind: 'svg' | 'png' | 'copy'): Promise<void> {
    const svg = svgRef.current;
    if (!svg || exporting) return;
    setExporting(true);
    try {
    // ADR 0401 follow-through — placed `image` shapes must inline as data URIs:
    // SVG-as-image rasterization forbids resource loads (a PNG export would
    // silently drop them), and an exported .svg should be self-contained.
    const { text, unresolved } = await inlineSvgImageHrefs(svgElementToCleanString(svg));
    const name = (typeof doc.title === 'string' && doc.title ? doc.title : 'drawing').replace(/[^\w.-]+/g, '-');
    // DRAW-G3 — an image that could not be inlined is MISSING from the file the
    // user is about to receive (blank in a PNG, a dangling host path in an SVG).
    // The export still happens — degrading beats failing — but it says so.
    if (unresolved) toast.warning(t('exportMissingImages', { count: unresolved }));
    if (kind === 'svg') {
      downloadBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), `${name}.svg`);
      return;
    }
    const png = await svgStringToPngBlob(text, w, h);
    if (!png) { toast.error(t('exportFailed')); return; }
    if (kind === 'png') downloadBlob(png, `${name}.png`);
    // DRAW-G2 — the PNG was produced; it is the CLIPBOARD that refused (a denied
    // permission, an insecure context). "Export failed" sends the user back to
    // re-export something that worked. The sync modal already keeps these apart.
    else if (await copyPngToClipboard(png)) toast.info(t('copiedPng'));
    else toast.error(t('copyFailed'));
    } finally { setExporting(false); }
  }

  /** A click-placed default-size shape (the drag-less fallback). */
  function defaultShapeAt(p: Pt): Record<string, unknown> | null {
    const cx = Math.round(p.x), cy = Math.round(p.y);
    const uw = Math.round(unit * 14), uh = Math.round(unit * 9);
    switch (activeTool) {
      case 'rect': return { kind: 'rect', x: cx - Math.round(uw / 2), y: cy - Math.round(uh / 2), width: uw, height: uh };
      case 'ellipse': return { kind: 'ellipse', cx, cy, rx: Math.round(uw / 2), ry: Math.round(uh / 2) };
      case 'line': return { kind: 'line', x1: cx - uw, y1: cy, x2: cx + uw, y2: cy, strokeWidth: 2 };
      case 'arrow': return { kind: 'arrow', x1: cx - uw, y1: cy, x2: cx + uw, y2: cy, strokeWidth: 2, endHead: 'arrow' };
      default: return null;
    }
  }

  /** pointercancel = the system took the gesture (palm rejection, scroll):
   *  DISCARD — never commit ink, never delete the eraser's marks. Regular
   *  drags fall through to the shared end path (their phases already landed). */
  function onPointerAbort(e: React.PointerEvent): void {
    if (ink.live) {
      svgRef.current?.releasePointerCapture(e.pointerId);
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      quickFitRef.current = null;
      setQuickFit(null);
      ink.cancel();
      return;
    }
    if (drawShapeRef.current) {
      svgRef.current?.releasePointerCapture(e.pointerId);
      drawShapeRef.current = null;
      setDrawShape(null);
      return;
    }
    if (erasingRef.current) {
      svgRef.current?.releasePointerCapture(e.pointerId);
      erasingRef.current = null;
      setErasing(null);
      return;
    }
    onPointerUp(e);
  }

  function beginGroupResize(origin: Pt, e: React.PointerEvent): void {
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const start = toSvg(svg, e.clientX, e.clientY);
    drag.current = { kind: 'groupResize', items: [...selected].map(groupItem), origin, startVec: Math.hypot(start.x - origin.x, start.y - origin.y), start, moved: false };
    svg.setPointerCapture(e.pointerId);
  }

  function beginGroupRotate(center: Pt, e: React.PointerEvent): void {
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const start = toSvg(svg, e.clientX, e.clientY);
    drag.current = { kind: 'groupRotate', items: [...selected].map(groupItem), center, startAngle: Math.atan2(start.y - center.y, start.x - center.x), start, moved: false };
    svg.setPointerCapture(e.pointerId);
  }

  function removeSelected(): void {
    const n = deleteElements(COL, [...selected]);
    if (n > 0) setSelection(new Set());
  }

  // ---- inline text editing (ADR 0333 Phase 4) -----------------------------
  function openTextEditor(i: number): void {
    const svg = svgRef.current, root = rootRef.current, s = records[i];
    if (!svg || !root || !s || s.kind !== 'text' || s.locked === true) return;
    // Anchor at the shape's client rect (jsdom lacks CTM — fallback corner).
    let left = 12, top = 12, width = 180;
    if (typeof svg.getScreenCTM === 'function' && typeof svg.createSVGPoint === 'function') {
      const ctm = svg.getScreenCTM();
      const b = shapeBBox(s);
      if (ctm && b) {
        const pt = svg.createSVGPoint();
        pt.x = b.x; pt.y = b.y;
        const p1 = pt.matrixTransform(ctm);
        pt.x = b.x + Math.max(b.w, 40); pt.y = b.y + b.h;
        const p2 = pt.matrixTransform(ctm);
        const rootRect = root.getBoundingClientRect();
        left = p1.x - rootRect.left;
        top = p1.y - rootRect.top;
        width = Math.max(120, p2.x - p1.x);
      }
    }
    setTextEdit({ idx: i, value: typeof s.text === 'string' ? s.text : '', left, top, width });
  }
  function commitTextEdit(): void {
    if (!textEdit) return;
    patchElement(COL, textEdit.idx, { text: textEdit.value }, 'start');
    patchElement(COL, textEdit.idx, {}, 'end');
    setTextEdit(null);
  }

  /** Ghost paint for live previews — stroke-drawn in the theme color; the
   *  COMMITTED shape carries its own paint. Round-trips through parseDrawing
   *  so the ghost reaches ShapeEl as a render-safe typed Shape (no casts). */
  function ghostShape(el: Record<string, unknown>): ReturnType<typeof parseDrawing> {
    const painted = el.kind === 'line' || el.kind === 'arrow' ? el : { ...el, fill: 'none', stroke: 'currentColor' };
    return parseDrawing(JSON.stringify({ shapes: [painted] }));
  }

  const selBoxes: Box[] = [...selected].map((i) => records[i] ? shapeBBox(records[i]!) : null).filter((b): b is Box => b !== null);
  const groupBox = selected.size > 1 ? unionBox(selBoxes) : null;
  // Resize + vertex handles only for a SINGLE selection. The single-selection
  // overlay rotates with the shape (about its centre), so handles track it.
  const singleShape = singleIdx >= 0 ? records[singleIdx] : undefined;
  const selHandles = singleShape ? shapeHandles(singleShape) : [];
  const selVertices = singleShape ? shapeVertices(singleShape) : null;
  const singleBox = singleShape ? shapeBBox(singleShape) : null;
  const singleCtr = singleIdx >= 0 && rendered[singleIdx] ? shapeCenter(rendered[singleIdx]!) : null;
  const singleRot = singleShape ? num(singleShape.rotation) : 0;
  const groupCtr = groupBox ? { x: groupBox.x + groupBox.w / 2, y: groupBox.y + groupBox.h / 2 } : null;

  // §7.4 / CV-7 — the pill anchor reads getScreenCTM(), which only reflects a
  // pan/zoom AFTER React commits the stage transform; computing it inline
  // during render left the pill one transform behind (stale by exactly the
  // pan delta — the CT-CV-1 live finding). A layout effect re-reads the CTM
  // post-commit (no dep array — the anchor depends on committed layout, not
  // just state) and writes STRAIGHT to the wrapper's style: no state, so the
  // every-commit firing can never re-render (a setState here, even a bailing
  // one, loops to React's nested-update limit — the CT-CV-1 CAD crash).
  const pillPosRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = pillPosRef.current;
    if (!el) return;
    const svg = svgRef.current, root = rootRef.current;
    const box = groupBox ?? (singleIdx >= 0 && records[singleIdx] ? shapeBBox(records[singleIdx]!) : null);
    const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    if (!svg || !root || !box || !ctm) { el.style.visibility = 'hidden'; return; }
    const pt = svg.createSVGPoint();
    pt.x = box.x + box.w / 2; pt.y = box.y;
    const sp = pt.matrixTransform(ctm);
    const wr = root.getBoundingClientRect();
    // Clamp INCLUDING the pill's own extent (translateX(-50%) overhangs ~half
    // its width) so it never pokes past the root and toggles the center
    // column's scroll overflow.
    el.style.left = `${Math.max(80, Math.min(sp.x - wr.left, wr.width - 80))}px`;
    el.style.top = `${Math.max(8, Math.min(sp.y - wr.top - 44, wr.height - 44))}px`;
    el.style.visibility = 'visible';
  });

  // ADR 0333 grade pass UX-D11 — pristine = the untouched single seed shape;
  // dismissal PERSISTS (localStorage) so a legitimate one-shape doc doesn't
  // re-show the hint on every mount forever.
  const pristine = records.length <= 1;
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return localStorage.getItem('owp-draw-hint-dismissed') === '1'; } catch { return false; }
  });
  const dismissHint = (): void => {
    setHintDismissed(true);
    try { localStorage.setItem('owp-draw-hint-dismissed', '1'); } catch { /* private mode */ }
  };

  return (
    <div className="cv-draw-interactive" ref={rootRef}>
      {/* DRU-3 — the SINGLE-selection resize/rotate/vertex handles are
          pointer-only, but the per-shape properties panel IS their keyboard
          equivalent; name that path for AT (kind-agnostic — the fields differ by
          shape). Referenced by the canvas only when a single shape is selected.
          SR-only; live SR verification is CT-DRU-3. NOTE: multi-select GROUP
          resize/rotate has no numeric-panel equivalent and stays an open gap. */}
      <span id={resizeHintId} className="sr-only">{t('resizeHint')}</span>
      {/* First-mark onboarding (ADR 0333 Phase 8; the WelcomeScreen idea,
          type-local until a second consumer wants the chassis slot). */}
      {pristine && !hintDismissed ? (
        <div className="cv-draw-interactive__hint" role="note">
          <span>{t('onboardingHint')}</span>
          <Button variant="quiet" size="sm" onClick={dismissHint} aria-label={t('dismissHint')} title={t('dismissHint')}><XIcon size={13} /></Button>
        </div>
      ) : null}
      <div className="cv-draw-interactive__bar">
        {selected.size > 1 ? (
          <span className="cv-draw-interactive__count">
            {t('nSelected', { count: selected.size })}
            <Button variant="quiet" size="sm" onClick={removeSelected}>{t('deleteSelected')}</Button>
          </span>
        ) : null}
        <span className="cv-draw-interactive__export">
          <Button variant="quiet" size="sm" disabled={exporting} onClick={() => void exportScene('svg')}>{t('exportSvg')}</Button>
          <Button variant="quiet" size="sm" disabled={exporting} aria-busy={exporting} onClick={() => void exportScene('png')}>{t('exportPng')}</Button>
          <Button variant="quiet" size="sm" disabled={exporting} aria-busy={exporting} onClick={() => void exportScene('copy')}>{t('copyPng')}</Button>
        </span>
        <label className="cv-draw-interactive__snap">
          <input type="checkbox" checked={snapTouched ? snap : doc.gridSnap === true} onChange={(e) => { setSnapTouched(true); setSnap(e.target.checked); }} />
          {t('snapToGrid')}
        </label>
      </div>
      {/* ADR 0333 Phase 1: the scene pans/zooms inside the shared viewport;
          the bar above stays outside the transform so it never scales. Pointer
          math is unaffected — `toSvg` reads the rendered screen CTM. Phase 2:
          zoom-to-selection frames the selection's CLIENT-space bounds. */}
      <ViewportSurface vp={vp} selectionBounds={() => {
        const svg = svgRef.current;
        const b = groupBox ?? singleBox;
        // Capability guard: jsdom implements neither getScreenCTM nor
        // createSVGPoint (the pure viewport suite proves the math instead).
        if (!svg || !b || typeof svg.getScreenCTM !== 'function' || typeof svg.createSVGPoint !== 'function') return null;
        const ctm = svg.getScreenCTM();
        if (!ctm) return null;
        const pt = svg.createSVGPoint();
        pt.x = b.x; pt.y = b.y;
        const p1 = pt.matrixTransform(ctm);
        pt.x = b.x + b.w; pt.y = b.y + b.h;
        const p2 = pt.matrixTransform(ctm);
        const bounds: ViewBounds = {
          minX: Math.min(p1.x, p2.x), minY: Math.min(p1.y, p2.y),
          maxX: Math.max(p1.x, p2.x), maxY: Math.max(p1.y, p2.y),
        };
        return bounds;
      }}>
      <svg
        ref={svgRef}
        className={`cv-draw-interactive__svg${inkTool ? ' is-ink' : activeTool === 'eraser' ? ' is-eraser' : shapeTool ? ' is-draw' : ''}`}
        style={{ '--hz': String(hzFactor) } as CSSProperties}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t('interactiveLabel')}
        // DRU-3 — when a single shape is selected the pointer-only resize/rotate/
        // vertex handles render; point AT users to the keyboard-equivalent path.
        aria-describedby={singleIdx >= 0 ? resizeHintId : undefined}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerAbort}
      >
        {(gridShow || effSnap) && gridPath ? (
          // ADR 0333 grade pass CODE-D10 — ONE memoized `<path>` of repeated
          // M/L segments, not up to ~8000 `<line>` nodes rebuilt every render
          // (gridSize can legally be 1 on a 4000px artboard). Density capped so
          // a tiny grid on a huge artboard can't emit a million segments.
          <path aria-hidden className="cv-draw-interactive__grid" d={gridPath} />
        ) : null}
        {/* Symmetry axes (ADR 0333 Phase 7) — visible whenever the assist is on. */}
        {symmetry !== 'off' ? (
          <g aria-hidden className="cv-draw-interactive__sym-axis">
            {symmetry !== 'horizontal' ? <line x1={w / 2} y1={0} x2={w / 2} y2={h} /> : null}
            {symmetry !== 'vertical' ? <line x1={0} y1={h / 2} x2={w} y2={h / 2} /> : null}
            {symmetry === 'radial' ? (<>
              <line x1={0} y1={0} x2={w} y2={h} />
              <line x1={w} y1={0} x2={0} y2={h} />
            </>) : null}
          </g>
        ) : null}

        {/* Eraser-marked shapes dim while the gesture is live (delete lands as
            ONE step at pointer-up). Memoized on doc+eraser identity so pan/zoom
            never rebuilds it. */}
        {sceneShapes}

        {/* ADR 0359 residuals — peers' selections in the scene (dashed hue
            outline + name flag; the rail markers carry the AT path). */}
        <PeerSelectionOverlays flagScale={hzFactor} outlines={(peerSelections?.(COL) ?? []).flatMap((p) => {
          const s = doc.shapes[p.idx];
          if (!s || s.hidden === true) return [];
          const b = shapeBBox(s);
          if (!b) return [];
          const rot = num(s.rotation);
          // Pivot on shapeCenter (via the PARSED shape, like the local chrome
          // at the selection overlay) — bbox-center coincides for every kind
          // EXCEPT text, whose renderer rotates about (x, y) (code #4).
          const rs = rendered[p.idx];
          const c = rs ? shapeCenter(rs) : { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
          return [{
            x: b.x, y: b.y, w: b.w, h: b.h, name: p.name, color: p.color,
            ...(rot ? { transform: `rotate(${rot} ${c.cx} ${c.cy})` } : {}),
          }];
        })} />

        {/* Live drag-to-draw preview (ADR 0333 Phase 4) — the same safe
            renderer draws the ghost. */}
        {drawShape ? (() => {
          const el = shapeFromDrag(drawShape);
          const g = el ? ghostShape(el)?.shapes[0] : undefined;
          return g ? <g aria-hidden className="cv-draw-interactive__ghost"><ShapeEl s={g} /></g> : null;
        })() : null}

        {/* QuickShape (ADR 0333 Phase 4): a live fit REPLACES the raw ink
            preview — lift to commit the fitted shape. */}
        {quickFit ? (() => {
          const g = ghostShape({ ...quickFit })?.shapes[0];
          return g ? <g aria-hidden className="cv-draw-interactive__ghost"><ShapeEl s={g} /></g> : null;
        })() : null}

        {/* The live ink overlay (ADR 0333 Phase 3) — transient, local, never in
            history until the pen lifts. */}
        {ink.live && ink.live.points.length > 0 && !quickFit && symmetry !== 'off' ? (
          symmetryVariants(ink.live.points, symmetry, w / 2, h / 2, symRotational).map((variant, vi) => (
            <path
              key={`sym${vi}`}
              aria-hidden
              className="cv-draw-interactive__live"
              {...(activeTool === 'highlighter' ? { opacity: 0.35 } : {})}
              d={strokeOutlinePath(variant, ink.live!.pressures.length ? ink.live!.pressures : undefined, {
                size: activeTool === 'highlighter' ? Math.max(4, unit * 2.5) : Math.max(1.5, unit * 0.9),
                simulatePressure: ink.live!.simulatePressure,
              })}
            />
          ))
        ) : null}
        {ink.live && ink.live.points.length > 0 && !quickFit ? (
          <path
            aria-hidden
            className="cv-draw-interactive__live"
            {...(activeTool === 'highlighter' ? { opacity: 0.35 } : {})}
            d={strokeOutlinePath(ink.live.points, ink.live.pressures.length ? ink.live.pressures : undefined, {
              size: activeTool === 'highlighter' ? Math.max(4, unit * 2.5) : Math.max(1.5, unit * 0.9),
              simulatePressure: ink.live.simulatePressure,
            })}
          />
        ) : null}

        {/* The hit layer is a SELECT-tool affordance — ink/eraser gestures use
            the background handlers; locked/hidden shapes take no pointer. */}
        {activeTool === 'select' ? records.map((s, i) => {
          if (s.locked === true || s.hidden === true) return null;
          const b = shapeBBox(s);
          if (!b) return null;
          const pad = unit * 1.5;
          const rot = num(s.rotation), c = rendered[i] ? shapeCenter(rendered[i]!) : { cx: 0, cy: 0 };
          return (
            <rect
              key={`h${i}`}
              className="cv-draw-interactive__hit"
              x={b.x - pad} y={b.y - pad} width={b.w + 2 * pad} height={b.h + 2 * pad}
              {...(rot ? { transform: `rotate(${rot} ${c.cx} ${c.cy})` } : {})}
              onPointerDown={(e) => begin({ kind: 'move', idx: i }, e, e.shiftKey)}
              {...(s.kind === 'text' ? { onDoubleClick: () => openTextEditor(i) } : {})}
              aria-hidden
            />
          );
        }) : null}

        {/* Per-shape selection halos for the members of a MULTI-selection. */}
        {selectMode && selected.size > 1 ? selBoxes.map((b, k) => {
          const ox = b.x - hz, oy = b.y - hz, ow = b.w + 2 * hz, oh = b.h + 2 * hz;
          return (
            <g key={`sel${k}`} aria-hidden>
              <rect className="cv-draw-interactive__outline" x={ox} y={oy} width={ow} height={oh} />
              <rect className="cv-draw-interactive__outline-top" x={ox} y={oy} width={ow} height={oh} />
            </g>
          );
        }) : null}

        {/* A group bounding box + corner resize handles when N>1 — dragging a
            corner uniformly scales the set about the OPPOSITE corner. */}
        {selectMode && groupBox ? (() => {
          const gx = groupBox.x - hz * 1.5, gy = groupBox.y - hz * 1.5, gw = groupBox.w + 3 * hz, gh = groupBox.h + 3 * hz;
          const corners: { at: Pt; origin: Pt }[] = [
            { at: { x: gx, y: gy }, origin: { x: gx + gw, y: gy + gh } },
            { at: { x: gx + gw, y: gy }, origin: { x: gx, y: gy + gh } },
            { at: { x: gx + gw, y: gy + gh }, origin: { x: gx, y: gy } },
            { at: { x: gx, y: gy + gh }, origin: { x: gx + gw, y: gy } },
          ];
          return (
            <g aria-hidden>
              <rect className="cv-draw-interactive__group" x={gx} y={gy} width={gw} height={gh} />
              {corners.map((c, ci) => (
                <g key={ci}>
                  <rect className="cv-draw-interactive__handle-hit" x={c.at.x - hz * 2.2} y={c.at.y - hz * 2.2} width={hz * 4.4} height={hz * 4.4} onPointerDown={(e) => beginGroupResize(c.origin, e)} />
                  <rect className="cv-draw-interactive__handle" x={c.at.x - hz} y={c.at.y - hz} width={hz * 2} height={hz * 2} />
                </g>
              ))}
              {/* Group rotate knob above the box (rotates the whole set). */}
              {groupCtr ? (<>
                <line className="cv-draw-interactive__rotate-stalk" x1={gx + gw / 2} y1={gy} x2={gx + gw / 2} y2={gy - stalk} />
                <circle className="cv-draw-interactive__handle-hit" cx={gx + gw / 2} cy={gy - stalk} r={hz * 2.2} onPointerDown={(e) => beginGroupRotate(groupCtr, e)} />
                <circle className="cv-draw-interactive__rotate-knob" cx={gx + gw / 2} cy={gy - stalk} r={hz} />
              </>) : null}
            </g>
          );
        })() : null}

        {/* Single-selection overlay — outline + handles + rotate knob, wrapped in
            the shape's own rotation so everything tracks it. */}
        {selectMode && singleBox && singleCtr ? (() => {
          const ox = singleBox.x - hz, oy = singleBox.y - hz, ow = singleBox.w + 2 * hz, oh = singleBox.h + 2 * hz;
          return (
            <g aria-hidden transform={singleRot ? `rotate(${singleRot} ${singleCtr.cx} ${singleCtr.cy})` : undefined}>
              <rect className="cv-draw-interactive__outline" x={ox} y={oy} width={ow} height={oh} />
              <rect className="cv-draw-interactive__outline-top" x={ox} y={oy} width={ow} height={oh} />
              {/* Rotate knob (single shape). */}
              <line className="cv-draw-interactive__rotate-stalk" x1={singleCtr.cx} y1={oy} x2={singleCtr.cx} y2={oy - stalk} />
              <circle className="cv-draw-interactive__handle-hit" cx={singleCtr.cx} cy={oy - stalk} r={hz * 2.2} onPointerDown={(e) => begin({ kind: 'rotate', idx: singleIdx }, e, false)} />
              <circle className="cv-draw-interactive__rotate-knob" cx={singleCtr.cx} cy={oy - stalk} r={hz} />
              {selHandles.map((hnd) => (
                <g key={hnd.id}>
                  <rect className="cv-draw-interactive__handle-hit" x={hnd.x - hz * 2.2} y={hnd.y - hz * 2.2} width={hz * 4.4} height={hz * 4.4} onPointerDown={(e) => begin({ kind: 'resize', idx: singleIdx, handleId: hnd.id }, e, false)} />
                  <rect className="cv-draw-interactive__handle" x={hnd.x - hz} y={hnd.y - hz} width={hz * 2} height={hz * 2} />
                </g>
              ))}
              {selVertices ? selVertices.map((v, vi) => (
                <g key={`vtx${vi}`}>
                  <circle className="cv-draw-interactive__handle-hit" cx={v.x} cy={v.y} r={hz * 2.2} onPointerDown={(e) => begin({ kind: 'vertex', idx: singleIdx, vertexIndex: vi }, e, false)} />
                  <circle className="cv-draw-interactive__vertex" cx={v.x} cy={v.y} r={hz} />
                </g>
              )) : null}
            </g>
          );
        })() : null}

        {/* Smart-guide lines while a move drag is snapped (ADR 0333 Phase 5). */}
        {guides.map((g, gi) => (
          g.axis === 'v'
            ? <line key={`g${gi}`} className="cv-draw-interactive__snap-guide" x1={g.pos} y1={0} x2={g.pos} y2={h} aria-hidden />
            : <line key={`g${gi}`} className="cv-draw-interactive__snap-guide" x1={0} y1={g.pos} x2={w} y2={g.pos} aria-hidden />
        ))}
        {/* §7.4 / CV-6 — equal-spacing segments + mono badges while a gap
            snap holds (`--guide-space`; screen-constant via --hz). */}
        {spans.map((s, si) => {
          const cx = (s.from + s.to) / 2;
          return s.dir === 'x' ? (
            <g key={`sp${si}`} aria-hidden>
              <line className="cv-draw-interactive__space-span" x1={s.from} y1={s.at} x2={s.to} y2={s.at} />
              <text className="cv-draw-interactive__space-badge" x={cx} y={s.at - hz * 1.2} textAnchor="middle" fontSize={hz * 3.2}>{Math.round(s.gap)}</text>
            </g>
          ) : (
            <g key={`sp${si}`} aria-hidden>
              <line className="cv-draw-interactive__space-span" x1={s.at} y1={s.from} x2={s.at} y2={s.to} />
              <text className="cv-draw-interactive__space-badge" x={s.at + hz * 1.2} y={cx} dominantBaseline="middle" fontSize={hz * 3.2}>{Math.round(s.gap)}</text>
            </g>
          );
        })}

        {/* The marquee rectangle while drag-selecting — solid = contain (Alt),
            dashed = intersect (the AutoCAD colour/line cue, adapted). */}
        {marquee ? (
          <rect
            className={`cv-draw-interactive__marquee${marquee.contain ? ' cv-draw-interactive__marquee--contain' : ''}`}
            x={Math.min(marquee.start.x, marquee.cur.x)} y={Math.min(marquee.start.y, marquee.cur.y)}
            width={Math.abs(marquee.cur.x - marquee.start.x)} height={Math.abs(marquee.cur.y - marquee.start.y)}
            aria-hidden
          />
        ) : null}
      </svg>
      </ViewportSurface>
      {/* §7.4 / CV-7 — the near-selection pill — a rootRef SIBLING of the
          viewport (its left/top are SCREEN-space via getScreenCTM, which already
          includes pan/zoom; nesting it in the transformed stage would apply the
          transform twice — the grade-pass HIGH-1). The anchor comes from the
          post-commit layout effect above, never a render-time CTM read. */}
      {elementActions && (groupBox || singleIdx >= 0) ? (
        <div ref={pillPosRef} className="cv-selection-pill-anchor">
          <SelectionPill actions={elementActions} className="u-static" />
        </div>
      ) : null}
      {/* Inline text editor (ADR 0333 Phase 4) — a positioned textarea, not a
          dialog. Escape cancels (component-local; the chassis registry skips
          text contexts); blur / ⌘Enter commits as ONE history step. Inline
          left/top/width are geometry, not styling. */}
      {textEdit ? (
        <textarea
          className="cv-draw-interactive__text-edit"
          style={{ left: textEdit.left, top: textEdit.top, width: textEdit.width }}
          value={textEdit.value}
          autoFocus
          aria-label={t('editTextLabel')}
          onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          onBlur={commitTextEdit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setTextEdit(null);
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitTextEdit();
          }}
        />
      ) : null}
    </div>
  );
}
