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

import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

interface Shape {
  kind: 'rect' | 'circle' | 'ellipse' | 'line' | 'polyline' | 'polygon' | 'text';
  x?: number; y?: number; width?: number; height?: number; rx?: number; ry?: number;
  cx?: number; cy?: number; r?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  points?: { x: number; y: number }[]; text?: string; fontSize?: number;
  fill?: string; stroke?: string; strokeWidth?: number; opacity?: number;
}
interface Drawing { title?: string; width?: number; height?: number; shapes: Shape[] }

function parseDrawing(content: string): Drawing | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.shapes) || o.shapes.length === 0) return null;
  return raw as Drawing;
}

/** Common paint props — all optional, all safe attribute values. */
function paint(s: Shape): { fill?: string; stroke?: string; strokeWidth?: number; opacity?: number } {
  return {
    ...(s.fill ? { fill: s.fill } : {}),
    ...(s.stroke ? { stroke: s.stroke } : {}),
    ...(typeof s.strokeWidth === 'number' ? { strokeWidth: s.strokeWidth } : {}),
    ...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {}),
  };
}

function ShapeEl({ s }: { s: Shape }): JSX.Element | null {
  const p = paint(s);
  switch (s.kind) {
    case 'rect':
      return <rect x={s.x ?? 0} y={s.y ?? 0} width={s.width ?? 0} height={s.height ?? 0} {...(typeof s.rx === 'number' ? { rx: s.rx } : {})} {...p} />;
    case 'circle':
      return <circle cx={s.cx ?? 0} cy={s.cy ?? 0} r={s.r ?? 0} {...p} />;
    case 'ellipse':
      return <ellipse cx={s.cx ?? 0} cy={s.cy ?? 0} rx={s.rx ?? 0} ry={s.ry ?? 0} {...p} />;
    case 'line':
      return <line x1={s.x1 ?? 0} y1={s.y1 ?? 0} x2={s.x2 ?? 0} y2={s.y2 ?? 0} {...{ stroke: s.stroke ?? 'currentColor', ...(typeof s.strokeWidth === 'number' ? { strokeWidth: s.strokeWidth } : {}), ...(typeof s.opacity === 'number' ? { opacity: s.opacity } : {}) }} />;
    case 'polyline':
    case 'polygon': {
      const pts = (s.points ?? []).map((pt) => `${pt.x},${pt.y}`).join(' ');
      return s.kind === 'polyline' ? <polyline points={pts} {...{ fill: s.fill ?? 'none', ...p }} /> : <polygon points={pts} {...p} />;
    }
    case 'text':
      return <text x={s.x ?? 0} y={s.y ?? 0} {...(typeof s.fontSize === 'number' ? { fontSize: s.fontSize } : {})} {...p}>{s.text ?? ''}</text>;
    default:
      return null;
  }
}

export function DrawingPreview({ content }: ArtifactRendererProps): JSX.Element {
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
