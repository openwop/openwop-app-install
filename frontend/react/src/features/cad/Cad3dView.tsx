/**
 * ADR 0310 Phase-C follow-up — the read-only CAD 3D orbit viewer. Hand-rolled,
 * no Three.js (see `cad3d.ts`). Drag to orbit; the solids rotate in 3D, project
 * axonometrically, painter's-sort by depth, and shade by an approximate metallic/
 * roughness term applied as a `filter: brightness()` over the solid's own color
 * (token-safe — no color literals). Lazy-loaded (never in the entry bundle).
 */
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import { CAD_W, CAD_H, CAD_PAD } from '../../chat/artifacts/CadPreview.js';
import { tessellate, rotate, shadeBrightness, centroid, EL_MAX, HOME_AZ, HOME_EL, type Vec3, type Drawable, type CadSolidInput } from './cad3d.js';
import { CadViewCube } from './CadViewCube.js';
import { poseMesh } from './meshCodec.js';
import { ensureMesh, sampleForView, useMeshStoreVersion } from './meshStore.js';
import { resolveMaterial } from './cadMaterials.js';

/** ADR 0388 P1 — a `mesh` solid's triangles as painter Drawable faces (posed;
 *  deterministically stride-sampled above the viewer budget). While the asset
 *  loads (or on error) a placeholder box renders so the scene stays coherent. */
function meshDrawables(s: CadSolidInput & { assetRef?: unknown; scale?: unknown }): {
  drawables: Drawable[];
  sampled?: { shown: number; total: number };
  pending: boolean;
  failed?: boolean;
} {
  const assetRef = typeof s.assetRef === 'string' ? s.assetRef : '';
  const entry = assetRef ? ensureMesh(assetRef) : undefined;
  if (!entry || entry.status !== 'ready' || !entry.mesh) {
    // CAD2-M5 (R3) — the placeholder box keeps the scene coherent, but it is a
    // FABRICATION: without a badge a failed mesh rendered as a real-looking
    // 40 mm cube forever. `pending`/`failed` now reach the viewer's badges
    // (the sibling `sampled` badge was already rendered; the error case was
    // computed and dropped).
    const size = 40 * (typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1);
    return {
      drawables: tessellate({ ...s, kind: 'box', width: size, height: size, depth: size }),
      pending: entry?.status !== 'error',
      failed: entry?.status === 'error',
    };
  }
  const sample = sampleForView(entry.mesh);
  const posed = poseMesh({ ...entry.mesh, positions: sample.positions, triangleCount: sample.shown }, {
    kind: 'mesh',
    x: typeof s.x === 'number' ? s.x : 0,
    y: typeof s.y === 'number' ? s.y : 0,
    z: typeof s.z === 'number' ? s.z : 0,
    rotation: typeof s.rotation === 'number' ? s.rotation : 0,
    scale: typeof s.scale === 'number' && s.scale > 0 ? s.scale : 1,
  });
  const color = typeof s.color === 'string' && s.color ? s.color : 'var(--paper-2)';
  const material = {
    metallic: typeof s.metallic === 'number' ? s.metallic : 0.1,
    roughness: typeof s.roughness === 'number' ? s.roughness : 0.7,
  };
  const out: Drawable[] = [];
  for (let t = 0; t * 9 < posed.length; t += 1) {
    const p = t * 9;
    const a: Vec3 = { x: posed[p] ?? 0, y: posed[p + 1] ?? 0, z: posed[p + 2] ?? 0 };
    const b: Vec3 = { x: posed[p + 3] ?? 0, y: posed[p + 4] ?? 0, z: posed[p + 5] ?? 0 };
    const c: Vec3 = { x: posed[p + 6] ?? 0, y: posed[p + 7] ?? 0, z: posed[p + 8] ?? 0 };
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    out.push({ kind: 'face', face: { verts: [a, b, c], normal: { x: nx, y: ny, z: nz }, color, material } });
  }
  return {
    drawables: out,
    ...(sample.sampled ? { sampled: { shown: sample.shown, total: sample.total } } : {}),
    pending: false,
    failed: false,
  };
}

export function Cad3dView({ solids, label }: { solids: CadSolidInput[]; label: string }): JSX.Element {
  const { t } = useTranslation('chat');
  const { t: tCad } = useTranslation('cad');
  const hintId = useId();
  const [az, setAz] = useState(HOME_AZ); // the ¾ home view (shared with the view cube)
  const [el, setEl] = useState(HOME_EL);
  const drag = useRef<{ x: number; y: number } | null>(null);
  // Re-render when a mesh asset finishes loading (the store bumps its version).
  const meshVersion = useMeshStoreVersion();

  const { drawables, sampleBadge, meshPending, meshFailed } = useMemo<{ drawables: Drawable[]; sampleBadge: { shown: number; total: number } | null; meshPending: number; meshFailed: number }>(() => {
    const out: Drawable[] = [];
    let badge: { shown: number; total: number } | null = null;
    let pendingCount = 0;
    let failedCount = 0;
    for (const raw of solids) {
      // ADR 0388 P5 — resolve library material to inline paint BEFORE
      // tessellation so both paths shade identically.
      const paint = resolveMaterial(raw as { materialId?: unknown; color?: unknown; metallic?: unknown; roughness?: unknown });
      const s = { ...raw, ...paint } as CadSolidInput;
      if ((s as { kind?: unknown }).kind === 'mesh') {
        const m = meshDrawables(s as CadSolidInput & { assetRef?: unknown; scale?: unknown });
        out.push(...m.drawables);
        if (m.sampled) badge = badge ? { shown: badge.shown + m.sampled.shown, total: badge.total + m.sampled.total } : m.sampled;
        if (m.failed) failedCount += 1;
        else if (m.pending) pendingCount += 1;
      } else {
        out.push(...tessellate(s));
      }
    }
    return { drawables: out, sampleBadge: badge, meshPending: pendingCount, meshFailed: failedCount };
    // meshVersion is the re-render trigger for async mesh loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meshVersion invalidates the imperative ensureMesh reads
  }, [solids, meshVersion]);

  // Rotate everything, then auto-fit the projected bounds into the viewport.
  const scene = useMemo(() => {
    const rot = (v: Vec3): Vec3 => rotate(v, az, el);
    const pts: { x: number; y: number }[] = [];
    for (const d of drawables) {
      if (d.kind === 'sphere') {
        const c = rot(d.sphere.center); const r = d.sphere.radius;
        pts.push({ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y + r });
      } else {
        for (const v of d.face.verts) { const p = rot(v); pts.push({ x: p.x, y: p.y }); }
      }
    }
    if (pts.length === 0) return null;
    // GRADE-PASS CAD-G3: spread-args min/max blows the V8 argument limit at
    // ~65k points (3 sampled meshes ≈ 72k projected verts → RangeError).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    const scale = Math.min((CAD_W - 2 * CAD_PAD) / Math.max(maxX - minX, 1e-6), (CAD_H - 2 * CAD_PAD) / Math.max(maxY - minY, 1e-6));
    const sx = (x: number): number => CAD_PAD + (x - minX) * scale;
    const sy = (y: number): number => (CAD_H - CAD_PAD) - (y - minY) * scale;
    // Depth-sort back→front by rotated centroid z.
    const sorted = drawables
      .map((d) => ({ d, z: rot(centroid(d)).z }))
      .sort((a, b) => a.z - b.z);
    return { rot, sx, sy, scale, sorted };
  }, [drawables, az, el]);

  const onDown = (e: React.PointerEvent): void => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e: React.PointerEvent): void => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setAz((a) => a + dx * 0.01);
    setEl((p) => Math.max(-EL_MAX, Math.min(EL_MAX, p + dy * 0.01)));
  };
  const onUp = (): void => { drag.current = null; };
  // Keyboard orbit (WCAG 2.1.1) — arrows nudge the same az/el as a drag.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const step = 0.18;
    if (e.key === 'ArrowLeft') setAz((a) => a - step);
    else if (e.key === 'ArrowRight') setAz((a) => a + step);
    else if (e.key === 'ArrowUp') setEl((p) => Math.max(-EL_MAX, Math.min(EL_MAX, p - step)));
    else if (e.key === 'ArrowDown') setEl((p) => Math.max(-EL_MAX, Math.min(EL_MAX, p + step)));
    else return;
    e.preventDefault();
  };

  if (!scene) return <svg viewBox={`0 0 ${CAD_W} ${CAD_H}`} className="canvas-cad__svg" role="img" aria-label={label} />;

  return (
    <>
    {/* The wrap carries the svg's OLD sizing rules (see .canvas-cad__wrap) so
        the view-cube overlay anchors to the true canvas corner in BOTH
        consumers (chat CadPreview + the interactive editor's 3D view). */}
    <div className="canvas-cad__wrap">
    <svg
      viewBox={`0 0 ${CAD_W} ${CAD_H}`}
      className="canvas-cad__svg canvas-cad__svg--3d"
      role="img"
      aria-label={label}
      aria-describedby={hintId}
      tabIndex={0}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onKeyDown={onKeyDown}
    >
      {scene.sorted.map(({ d }, i) => {
        if (d.kind === 'sphere') {
          const c = scene.rot(d.sphere.center);
          const rp = d.sphere.radius * scene.scale; // auto-fit scale — consistent with boxes/cylinders
          const cx = scene.sx(c.x), cy = scene.sy(c.y);
          const b = shadeBrightness({ x: 0, y: 0.3, z: 1 }, d.sphere.material);
          const bh = shadeBrightness({ x: 0.5, y: 0.6, z: 0.6 }, d.sphere.material);
          return (
            <g key={i}>
              <circle cx={cx} cy={cy} r={rp} style={{ fill: d.sphere.color, filter: `brightness(${Math.round(b*1000)/1000})` }} stroke="currentColor" strokeWidth={1} />
              <circle cx={cx - rp * 0.3} cy={cy - rp * 0.3} r={rp * 0.42} style={{ fill: d.sphere.color, filter: `brightness(${Math.round(bh*1000)/1000})` }} opacity={0.55} />
            </g>
          );
        }
        const rotN = scene.rot(d.face.normal);
        if (rotN.z < 0) return null; // backface cull (camera looks down +z)
        const pts = d.face.verts.map((v) => scene.rot(v)).map((p) => `${Math.round(scene.sx(p.x)*10)/10},${Math.round(scene.sy(p.y)*10)/10}`).join(' ');
        const b = shadeBrightness(rotN, d.face.material);
        return <polygon key={i} points={pts} style={{ fill: d.face.color, filter: `brightness(${Math.round(b*1000)/1000})` }} stroke="currentColor" strokeWidth={0.75} strokeLinejoin="round" />;
      })}
    </svg>
    <CadViewCube az={az} el={el} onView={(a, e) => { setAz(a); setEl(e); }} />
    </div>
    {/* ADR 0388 P1 (architect R5) — simplified-preview honesty badge: the
        viewer stride-samples above its budget; export stays full fidelity. */}
    {sampleBadge ? (
      <span className="u-fs-12 muted" role="status">
        {tCad('meshSimplified', { shown: sampleBadge.shown, total: sampleBadge.total })}
      </span>
    ) : null}
    {meshPending > 0 ? (
      <span className="u-fs-12 muted" role="status">
        {tCad('meshLoadingBadge', { count: meshPending, formattedCount: formatNumber(meshPending) })}
      </span>
    ) : null}
    {meshFailed > 0 ? (
      <span className="u-fs-12 u-text-danger" role="alert">
        {tCad('meshFailedBadge', { count: meshFailed, formattedCount: formatNumber(meshFailed) })}
      </span>
    ) : null}
    <span id={hintId} className="sr-only">{t('cad3dKeyboardHint')}</span>
    </>
  );
}
