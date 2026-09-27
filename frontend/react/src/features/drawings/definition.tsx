/**
 * The drawings CanvasTypeDefinition (ADR 0310 Phase C) — an ELEMENTS-trait
 * consumer: a `canvas.drawing` document is one flat `shapes` collection with a
 * closed kind set. The editor is properties-driven day-1 (select a shape from
 * the list, edit its numeric geometry/paint); a direct-manipulation SVG canvas
 * is the recorded type-specific follow-up (research doc §5.5). The ONE scene
 * renderer (`DrawingContentView`, the chat card's renderer) is mounted by the
 * editor preview. The working copy is a pure mirror of the artifact schema —
 * elements are positional, no identity fields.
 */
import type { CanvasEditorDefinition } from '../../canvas/CanvasEditorPage.js';
import type { CanvasNode, CanvasPropDef, PropertyWidgetProps } from '../../canvas/types.js';
import type { FrameBase } from '../../canvas/frameOps.js';
import { DrawingContentView } from '../../chat/artifacts/DrawingPreview.js';
import { InteractiveDrawing } from './InteractiveDrawing.js';
import { shapeBBox, shapeMovePatch } from './shapeGeometry.js';
import { ArrowUpRightIcon, CircleIcon, EraserIcon, HighlighterIcon, PencilIcon, SlashIcon, SquareIcon } from '../../ui/icons/index.js';
import { MediaRefWidget } from '../media/MediaRefWidget.js';

export interface DrawingDoc {
  title: string;
  width?: number;
  height?: number;
  shapes: Record<string, unknown>[];
  // ADR 0333 Phase 7 — doc-level guides (flat; edited via docPropDefs).
  gridSize?: number;
  gridShow?: boolean;
  gridSnap?: boolean;
  symmetry?: string;
  symmetryRotational?: boolean;
}

/** Narrow the canvas state into the editable drawing (safe fallbacks; a
 *  drawing always has at least one shape — the schema's minItems). */
export function coerceDrawing(state: Record<string, unknown>): DrawingDoc {
  const shapes = Array.isArray(state.shapes)
    ? state.shapes.filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object' && !Array.isArray(s))
    : [];
  return {
    title: typeof state.title === 'string' ? state.title : 'Untitled drawing',
    ...(typeof state.width === 'number' ? { width: state.width } : {}),
    ...(typeof state.height === 'number' ? { height: state.height } : {}),
    shapes: shapes.length ? shapes : [{ kind: 'rect', x: 20, y: 20, width: 120, height: 80 }],
    // ADR 0333 Phase 7 — guide fields ride the working copy (coerce builds a
    // NEW object; dropping them here would silently strip them on save).
    ...(typeof state.gridSize === 'number' ? { gridSize: state.gridSize } : {}),
    ...(typeof state.gridShow === 'boolean' ? { gridShow: state.gridShow } : {}),
    ...(typeof state.gridSnap === 'boolean' ? { gridSnap: state.gridSnap } : {}),
    ...(typeof state.symmetry === 'string' ? { symmetry: state.symmetry } : {}),
    ...(typeof state.symmetryRotational === 'boolean' ? { symmetryRotational: state.symmetryRotational } : {}),
  };
}

/** "x,y" per line ⇄ the schema's `points` array (≤600; server-validated). */
function PointListWidget({ id, value, onChangeText }: PropertyWidgetProps): JSX.Element {
  const pts = Array.isArray(value)
    ? value.filter((p): p is { x: number; y: number } => Boolean(p) && typeof p === 'object' && typeof (p as { x?: unknown }).x === 'number' && typeof (p as { y?: unknown }).y === 'number')
    : [];
  return (
    <textarea
      id={id}
      className="cv-editor__input cv-editor__textarea"
      value={pts.map((p) => `${p.x},${p.y}`).join('\n')}
      onChange={(e) => {
        const next = e.target.value.split('\n')
          .map((line) => line.split(',').map((v) => Number(v.trim())))
          .filter((nums) => nums.length === 2 && nums.every((v) => Number.isFinite(v)))
          .map(([x, y]) => ({ x, y }));
        onChangeText(next.length ? next : undefined);
      }}
    />
  );
}

// DRAW-R4/DATA-D9 — client-side element-field bounds MIRRORING the backend
// authority `NUM_FIELDS` / `STR_FIELDS` in
// backend/typescript/src/features/drawings/validateDrawingDoc.ts. Keep in
// lockstep: a backend bound change must update these (the app's dual-mirror
// convention, here spanning the FE/BE package boundary) — drawingBounds.test.ts
// pins the values. `step` is FE presentation only (no backend counterpart).
// NOTE: `width`/`height` here are ELEMENT fields (min 0); the DOC dims (canvas
// width/height ∈ [1,4000]) are bounded explicitly in docPropDefs below.
export const NUM_BOUNDS: Record<string, { min?: number; max?: number; step?: number }> = {
  x: {}, y: {}, cx: {}, cy: {}, x1: {}, y1: {}, x2: {}, y2: {},
  width: { min: 0 }, height: { min: 0 }, rx: { min: 0 }, ry: { min: 0 }, r: { min: 0 },
  fontSize: { min: 1, max: 400 }, strokeWidth: { min: 0, max: 100 }, opacity: { min: 0, max: 1, step: 0.05 },
  rotation: {},
  size: { min: 0.5, max: 100, step: 0.5 }, taperStart: { min: 0, max: 4000 }, taperEnd: { min: 0, max: 4000 },
};
export const STR_BOUNDS: Record<string, number> = { text: 400, fill: 40, stroke: 40, color: 40, name: 80, groupId: 40 };

const num = (name: string, label: string): CanvasPropDef => ({ name, type: 'number', label, ...NUM_BOUNDS[name] });
const str = (name: string, label: string): CanvasPropDef => ({ name, type: 'string', label, ...(STR_BOUNDS[name] !== undefined ? { maxLength: STR_BOUNDS[name] } : {}) });
// ADR 0333 Phase 6: paint fields use the shared color built-in (ColorField).
const color = (name: string, label: string): CanvasPropDef => ({ name, type: 'color', label });
// ADR 0362 v2 — fill/stroke/strokeWidth ride the bar's quick cluster (3-cap).
const PAINT: CanvasPropDef[] = [{ ...color('fill', 'Fill'), quick: true }, { ...color('stroke', 'Stroke'), quick: true }, { ...num('strokeWidth', 'Stroke width'), quick: true }, num('opacity', 'Opacity (0–1)')];
// ADR 0317 follow-up: in-plane rotation. A circle is rotationally symmetric, so
// it's the one kind that omits it.
const ROT: CanvasPropDef = num('rotation', 'Rotation (°)');

/** Per-kind fields — mirrors exactly what `ShapeEl` renders. `kind` itself is
 *  fixed at add time (the adders); changing a rect into a circle is a delete+add. */
function shapePropDefs(el: Record<string, unknown>): CanvasPropDef[] {
  switch (el.kind) {
    case 'stroke':
      // ADR 0333 Phase 3 — ink: the spine is drawn, not typed; the panel edits
      // its paint + base width (color empty = the theme's currentColor).
      return [num('size', 'Size'), color('color', 'Color'), num('opacity', 'Opacity (0–1)'), ROT];
    case 'rect':
      return [num('x', 'X'), num('y', 'Y'), num('width', 'Width'), num('height', 'Height'), { ...num('rx', 'Corner radius'), labelKey: 'prop_cornerRadius' }, ROT, ...PAINT];
    case 'circle':
      return [num('cx', 'Center X'), num('cy', 'Center Y'), num('r', 'Radius'), ...PAINT];
    case 'ellipse':
      return [num('cx', 'Center X'), num('cy', 'Center Y'), num('rx', 'Radius X'), num('ry', 'Radius Y'), ROT, ...PAINT];
    case 'line':
      return [num('x1', 'X1'), num('y1', 'Y1'), num('x2', 'X2'), num('y2', 'Y2'), ROT, color('stroke', 'Stroke'), num('strokeWidth', 'Stroke width'), num('opacity', 'Opacity (0–1)')];
    case 'arrow':
      // ADR 0333 Phase 4 — line fields + endpoint heads (computed polygons).
      return [
        num('x1', 'X1'), num('y1', 'Y1'), num('x2', 'X2'), num('y2', 'Y2'), ROT,
        { name: 'startHead', type: 'enum', label: 'Start head', options: ['none', 'arrow'] },
        { name: 'endHead', type: 'enum', label: 'End head', options: ['none', 'arrow'] },
        color('stroke', 'Stroke'), num('strokeWidth', 'Stroke width'), num('opacity', 'Opacity (0–1)'),
      ];
    case 'polyline':
    case 'polygon':
      return [{ name: 'points', type: 'pointlist', label: 'Points (x,y per line)' }, ROT, ...PAINT];
    case 'text':
      return [str('text', 'Text'), num('x', 'X'), num('y', 'Y'), num('fontSize', 'Font size'), ROT, ...PAINT];
    case 'image':
      // ADR 0401 follow-through — a host media asset on the canvas. `src` rides
      // the mediaRef widget, so Browse / Generate-with-AI / Edit-with-AI come
      // for free (the MediaRefWidget affordances).
      return [
        { name: 'src', type: 'mediaRef', label: 'Image' },
        num('x', 'X'), num('y', 'Y'), num('width', 'Width'), num('height', 'Height'),
        num('opacity', 'Opacity (0–1)'), ROT,
      ];
    default:
      return [...PAINT];
  }
}

const textHint = (el: Record<string, unknown>): string =>
  typeof el.text === 'string' && el.text ? ` — ${el.text.length > 24 ? `${el.text.slice(0, 24)}…` : el.text}` : '';

export const drawingsDefinition: CanvasEditorDefinition<DrawingDoc, FrameBase, CanvasNode> = {
  canvasTypeId: 'canvas.drawing',
  touchSupport: 'light-edit', // ADR 0333 P8: touch ink, pinch-zoom, two/three-finger undo/redo
  toggleId: 'drawings',
  clientBasePath: '/host/openwop-app/drawings',
  editorPath: '/drawings',
  i18nNamespace: 'drawings',
  Renderer: DrawingContentView,
  // ADR 0310 Phase C follow-up (research §5.5): direct manipulation replaces the
  // read-only preview in the editor — click-select + drag-move + resize handles.
  InteractivePreview: InteractiveDrawing,
  coerceDoc: coerceDrawing,
  // ADR 0359 Phase 5 — collab via the chassis element binding (mirrors the
  // backend registerCanvasEditorRoutes `collab: true` registration).
  collab: 'elements',
  docNameKey: 'title',
  // ADR 0333 Phase 3 — ink tools (the chassis renders Select implicitly) and
  // a deeper undo stack for stroke-heavy sessions.
  tools: [
    { id: 'pen', icon: () => <PencilIcon size={13} />, labelKey: 'tool_pen' },
    { id: 'highlighter', icon: () => <HighlighterIcon size={13} />, labelKey: 'tool_highlighter' },
    { id: 'eraser', icon: () => <EraserIcon size={13} />, labelKey: 'tool_eraser' },
    // ADR 0333 Phase 4 — drag-to-draw (Shift constrains, Alt centers; a plain
    // click places a default-size shape; adders stay the keyboard path).
    { id: 'rect', icon: () => <SquareIcon size={13} />, labelKey: 'tool_rect' },
    { id: 'ellipse', icon: () => <CircleIcon size={13} />, labelKey: 'tool_ellipse' },
    { id: 'line', icon: () => <SlashIcon size={13} />, labelKey: 'tool_line' },
    { id: 'arrow', icon: () => <ArrowUpRightIcon size={13} />, labelKey: 'tool_arrow' },
  ],
  historyDepth: 200,
  elements: [{
    key: 'shapes',
    // ADR 0333 Phase 3 raised the backend cap to 2000 (ink multiplies element
    // counts); the frontend gate matches (was a stale 500 — Phase-6 catch).
    max: 2000,
    min: 1,
    adders: [
      { id: 'rect', make: () => ({ kind: 'rect', x: 20, y: 20, width: 120, height: 80 }) },
      { id: 'circle', make: () => ({ kind: 'circle', cx: 80, cy: 80, r: 40 }) },
      { id: 'ellipse', make: () => ({ kind: 'ellipse', cx: 100, cy: 70, rx: 60, ry: 35 }) },
      { id: 'line', make: () => ({ kind: 'line', x1: 20, y1: 20, x2: 140, y2: 100, strokeWidth: 2 }) },
      { id: 'polyline', make: () => ({ kind: 'polyline', points: [{ x: 20, y: 100 }, { x: 70, y: 30 }, { x: 120, y: 100 }], strokeWidth: 2 }) },
      { id: 'polygon', make: () => ({ kind: 'polygon', points: [{ x: 60, y: 20 }, { x: 100, y: 100 }, { x: 20, y: 100 }] }) },
      { id: 'text', make: () => ({ kind: 'text', x: 20, y: 40, text: 'Text', fontSize: 18 }) },
      // ADR 0333 Phase 4 — the arrow kind (keyboard path for the drag tool).
      { id: 'arrow', make: () => ({ kind: 'arrow', x1: 20, y1: 60, x2: 140, y2: 60, strokeWidth: 2, endHead: 'arrow' }) },
      // ADR 0401 follow-through — a placed media-library image (src via the
      // property panel's mediaRef widget after adding).
      { id: 'image', make: () => ({ kind: 'image', x: 20, y: 20, width: 160, height: 120 }) },
    ],
    labelFor: (el, t) => `${t(`kind_${typeof el.kind === 'string' ? el.kind : 'shape'}`)}${textHint(el)}`,
    propDefs: shapePropDefs,
    // ADR 0333 Phase 2: overlap-aware z-order stepping + zoom-to-selection.
    bboxFor: (el) => shapeBBox(el),
    // ADR 0333 Phase 5: the chassis align/distribute translation seam.
    movePatchFor: (el, dx, dy) => shapeMovePatch(el, dx, dy),
    // Style memory: the last paint used per kind seeds the next add (adder ids
    // equal shape kinds — the styleKeys contract).
    styleKeys: ['fill', 'stroke', 'strokeWidth', 'opacity', 'color', 'size'],
    // ADR 0333 Phase 3 — the backend validator accepts name/locked/hidden/
    // groupId on drawing shapes, so the chassis chrome (lock/hide toggles,
    // names, ⌘G grouping) is honest here.
    chrome: true,
  }],
  docPropDefs: [
    // DRAW-R4/DATA-D9: the DOC dims are [1,4000] (validateDrawingDoc top-level) —
    // distinct from the element width/height bound (min 0), so bounded inline.
    // DRAW-G1 — `width`/`height` are BOTH element fields ("Width") and doc
    // fields ("Canvas width"), so the derived `prop_width` key cannot serve
    // both: whichever wording it held would be wrong on the other panel. This
    // is the SL-G7 `labelKey` case (#2537), third consumer.
    { name: 'width', type: 'number', label: 'Canvas width', labelKey: 'prop_canvasWidth', min: 1, max: 4000 },
    { name: 'height', type: 'number', label: 'Canvas height', labelKey: 'prop_canvasHeight', min: 1, max: 4000 },
    // ADR 0333 Phase 7 — guides: the panel IS the config UI (flat doc fields).
    { name: 'gridSize', type: 'number', label: 'Grid size', min: 1, max: 500 },
    { name: 'gridShow', type: 'boolean', label: 'Show grid' },
    { name: 'gridSnap', type: 'boolean', label: 'Snap to grid' },
    { name: 'symmetry', type: 'enum', label: 'Symmetry', options: ['off', 'vertical', 'horizontal', 'quadrant', 'radial'] },
    { name: 'symmetryRotational', type: 'boolean', label: 'Rotational symmetry' },
  ],
  // mediaRef joins pointlist (ADR 0401 follow-through): the image kind's src
  // gets the shared picker + AI generate/edit affordances (the slides wiring).
  propertyWidgets: { pointlist: PointListWidget, mediaRef: MediaRefWidget },
};
