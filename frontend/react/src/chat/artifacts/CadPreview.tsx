/**
 * canvas.cad inline renderer (ADR 0153 Phase 4). Renders a constrained parametric model
 * — the `canvas.cad` artifact payload — inline in the chat workbench as a dependency-free
 * orthographic SVG projection (front elevation; painter's z-order). A full interactive
 * WebGL viewer is a documented follow-up (the FE bundle has no room for Three.js).
 *
 * SAFETY: each solid maps to a specific React SVG element with numeric attributes — no
 * raw markup, no <foreignObject>, no dangerouslySetInnerHTML. `color` is an SVG paint
 * attribute value (can't execute). Read-only.
 */

import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';

type Kind = 'box' | 'cylinder' | 'sphere' | 'cone';
interface Solid {
  kind: Kind; x?: number; y?: number; z?: number;
  width?: number; height?: number; depth?: number; radius?: number; length?: number;
  color?: string; label?: string;
}
interface Model { name?: string; units?: string; solids: Solid[] }

const W = 360, H = 240, PAD = 18;
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseModel(content: string): Model | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.solids) || o.solids.length === 0) return null;
  return raw as Model;
}

/** The 2D footprint (model units) of a solid: min corner (x,y) + width/height. */
function footprint(s: Solid): { x: number; y: number; w: number; h: number } {
  const x = n(s.x), y = n(s.y);
  switch (s.kind) {
    case 'box': return { x, y, w: n(s.width), h: n(s.height) };
    case 'sphere': return { x, y, w: 2 * n(s.radius), h: 2 * n(s.radius) };
    case 'cylinder': case 'cone': return { x, y, w: 2 * n(s.radius), h: n(s.length) };
    default: return { x, y, w: 0, h: 0 };
  }
}

export function CadPreview({ content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const model = parseModel(content);
  if (!model) return <Notice variant="error">{t('cadInvalid')}</Notice>;

  const fps = model.solids.map(footprint);
  const minX = Math.min(...fps.map((f) => f.x));
  const minY = Math.min(...fps.map((f) => f.y));
  const maxX = Math.max(...fps.map((f) => f.x + f.w));
  const maxY = Math.max(...fps.map((f) => f.y + f.h));
  const span = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((W - 2 * PAD) / span, (H - 2 * PAD) / spanY);
  // Project model (mx,my) → screen (y is up in model, down on screen).
  const sx = (mx: number): number => PAD + (mx - minX) * scale;
  const sy = (my: number): number => (H - PAD) - (my - minY) * scale;

  // Painter's order: draw far solids (smaller z) first.
  const order = model.solids.map((_, i) => i).sort((a, b) => n(model.solids[a]!.z) - n(model.solids[b]!.z));

  return (
    <figure className="canvas-cad">
      <svg className="canvas-cad__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={model.name ?? t('cadLabel')} preserveAspectRatio="xMidYMid meet">
        {order.map((i) => {
          const s = model.solids[i]!;
          const f = fps[i]!;
          const left = sx(f.x), bottom = sy(f.y), pw = f.w * scale, ph = f.h * scale, top = bottom - ph;
          const fill = s.color ?? 'var(--color-surface-2)';
          const cx = left + pw / 2;
          switch (s.kind) {
            case 'box':
              return <rect key={i} x={left} y={top} width={pw} height={ph} style={{ fill }} stroke="currentColor" strokeWidth={1} />;
            case 'sphere':
              return <circle key={i} cx={cx} cy={top + ph / 2} r={pw / 2} style={{ fill }} stroke="currentColor" strokeWidth={1} />;
            case 'cylinder':
              return (
                <g key={i}>
                  <rect x={left} y={top} width={pw} height={ph} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                  <ellipse cx={cx} cy={top} rx={pw / 2} ry={Math.max(pw * 0.16, 2)} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                  <ellipse cx={cx} cy={bottom} rx={pw / 2} ry={Math.max(pw * 0.16, 2)} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                </g>
              );
            case 'cone':
              return (
                <g key={i}>
                  <polygon points={`${cx},${top} ${left},${bottom} ${left + pw},${bottom}`} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                  <ellipse cx={cx} cy={bottom} rx={pw / 2} ry={Math.max(pw * 0.16, 2)} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                </g>
              );
            default:
              return null;
          }
        })}
      </svg>
      <figcaption className="canvas-cad__caption">
        {model.name ? <span className="canvas-cad__name">{model.name}</span> : null}
        <span className="canvas-cad__meta">{t('cadSolids', { n: model.solids.length })}{model.units ? ` · ${model.units}` : ''}</span>
      </figcaption>
    </figure>
  );
}
