/**
 * canvas.drawing inline renderer (ADR 0153 Phase 4). Renders a structured vector scene
 * — the `canvas.drawing` artifact payload — inline in the chat artifact workbench as
 * SAFE inline SVG, built from a CLOSED set of typed shapes with numeric geometry.
 *
 * SAFETY: we never inject raw SVG/HTML markup — each shape maps to a specific React SVG
 * element with numeric attributes and React-escaped text; there is no <foreignObject>,
 * no <script>, no dangerouslySetInnerHTML. `fill`/`stroke` are SVG paint attribute
 * VALUES (not CSS/markup), so a model-authored color string cannot execute. Read-only.
 */

import { Button } from '../../ui/Button.js';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';
import { strokeOutlinePath } from './strokePath.js';

export interface Shape {
  kind: 'rect' | 'circle' | 'ellipse' | 'line' | 'polyline' | 'polygon' | 'text' | 'stroke' | 'arrow' | 'image';
  x?: number; y?: number; width?: number; height?: number; rx?: number; ry?: number;
  cx?: number; cy?: number; r?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  points?: { x: number; y: number }[]; text?: string; fontSize?: number;
  fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; rotation?: number;
  // ADR 0333 Phase 3 — freehand ink (kind 'stroke') + element chrome.
  pressures?: number[]; simulatePressure?: boolean; size?: number; color?: string;
  taperStart?: number; taperEnd?: number;
  name?: string; locked?: boolean; hidden?: boolean; groupId?: string;
  // ADR 0333 Phase 4 — the arrow kind's endpoint heads.
  startHead?: 'none' | 'arrow'; endHead?: 'none' | 'arrow';
  // ADR 0401 follow-through — the `image` kind's host media-asset serve path.
  src?: string;
}

/** An arrowhead as a COMPUTED triangle (never an SVG <marker> — marker ids
 *  collide across mounted instances and widen the safe-renderer surface). */
function arrowHeadPoints(tipX: number, tipY: number, fromX: number, fromY: number, size: number): string {
  const dx = tipX - fromX, dy = tipY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = tipX - ux * size, by = tipY - uy * size;
  const wx = -uy * (size / 2), wy = ux * (size / 2);
  return `${tipX},${tipY} ${bx + wx},${by + wy} ${bx - wx},${by - wy}`;
}

/** The rotation pivot (bbox centre) of a shape — the point ShapeEl rotates
 *  about, matching the interactive editor's overlay (ADR 0317). Exported so the
 *  editor uses the SAME pivot. */
export function shapeCenter(s: Shape): { cx: number; cy: number } {
  const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  switch (s.kind) {
    case 'rect': return { cx: n(s.x) + n(s.width) / 2, cy: n(s.y) + n(s.height) / 2 };
    case 'circle': case 'ellipse': return { cx: n(s.cx), cy: n(s.cy) };
    case 'line': case 'arrow': return { cx: (n(s.x1) + n(s.x2)) / 2, cy: (n(s.y1) + n(s.y2)) / 2 };
    case 'text': return { cx: n(s.x), cy: n(s.y) };
    case 'image': return { cx: n(s.x) + n(s.width) / 2, cy: n(s.y) + n(s.height) / 2 };
    case 'polyline': case 'polygon': case 'stroke': {
      const ps = s.points ?? [];
      if (!ps.length) return { cx: 0, cy: 0 };
      const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
      return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
    }
    default: return { cx: 0, cy: 0 };
  }
}
interface Drawing { title?: string; width?: number; height?: number; shapes: Shape[] }

/** Parse a `canvas.drawing` JSON payload into typed shapes — reused by the
 *  direct-manipulation editor to get render-safe `Shape`s from the doc without
 *  a cast (ADR 0310 Phase C follow-up). */
export function parseDrawing(content: string): Drawing | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.shapes) || o.shapes.length === 0) return null;
  return raw as Drawing;
}

/** A doc-authored paint value is safe iff it carries no `url(`/`var(` — those
 *  trigger a cross-origin fetch on render (ADR 0333 grade pass CODE-D4). The
 *  validators reject these server-side; this is the render-time belt so a
 *  legacy/unvalidated row (`ctx.canvas.write`) can never beacon either. */
const safePaint = (v: string | undefined): string | undefined =>
  typeof v === 'string' && !/url\s*\(|var\s*\(|image-set\s*\(/i.test(v) ? v : undefined;

/** The `image` kind's render-time belt (mirrors the validator): only a HOST
 *  media-asset serve path may reach an <image href> — anything else renders
 *  nothing (an external href would beacon every viewer, the safePaint class). */
const safeImageHref = (v: string | undefined): string | undefined =>
  typeof v === 'string' && /^(?:\/v1)?\/host\/openwop-app\/assets\/[A-Za-z0-9_-]{1,512}$/.test(v) ? v : undefined;

/** Common paint props — all optional, all safe attribute values. */
function paint(s: Shape): { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number } {
  const fill = safePaint(s.fill), stroke = safePaint(s.stroke);
  return {
    ...(fill ? { fill } : {}),
    ...(stroke ? { stroke } : {}),
    ...(typeof s.strokeWidth === 'number' ? { strokeWidth: s.strokeWidth } : {}),
    ...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {}),
  };
}

/** One shape as a safe React SVG element (numeric attrs + escaped text; no raw
 *  markup). Exported so the direct-manipulation editor reuses the SAME safe
 *  rendering under its interaction layer (ADR 0310 Phase C follow-up). */
export function ShapeEl({ s }: { s: Shape }): JSX.Element | null {
  // ADR 0333 Phase 3 — element chrome: hidden shapes render nowhere (the ONE
  // renderer is also the editor's base layer, so hide works everywhere).
  if (s.hidden === true) return null;
  const p = paint(s);
  let el: JSX.Element | null;
  switch (s.kind) {
    case 'rect':
      el = <rect x={s.x ?? 0} y={s.y ?? 0} width={s.width ?? 0} height={s.height ?? 0} {...(typeof s.rx === 'number' ? { rx: s.rx } : {})} {...p} />; break;
    case 'circle':
      el = <circle cx={s.cx ?? 0} cy={s.cy ?? 0} r={s.r ?? 0} {...p} />; break;
    case 'ellipse':
      el = <ellipse cx={s.cx ?? 0} cy={s.cy ?? 0} rx={s.rx ?? 0} ry={s.ry ?? 0} {...p} />; break;
    case 'line':
      el = <line x1={s.x1 ?? 0} y1={s.y1 ?? 0} x2={s.x2 ?? 0} y2={s.y2 ?? 0} {...{ stroke: safePaint(s.stroke) ?? 'currentColor', ...(typeof s.strokeWidth === 'number' ? { strokeWidth: s.strokeWidth } : {}), ...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {}) }} />; break;
    case 'arrow': {
      // ADR 0333 Phase 4 — a line + computed triangle heads (no <marker>).
      const x1 = s.x1 ?? 0, y1 = s.y1 ?? 0, x2 = s.x2 ?? 0, y2 = s.y2 ?? 0;
      const sw = typeof s.strokeWidth === 'number' ? s.strokeWidth : 2;
      const headSize = Math.max(6, sw * 4);
      const paintStroke = safePaint(s.stroke) ?? 'currentColor';
      const common = { ...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {}) };
      el = (
        <g {...common}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={paintStroke} strokeWidth={sw} />
          {s.endHead !== 'none' ? <polygon points={arrowHeadPoints(x2, y2, x1, y1, headSize)} fill={paintStroke} /> : null}
          {s.startHead === 'arrow' ? <polygon points={arrowHeadPoints(x1, y1, x2, y2, headSize)} fill={paintStroke} /> : null}
        </g>
      );
      break;
    }
    case 'polyline':
    case 'polygon': {
      const pts = (s.points ?? []).map((pt) => `${pt.x},${pt.y}`).join(' ');
      el = s.kind === 'polyline' ? <polyline points={pts} {...{ fill: safePaint(s.fill) ?? 'none', ...p }} /> : <polygon points={pts} {...p} />; break;
    }
    case 'text':
      el = <text x={s.x ?? 0} y={s.y ?? 0} {...(typeof s.fontSize === 'number' ? { fontSize: s.fontSize } : {})} {...p}>{s.text ?? ''}</text>; break;
    case 'image': {
      // ADR 0401 follow-through — a host media asset placed on the canvas. The
      // serve URL is same-origin capability-tokened; safeImageHref is the belt.
      const href = safeImageHref(s.src);
      el = href
        ? <image href={href} x={s.x ?? 0} y={s.y ?? 0} width={s.width ?? 0} height={s.height ?? 0} preserveAspectRatio="xMidYMid meet" {...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {})} />
        : null;
      break;
    }
    case 'stroke': {
      // ADR 0333 Phase 3 — freehand ink: the spine re-renders as a FILLED
      // variable-width outline (width is geometry; no stroke attrs needed).
      // Same safety envelope: one numeric-only path `d`, a paint-value fill.
      const d = strokeOutlinePath(s.points ?? [], s.pressures, {
        size: typeof s.size === 'number' ? s.size : 4,
        ...(s.simulatePressure !== undefined ? { simulatePressure: s.simulatePressure } : {}),
        ...(typeof s.taperStart === 'number' ? { taperStart: s.taperStart } : {}),
        ...(typeof s.taperEnd === 'number' ? { taperEnd: s.taperEnd } : {}),
      });
      el = d ? <path d={d} {...{ fill: safePaint(s.color) ?? 'currentColor', ...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {}) }} /> : null;
      break;
    }
    default:
      el = null;
  }
  if (el === null) return null;
  // ADR 0317 follow-up: in-plane rotation about the shape's bbox centre.
  if (typeof s.rotation === 'number' && s.rotation) {
    const { cx, cy } = shapeCenter(s);
    return <g transform={`rotate(${s.rotation} ${cx} ${cy})`}>{el}</g>;
  }
  return el;
}

/** The shared drawing renderer — chat card and editor preview both mount this
 *  (the canvas framework's `Renderer` contract; drawings have no on-canvas
 *  selection, so `editPaths` is accepted but unused). */
export function DrawingContentView({ content }: { content: string; editPaths?: boolean }): JSX.Element {
  const { t } = useTranslation('chat');
  const drawing = parseDrawing(content);
  if (!drawing) return <Notice variant="error">{t('drawingInvalid')}</Notice>;
  const w = typeof drawing.width === 'number' && drawing.width > 0 ? drawing.width : 400;
  const h = typeof drawing.height === 'number' && drawing.height > 0 ? drawing.height : 300;
  return (
    <figure className="canvas-drawing">
      <svg className="canvas-drawing__svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={drawing.title ?? t('drawingLabel')} preserveAspectRatio="xMidYMid meet">
        {drawing.shapes.map((s, i) => <ShapeEl key={i} s={s} />)}
      </svg>
      {drawing.title ? <figcaption className="canvas-drawing__caption">{drawing.title}</figcaption> : null}
    </figure>
  );
}

/** The chat artifact card: the shared renderer + a provenance-gated
 *  "Open in editor" (ADR 0310 Phase C — the AppBuilderPreview precedent). */
export function DrawingPreview({ artifact, content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { runId, nodeId } = artifact.provenance ?? {};
  const canEdit = Boolean(runId && nodeId);
  return (
    <div className="canvas-edit-card">
      {canEdit ? (
        <div className="canvas-edit-card__bar">
          <Button variant="secondary" size="sm" onClick={() => navigate(`/drawings/new?fromArtifact=${encodeURIComponent(`${runId}:${nodeId}`)}`)}>
            {t('canvasOpenEditor')}
          </Button>
        </div>
      ) : null}
      <DrawingContentView content={content} />
    </div>
  );
}
