/**
 * canvas.cad inline renderer (ADR 0153 Phase 4). Renders a constrained parametric model
 * — the `canvas.cad` artifact payload — inline in the chat workbench. Two view modes:
 * a dependency-free orthographic SVG projection (front elevation; painter's z-order),
 * and a read-only 3D orbit viewer (ADR 0310 Phase-C follow-up — hand-rolled, no
 * Three.js; see `features/cad/cad3d.ts`), lazy-loaded so it never enters the entry bundle.
 *
 * SAFETY: each solid maps to a specific React SVG element with numeric attributes — no
 * raw markup, no <foreignObject>, no dangerouslySetInnerHTML. `color` is an SVG paint
 * attribute value (can't execute). Read-only.
 */

import { Button } from '../../ui/Button.js';
import { lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/index.js';
import type { ArtifactRendererProps } from './rendererRegistry.js';
import { resolveMaterial } from '../../features/cad/cadMaterials.js';

const Cad3dView = lazy(() => import('../../features/cad/Cad3dView.js').then((m) => ({ default: m.Cad3dView })));
const CadDimensionsLayer = lazy(() => import('../../features/cad/CadDimensionsLayer.js').then((m) => ({ default: m.CadDimensionsLayer })));

type Kind = 'box' | 'cylinder' | 'sphere' | 'cone';
interface Solid {
  kind: Kind; x?: number; y?: number; z?: number;
  width?: number; height?: number; depth?: number; radius?: number; length?: number;
  /** ADR 0310 Phase-C follow-up — glTF-aligned material data (0..1). Rendered as
   *  APPROXIMATE shading in the 3D viewer; a real-PBR renderer would consume these
   *  faithfully. Optional, additive. */
  metallic?: number; roughness?: number;
  rotation?: number; color?: string; label?: string;
}
interface Model { name?: string; units?: string; solids: Solid[] }

export const CAD_W = 360, CAD_H = 240, CAD_PAD = 18;
const W = CAD_W, H = CAD_H, PAD = CAD_PAD;
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseModel(content: string): Model | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.solids) || o.solids.length === 0) return null;
  return raw as Model;
}

/** A solid's fields as read by the projection — typed loosely so BOTH the
 *  renderer's `Solid` and the editor's raw records satisfy it. */
type SolidLike = { kind?: unknown; x?: unknown; y?: unknown; z?: unknown; width?: unknown; height?: unknown; radius?: unknown; length?: unknown; rotation?: unknown; color?: unknown; scale?: unknown; label?: unknown; materialId?: unknown; emissive?: unknown };
export interface CadFootprint { x: number; y: number; w: number; h: number }

/** The 2D footprint (model units) of a solid: min corner (x,y) + width/height.
 *  Exported for the direct-manipulation editor's hit/selection layer. */
export function cadFootprint(s: SolidLike): CadFootprint {
  const x = n(s.x), y = n(s.y);
  switch (s.kind) {
    case 'box': return { x, y, w: n(s.width), h: n(s.height) };
    case 'sphere': return { x, y, w: 2 * n(s.radius), h: 2 * n(s.radius) };
    case 'cylinder': case 'cone': return { x, y, w: 2 * n(s.radius), h: n(s.length) };
    // ADR 0388 P1 — a referenced mesh's true bbox lives with its (async-loaded)
    // asset; the PURE footprint is a deterministic placeholder cube scaled by
    // the solid's uniform scale. The 3D orbit viewer renders the real
    // triangles; the orthographic projection shows this labeled proxy.
    case 'mesh': {
      const size = 40 * (typeof s.scale === 'number' && Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1);
      return { x, y, w: size, h: size };
    }
    default: return { x, y, w: 0, h: 0 };
  }
}

/** The auto-fit model→screen projection for a set of solids (the SAME transform
 *  the renderer uses), exported so the editor's overlay aligns exactly and can
 *  freeze the camera during a drag (ADR 0310 Phase C follow-up). */
export interface CadProjection { sx: (mx: number) => number; sy: (my: number) => number; scale: number }
export function cadProjection(solids: SolidLike[]): CadProjection {
  // Grade pass GC-CV: an empty set would make Math.min/max(...[]) return
  // ±Infinity → a NaN transform. Callers guarantee ≥1 solid, but the exported
  // pure fn returns an identity projection defensively.
  if (solids.length === 0) return { scale: 1, sx: (mx) => PAD + mx, sy: (my) => (H - PAD) - my };
  const fps = solids.map(cadFootprint);
  const minX = Math.min(...fps.map((f) => f.x));
  const minY = Math.min(...fps.map((f) => f.y));
  const maxX = Math.max(...fps.map((f) => f.x + f.w));
  const maxY = Math.max(...fps.map((f) => f.y + f.h));
  const scale = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1e-6), (H - 2 * PAD) / Math.max(maxY - minY, 1e-6));
  return { scale, sx: (mx) => PAD + (mx - minX) * scale, sy: (my) => (H - PAD) - (my - minY) * scale };
}

/** The shared model renderer — chat card and editor preview both mount this
 *  (the canvas framework's `Renderer` contract; `editPaths` unused). */
export function CadContentView({ content }: { content: string; editPaths?: boolean }): JSX.Element {
  const { t } = useTranslation('chat');
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const model = parseModel(content);
  if (!model) return <Notice variant="error">{t('cadInvalid')}</Notice>;
  const label = model.name ?? t('cadLabel');

  return (
    <figure className="canvas-cad">
      <div className="segmented view-toggle canvas-cad__viewtoggle" role="group" aria-label={t('cadViewLabel')}>
        <Button variant="primary" aria-pressed={view === '2d'} onClick={() => setView('2d')}>{t('cadView2d')}</Button>
        <Button variant="primary" aria-pressed={view === '3d'} onClick={() => setView('3d')}>{t('cadView3d')}</Button>
      </div>
      {view === '2d' ? (
        <svg className="canvas-cad__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
          <CadSolids solids={model.solids} proj={cadProjection(model.solids)} />
          {(model as { sketch?: unknown }).sketch && typeof (model as { sketch?: unknown }).sketch === 'object' ? (
            <CadSketchLayer sketch={(model as unknown as { sketch: Record<string, unknown> }).sketch} proj={cadProjection(model.solids)} />
          ) : null}
          {Array.isArray((model as { dimensions?: unknown }).dimensions) ? (
            <Suspense fallback={null}>
              <CadDimensionsLayer
                solids={model.solids as never}
                dimensions={(model as { dimensions?: never[] }).dimensions ?? []}
                units={model.units ?? 'mm'}
                proj={cadProjection(model.solids)}
              />
            </Suspense>
          ) : null}
        </svg>
      ) : (
        <Suspense fallback={<svg className="canvas-cad__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} />}>
          <Cad3dView solids={model.solids} label={label} />
        </Suspense>
      )}
      <figcaption className="canvas-cad__caption">
        {model.name ? <span className="canvas-cad__name">{model.name}</span> : null}
        <span className="canvas-cad__meta">{t('cadSolids', { n: model.solids.length })}{model.units ? ` · ${model.units}` : ''}{view === '3d' ? ` · ${t('cadOrbitHint')}` : ''}</span>
      </figcaption>
    </figure>
  );
}

/** ADR 0388 P4 — the 2D sketch overlay (z=0 construction plane): points +
 *  line/arc segments drawn over the projection. Read-only; solving happens
 *  only via the deterministic host solver. Tolerant of bad refs. */
export function CadSketchLayer({ sketch, proj }: {
  sketch: { points?: Array<{ x?: unknown; y?: unknown }>; segments?: Array<{ kind?: unknown; a?: unknown; b?: unknown }> };
  proj: CadProjection;
}): JSX.Element | null {
  const pts = Array.isArray(sketch.points) ? sketch.points : [];
  const segs = Array.isArray(sketch.segments) ? sketch.segments : [];
  if (pts.length === 0) return null;
  const P = (i: unknown): { x: number; y: number } | null => {
    const p = typeof i === 'number' ? pts[i] : undefined;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    return { x: proj.sx(p.x), y: proj.sy(p.y) };
  };
  return (
    <g className="canvas-cad__sketch" opacity={0.9} aria-hidden>
      {segs.map((s, i) => {
        const a = P(s.a); const b = P(s.b);
        if (!a || !b) return null;
        return <line key={`s${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeWidth={0.75} strokeDasharray={s.kind === 'arc' ? '3 2' : undefined} />;
      })}
      {pts.map((_, i) => {
        const sp = P(i);
        return sp ? <circle key={`p${i}`} cx={sp.x} cy={sp.y} r={2} fill="currentColor" /> : null;
      })}
    </g>
  );
}

/** The projected solids as safe SVG (painter's z-order), shared by the read-only
 *  renderer and the direct-manipulation editor's aligned base layer (ADR 0310
 *  Phase C follow-up). `fill` is a paint attribute value (a token or a color
 *  string) — never markup. */
export function CadSolids({ solids, proj }: { solids: SolidLike[]; proj: CadProjection }): JSX.Element {
  const { sx, sy, scale } = proj;
  const order = solids.map((_, i) => i).sort((a, b) => n(solids[a]!.z) - n(solids[b]!.z));
  return (
    <>
      {order.map((i) => {
        const s = solids[i]!;
        const f = cadFootprint(s);
        const left = sx(f.x), bottom = sy(f.y), pw = f.w * scale, ph = f.h * scale, top = bottom - ph;
        // ADR 0388 P5 — library material wins over inline paint.
        const paint = resolveMaterial(s as { materialId?: unknown; color?: unknown });
        const fill = paint.color ?? 'var(--paper-2)';
        const cx = left + pw / 2, cy = top + ph / 2;
        let el: JSX.Element | null;
        switch (s.kind) {
          case 'box':
            el = <rect x={left} y={top} width={pw} height={ph} style={{ fill }} stroke="currentColor" strokeWidth={1} />; break;
          case 'sphere':
            el = <circle cx={cx} cy={cy} r={pw / 2} style={{ fill }} stroke="currentColor" strokeWidth={1} />; break;
          case 'cylinder':
            el = (
              <>
                <rect x={left} y={top} width={pw} height={ph} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                <ellipse cx={cx} cy={top} rx={pw / 2} ry={Math.max(pw * 0.16, 2)} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                <ellipse cx={cx} cy={bottom} rx={pw / 2} ry={Math.max(pw * 0.16, 2)} style={{ fill }} stroke="currentColor" strokeWidth={1} />
              </>
            ); break;
          case 'cone':
            el = (
              <>
                <polygon points={`${cx},${top} ${left},${bottom} ${left + pw},${bottom}`} style={{ fill }} stroke="currentColor" strokeWidth={1} />
                <ellipse cx={cx} cy={bottom} rx={pw / 2} ry={Math.max(pw * 0.16, 2)} style={{ fill }} stroke="currentColor" strokeWidth={1} />
              </>
            ); break;
          // ADR 0388 P1 — a referenced mesh renders as a labeled dashed proxy
          // in the orthographic projection (the real triangles render in the
          // 3D orbit viewer; PBR arrives in P5).
          case 'mesh':
            el = (
              <>
                <rect x={left} y={top} width={pw} height={ph} style={{ fill }} fillOpacity={0.35} stroke="currentColor" strokeWidth={1} strokeDasharray="5 3" />
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fontSize={10} fill="currentColor">
                  {typeof s.label === 'string' && s.label ? s.label : 'mesh'}
                </text>
              </>
            ); break;
          default:
            el = null;
        }
        if (el === null) return null;
        // ADR 0317 follow-up: in-plane rotation (screen-space degrees) about the
        // footprint centre — the front elevation depicts Z-axis rotation only.
        const rot = n(s.rotation);
        return <g key={i}>{rot ? <g transform={`rotate(${rot} ${cx} ${cy})`}>{el}</g> : el}</g>;
      })}
    </>
  );
}

/** The chat artifact card: the shared renderer + a provenance-gated
 *  "Open in editor" (ADR 0310 Phase C — the AppBuilderPreview precedent). */
export function CadPreview({ artifact, content }: ArtifactRendererProps): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  const { runId, nodeId } = artifact.provenance ?? {};
  const canEdit = Boolean(runId && nodeId);
  return (
    <div className="canvas-edit-card">
      {canEdit ? (
        <div className="canvas-edit-card__bar">
          <Button variant="secondary" size="sm" onClick={() => navigate(`/cad/new?fromArtifact=${encodeURIComponent(`${runId}:${nodeId}`)}`)}>
            {t('canvasOpenEditor')}
          </Button>
        </div>
      ) : null}
      <CadContentView content={content} />
    </div>
  );
}
