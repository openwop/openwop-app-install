/**
 * Direct-manipulation editor for `canvas.cad` (ADR 0310 Phase C + the 0317
 * gizmo follow-up). The projection auto-fits, so a gesture FREEZES the camera
 * (`scale`, centre, rotation) at pointer-down and converts screen deltas back
 * to model units (model-y-up / screen-y-down flip); on release the view re-fits.
 *
 * Gestures: drag a footprint to MOVE (X/Y); drag the knob above the selection to
 * ROTATE (in-plane, front-elevation Z-axis — the only rotation the orthographic
 * projection can honestly depict); drag an edge handle to RESIZE (box w/h,
 * sphere radius, cylinder/cone radius+length). Depth stays in the property
 * panel (camera-axis, invisible here). Resize is CENTRE-PRESERVING so it stays
 * correct while rotated. All mutation flows through the chassis `patchElement`
 * (one undo step per gesture); the math lives in `cadGeometry.ts` (pure, tested).
 *
 * Visuals reuse the shared `CadSolids` projection; the selection overlay is
 * wrapped in the same `rotate` transform so handles track the rotated shape. The
 * keyboard-accessible path stays the element list + property panel.
 *
 * VIEW MODES (ADR 0388 §Correction — the orbit viewer reaches the editor). The
 * bar carries a 2D/3D segmented toggle. `3D` mounts the SAME hand-rolled
 * `Cad3dView` the chat card uses — which is READ-ONLY by construction (an orbit
 * camera can't drive footprint dragging; see `cad3d.ts`), so 3D is an INSPECT
 * mode: no hit layer, no gizmo, no selection pill. Editing in 3D stays available
 * through the chassis rails (solid list + property panel), and the mode says so
 * rather than implying the orbit is draggable. Defaults to 2D so the direct-
 * manipulation surface is what an editor opens on.
 */
import { Button } from '../../ui/Button.js';
import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { InteractivePreviewProps } from '../../canvas/types.js';
import { ViewportSurface } from '../../canvas/ViewportSurface.js';
import { useCanvasViewport } from '../../canvas/useCanvasViewport.js';
import { SelectionPill } from '../../canvas/SelectionPill.js';
import { CadSolids, CadSketchLayer, cadFootprint, cadProjection, CAD_W, CAD_H } from '../../chat/artifacts/CadPreview.js';
import { PeerSelectionOverlays } from '../../canvas/PeerSelectionOverlay.js';
import { TransformGizmo } from '../../canvas/TransformGizmo.js';
import { CadDimensionsLayer } from './CadDimensionsLayer.js';
import { downloadBlob, svgElementToCleanString, svgStringToPngBlob } from '../../canvas/exportUtils.js';
import { toast } from '../../ui/toast.js';
import { StateCard, ErrorBoundary } from '../../ui/index.js';
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { CadDoc } from './definition.js';
import { cadResizeHandles, cadResizePatch, cadRotatePatch, rotatePoint, type CadHandle } from './cadGeometry.js';
import { emitCanonicalStl, emitGlb, parseMesh, poseMesh, tessellateSolid, MeshCodecError, type MeshFormat, type TessellatableSolid } from './meshCodec.js';
import { resolveMaterial } from './cadMaterials.js';
import { cadOrgId, peekMesh, ensureMesh } from './meshStore.js';
import { buildGapCandidates, buildSnapCandidates, combinedSnapDelta, type GapCandidates, type SnapCandidates, type SnapGuide, type SpaceSpan } from '../../canvas/snapping.js';

/** The read-only orbit viewer, lazy so it never enters the editor's entry
 *  chunk (the CadPreview precedent — the SAME component, one implementation). */
const Cad3dView = lazy(() => import('./Cad3dView.js').then((m) => ({ default: m.Cad3dView })));

/** Sniff the interchange format from a filename. */
function formatOf(name: string): MeshFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'stl') return 'stl';
  if (ext === 'obj') return 'obj';
  if (ext === 'gltf' || ext === 'glb') return 'gltf';
  return null;
}

/** Resolve every solid to full-fidelity triangles CLIENT-side (architect
 *  Ruling A — the editor download path; meshes come from the session cache).
 *  Returns null when a referenced mesh hasn't loaded yet. */
function collectClientParts(solids: Record<string, unknown>[]): Array<{ label: string; positions: Float32Array; color?: string; metallic?: number; roughness?: number }> | null {
  const parts: Array<{ label: string; positions: Float32Array; color?: string; metallic?: number; roughness?: number }> = [];
  let totalTriangles = 0;
  for (let i = 0; i < solids.length; i += 1) {
    const s = solids[i] as TessellatableSolid & Record<string, unknown>;
    const label = (typeof s.label === 'string' && s.label ? s.label : `${String(s.kind)}-${i + 1}`).slice(0, 80);
    let positions: Float32Array;
    if (s.kind === 'mesh') {
      const ref = typeof s.assetRef === 'string' ? s.assetRef : '';
      const entry = ref ? (peekMesh(ref) ?? ensureMesh(ref)) : undefined;
      if (!entry || entry.status !== 'ready' || !entry.mesh) return null; // still loading — caller toasts
      positions = poseMesh(entry.mesh, s);
    } else {
      positions = tessellateSolid(s);
    }
    if (positions.length === 0) continue;
    // Grade-pass (CAD-C2): the aggregate ceiling mirrors the server's — a doc
    // referencing one 50k-tri asset from hundreds of solids must not build a
    // multi-hundred-MB merge in the tab either.
    totalTriangles += positions.length / 9;
    if (totalTriangles > 500_000) throw new Error('Export exceeds the 500k-triangle aggregate cap.');
    // Grade-pass (CAD-C8): exports carry the SAME paint the viewer resolves.
    const mat = resolveMaterial(s);
    parts.push({
      label,
      positions,
      ...(typeof mat.color === 'string' && mat.color ? { color: mat.color } : {}),
      ...(typeof mat.metallic === 'number' ? { metallic: mat.metallic } : {}),
      ...(typeof mat.roughness === 'number' ? { roughness: mat.roughness } : {}),
    });
  }
  return parts;
}

const COL = 'solids';
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const KNOB = 22; // viewBox units — the rotate stalk length above the selection

type Pt = { x: number; y: number };

/** Client px → the CAD viewBox (CAD_W×CAD_H) via the overlay's screen CTM. */
function toViewBox(svg: SVGSVGElement, clientX: number, clientY: number): Pt {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/** Which interchange operation is running. ONE runs at a time (they contend for
 *  the same doc + the import navigates away), but the bar must say WHICH — a
 *  single boolean stamped `aria-busy` on all four export buttons at once, so a
 *  screen reader announced four busy controls for one BOM download. */
type BusyOp = 'import' | 'stl' | 'glb' | 'png' | 'bom';

interface DragState {
  mode: 'move' | 'rotate' | 'resize';
  idx: number;
  handleId?: string;
  axis?: CadHandle['axis'];
  startVB: Pt;
  startX: number; startY: number;
  cx: number; cy: number; rot: number; scale: number;
  startSolid: Record<string, unknown>;
  moved: boolean;
}

export function InteractiveCad({ doc, selection, onSelect, onClearSelection, patchElement, elementActions, peerSelections }: InteractivePreviewProps<CadDoc>): JSX.Element {
  const { t } = useTranslation('cad');
  const navigate = useNavigate();
  const { canvasId } = useParams<{ canvasId: string }>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [busy, setBusy] = useState<BusyOp | null>(null);
  const porting = busy !== null;
  // The 2D/3D toggle. 2D is the direct-manipulation surface; 3D is read-only
  // inspect (see the module header). `view3dRef` wraps the orbit view so PNG
  // export can capture the SVG the user is ACTUALLY looking at.
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const view3dRef = useRef<HTMLDivElement | null>(null);

  // ---- ADR 0388 P1: mesh import (client parse → canonical STL → server) ----
  async function importFile(file: File): Promise<void> {
    if (porting) return;
    const format = formatOf(file.name);
    if (!format) { toast.error(t('importUnsupported')); return; }
    setBusy('import');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseMesh(bytes, format);
      const canonical = emitCanonicalStl(parsed.positions);
      let b64 = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < canonical.length; i += CHUNK) {
        b64 += String.fromCharCode(...canonical.subarray(i, Math.min(i + CHUNK, canonical.length)));
      }
      b64 = btoa(b64);
      const orgId = await cadOrgId();
      if (!orgId) { toast.error(t('importFailed')); return; }
      const res = await fetch(
        `${config.baseUrl}/host/openwop-app/cad/orgs/${encodeURIComponent(orgId)}/canvases/import`,
        fetchOpts({
          method: 'POST',
          headers: authedHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            contentBase64: b64,
            name: file.name.replace(/\.[^.]+$/, ''),
            sourceFormat: format,
            dropped: parsed.dropped,
          }),
        }),
      );
      if (!res.ok) {
        const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
        toast.error(detail ?? t('importFailed'));
        return;
      }
      const body = (await res.json()) as { canvasId?: string };
      if (parsed.dropped.length > 0) {
        toast.info(t('importDropped', { dropped: parsed.dropped.join(', ') }));
      } else {
        toast.success(t('importDone'));
      }
      if (body.canvasId) navigate(`/cad/${encodeURIComponent(body.canvasId)}`);
    } catch (err) {
      toast.error(err instanceof MeshCodecError ? err.message : t('importFailed'));
    } finally {
      setBusy(null);
    }
  }

  // ---- ADR 0388 P2: BOM CSV via the deterministic host generator ----
  async function downloadBom(): Promise<void> {
    if (porting || !canvasId) return;
    setBusy('bom');
    try {
      const orgId = await cadOrgId();
      if (!orgId) { toast.error(t('bomFailed')); return; }
      const res = await fetch(
        `${config.baseUrl}/host/openwop-app/cad/orgs/${encodeURIComponent(orgId)}/canvases/${encodeURIComponent(canvasId)}/bom`,
        fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: '{}' }),
      );
      if (!res.ok) {
        const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message;
        toast.error(detail ?? t('bomFailed'));
        return;
      }
      const body = (await res.json()) as { csvUrl?: string };
      // UX_UPGRADE-cad R2 (CAD2-B4) — three failures used to render as answers
      // here. The BOM is this feature's commercial artifact; a "bill of
      // materials" the user opens in Excel and finds is an auth error is the
      // worst version of a failed read presented as a result.
      if (!body.csvUrl) { toast.error(t('bomFailed')); return; }
      const csvRes = await fetch(`${config.baseUrl}${body.csvUrl}`, fetchOpts({ headers: authedHeaders() }));
      // …`csvRes.ok` was NEVER checked: an expired media-capability token or a
      // 401 during refresh wrote the JSON/HTML error body to disk AS THE CSV.
      if (!csvRes.ok) { toast.error(t('bomFailed')); return; }
      const blob = await csvRes.blob();
      downloadBlob(blob, `${(doc.name || 'cad-model').replace(/[^\w.-]+/g, '-').slice(0, 60)}-bom.csv`);
    } catch {
      // …and the `try` had ONLY a `finally`, so a network throw on either fetch
      // escaped as an unhandled rejection with the spinner cleared and nothing
      // said.
      //
      // CORRECTED (review CAD2-R5): the first cut toasted `err.message`, citing
      // `importFile` as precedent. `importFile` narrows to `MeshCodecError` — an
      // APP-AUTHORED message — and falls back to a localized string for
      // everything else. Every throw reachable here is an engine string
      // (`TypeError: Failed to fetch`), so that branch was dead and fr/es/pt-BR
      // users would have got English.
      toast.error(t('bomFailed'));
    } finally {
      setBusy(null);
    }
  }

  // ---- ADR 0388 P1: export (client-side via the meshCodec twin) ----
  async function exportScene(kind: 'stl' | 'glb' | 'png'): Promise<void> {
    if (porting) return;
    setBusy(kind);
    try {
      const name = (doc.name || 'cad-model').replace(/[^\w.-]+/g, '-').slice(0, 60);
      if (kind === 'png') {
        // Capture WHAT IS ON SCREEN: in 3D the interactive `svgRef` is
        // unmounted, so read the orbit view's own SVG out of its wrapper —
        // otherwise a PNG taken from the 3D mode silently produced nothing
        // (the old bare `return` didn't even toast).
        const svg = view === '3d' ? view3dRef.current?.querySelector('svg') ?? null : svgRef.current;
        if (!svg) { toast.error(t('exportFailed')); return; }
        const text = svgElementToCleanString(svg);
        const png = await svgStringToPngBlob(text, CAD_W, CAD_H);
        if (!png) { toast.error(t('exportFailed')); return; }
        downloadBlob(png, `${name}.png`);
        return;
      }
      const parts = collectClientParts(doc.solids);
      if (!parts) { toast.info(t('meshStillLoading')); return; }
      if (parts.length === 0) { toast.error(t('exportFailed')); return; }
      if (kind === 'stl') {
        let total = 0;
        for (const p of parts) total += p.positions.length;
        const merged = new Float32Array(total);
        let off = 0;
        for (const p of parts) { merged.set(p.positions, off); off += p.positions.length; }
        const stlBytes = emitCanonicalStl(merged);
        downloadBlob(new Blob([stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength) as ArrayBuffer], { type: 'model/stl' }), `${name}.stl`);
      } else {
        const glbBytes = emitGlb(parts);
        downloadBlob(new Blob([glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength) as ArrayBuffer], { type: 'model/gltf-binary' }), `${name}.glb`);
      }
    } finally {
      setBusy(null);
    }
  }

  const solids = doc.solids;
  const proj = cadProjection(solids);
  const selIdx = selection && selection.col === COL ? selection.idx : -1;
  const selSolid = selIdx >= 0 ? solids[selIdx] : undefined;

  // §7.3 — hoisted so pan/zoom re-render THIS component: the pill anchor
  // below reads getScreenCTM(), and with the viewport state internal to
  // ViewportSurface a pan never re-rendered InteractiveCad, leaving the pill
  // frozen at its selection-time position (the CT-CV-1 live finding).
  const vp = useCanvasViewport();

  // §7.4 / CV-6 — smart guides (the ADR 0333 P5 "recorded adopter" wiring).
  // Candidates live in MODEL space, built at gesture start: the projection
  // auto-fits per render, so screen-space candidates would drift mid-drag;
  // model space is gesture-stable and the move patch is model-space anyway.
  const snapCand = useRef<SnapCandidates | null>(null);
  const gapCand = useRef<GapCandidates | null>(null);
  const snapThresh = useRef(1);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const [spans, setSpans] = useState<SpaceSpan[]>([]);
  function disarmSnap(): void {
    snapCand.current = null; gapCand.current = null;
    setGuides((v) => (v.length ? [] : v));
    setSpans((v) => (v.length ? [] : v));
  }

  /** Swap view modes. Switching unmounts the surface a gesture is bound to, so
   *  drop the drag + guides first — a live `drag.current` would otherwise
   *  resume against a stale frozen camera on the way back to 2D. */
  function switchView(next: '2d' | '3d'): void {
    if (next === view) return;
    drag.current = null;
    disarmSnap();
    setView(next);
  }

  /** The selected solid's screen box + centre + rotation (for handles). */
  function selGeom(): { left: number; top: number; pw: number; ph: number; cx: number; cy: number; rot: number } | null {
    if (!selSolid) return null;
    const f = cadFootprint(selSolid);
    const left = proj.sx(f.x), bottom = proj.sy(f.y), pw = f.w * proj.scale, ph = f.h * proj.scale, top = bottom - ph;
    return { left, top, pw, ph, cx: left + pw / 2, cy: top + ph / 2, rot: num(selSolid.rotation) };
  }

  // §7.4 / CV-7 — pill anchor, read post-commit and written STRAIGHT to the
  // wrapper's style — no state, so the every-commit firing can never
  // re-render (a setState here, even a bailing one, loops to React's
  // nested-update limit — the CT-CV-1 CAD crash).
  const pillPosRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = pillPosRef.current;
    if (!el) return;
    const svg = svgRef.current, root = rootRef.current;
    const geom = selGeom();
    const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    if (!svg || !root || !geom || !ctm) { el.style.visibility = 'hidden'; return; }
    const pt = svg.createSVGPoint();
    pt.x = geom.cx; pt.y = geom.top - KNOB;
    const sp = pt.matrixTransform(ctm);
    const wr = root.getBoundingClientRect();
    // Clamp INCLUDING the pill's own extent (translateX(-50%) overhangs ~half
    // its width) so it never pokes past the root and toggles the center
    // column's scroll overflow.
    el.style.left = `${Math.max(80, Math.min(sp.x - wr.left, wr.width - 80))}px`;
    el.style.top = `${Math.max(8, Math.min(sp.y - wr.top - 44, wr.height - 44))}px`;
    el.style.visibility = 'visible';
  });

  function beginMove(idx: number, e: React.PointerEvent): void {
    e.stopPropagation();
    onSelect(COL, idx);
    const svg = svgRef.current, s = solids[idx];
    if (!svg || !s) return;
    drag.current = { mode: 'move', idx, startVB: toViewBox(svg, e.clientX, e.clientY), startX: num(s.x), startY: num(s.y), cx: 0, cy: 0, rot: 0, scale: proj.scale, startSolid: s, moved: false };
    // Arm the smart guides: sibling footprints in model space (§7.4 / CV-6).
    const sibs = solids.filter((_, i) => i !== idx).map((sol) => cadFootprint(sol));
    snapCand.current = sibs.length ? buildSnapCandidates(sibs) : null;
    const mf = cadFootprint(s);
    gapCand.current = sibs.length >= 2 ? buildGapCandidates(sibs, { w: mf.w, h: mf.h }) : null;
    const span = Math.max(1, ...sibs.concat([mf]).flatMap((b) => [b.w, b.h]));
    snapThresh.current = Math.max(0.5, span / 12);
    svg.setPointerCapture(e.pointerId);
  }

  function beginHandle(mode: 'rotate' | 'resize', handleId: string | undefined, axis: CadHandle['axis'] | undefined, e: React.PointerEvent): void {
    e.stopPropagation();
    const svg = svgRef.current, g = selGeom(), s = selSolid;
    if (!svg || !g || !s) return;
    drag.current = { mode, idx: selIdx, ...(handleId ? { handleId } : {}), ...(axis ? { axis } : {}), startVB: toViewBox(svg, e.clientX, e.clientY), startX: 0, startY: 0, cx: g.cx, cy: g.cy, rot: g.rot, scale: proj.scale, startSolid: s, moved: false };
    svg.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent): void {
    const d = drag.current, svg = svgRef.current;
    if (!d || !svg) return;
    const cur = toViewBox(svg, e.clientX, e.clientY);
    if (!d.moved && Math.hypot(cur.x - d.startVB.x, cur.y - d.startVB.y) < CAD_W / 200) return;

    let patch: Record<string, unknown>;
    if (d.mode === 'move') {
      let nx = d.startX + (cur.x - d.startVB.x) / d.scale;
      let ny = d.startY - (cur.y - d.startVB.y) / d.scale;
      // §7.4 / CV-6 — align + equal-spacing snap in model space; Ctrl/⌘
      // bypasses (the tldraw convention, matching drawings).
      if ((snapCand.current || gapCand.current) && !e.ctrlKey && !e.metaKey) {
        const f0 = cadFootprint(d.startSolid);
        const moved = { x: f0.x + (nx - d.startX), y: f0.y + (ny - d.startY), w: f0.w, h: f0.h };
        const r = combinedSnapDelta(moved, snapCand.current, gapCand.current, snapThresh.current);
        nx += r.dx; ny += r.dy;
        setGuides(r.guides);
        setSpans(r.spans);
      } else {
        setGuides((v) => (v.length ? [] : v));
        setSpans((v) => (v.length ? [] : v));
      }
      patch = { x: Math.round(nx), y: Math.round(ny) };
    } else if (d.mode === 'rotate') {
      patch = cadRotatePatch(d.cx, d.cy, cur.x, cur.y);
    } else {
      // Un-rotate the pointer into the solid's local frame, then the dimension
      // is (twice) the along-axis distance from the frozen centre / camera scale.
      const local = rotatePoint(cur.x, cur.y, d.cx, d.cy, -d.rot);
      const dxScreen = Math.abs(local.x - d.cx), dyScreen = Math.abs(local.y - d.cy);
      const isSphere = d.startSolid.kind === 'sphere';
      const newDim = d.axis === 'diag' ? Math.max(dxScreen, dyScreen) / d.scale
        : d.axis === 'x' ? (isSphere ? dxScreen : (d.handleId === 'r' ? dxScreen : 2 * dxScreen)) / d.scale
          : 2 * dyScreen / d.scale;
      patch = cadResizePatch(d.startSolid, d.handleId ?? '', newDim);
    }
    if (!Object.keys(patch).length) return;
    patchElement(COL, d.idx, patch, d.moved ? 'move' : 'start');
    d.moved = true;
  }

  function endDrag(e: React.PointerEvent): void {
    const d = drag.current;
    if (!d) return;
    if (d.moved) patchElement(COL, d.idx, {}, 'end');
    drag.current = null;
    disarmSnap();
    svgRef.current?.releasePointerCapture(e.pointerId);
  }

  const g = selGeom();
  const handles = selSolid ? cadResizeHandles(selSolid.kind) : [];
  const handlePos = (h: CadHandle): Pt => {
    if (!g) return { x: 0, y: 0 };
    if (h.id === 'w' || h.id === 'r') return h.axis === 'diag' ? { x: g.left + g.pw, y: g.top } : { x: g.left + g.pw, y: g.cy };
    return { x: g.cx, y: g.top }; // 'h' / 'len' — top edge
  };

  return (
    <div className="cv-draw-interactive" ref={rootRef}>
      {/* ADR 0388 P1 — mesh interchange bar (the drawings export-bar vocabulary;
          outside the viewport transform so it never scales). Import parses
          client-side (architect Ruling A) and opens the NEW model; export
          renders full fidelity via the meshCodec twin. */}
      <div className="cv-draw-interactive__bar">
        {/* The 2D/3D toggle fills the bar's left slot (the drawings sibling's
            `__count` position), so import/export no longer float alone against
            an empty half. */}
        <div className="segmented view-toggle cv-draw-interactive__viewtoggle" role="group" aria-label={t('viewLabel')}>
          <Button variant="primary" aria-pressed={view === '2d'} onClick={() => switchView('2d')}>{t('view2d')}</Button>
          <Button variant="primary" aria-pressed={view === '3d'} onClick={() => switchView('3d')}>{t('view3d')}</Button>
        </div>
        <span className="cv-draw-interactive__export">
          {/* A <label> can NEVER match `:disabled`, so the ghost button's
              disabled rule never applied here — during a busy export the import
              affordance rendered fully live and ate the click silently. The
              class + aria-disabled carry the state a label can actually hold;
              the inner input keeps `disabled` so the picker stays shut. */}
          <label className={porting ? 'btn-ghost btn-sm is-disabled' : 'btn-ghost btn-sm'} aria-disabled={porting || undefined} aria-busy={busy === 'import' || undefined}>
            {t('importMesh')}
            <input
              type="file"
              accept=".stl,.obj,.gltf,.glb"
              className="sr-only"
              disabled={porting}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void importFile(file);
              }}
            />
          </label>
          <Button variant="quiet" size="sm" disabled={porting} aria-busy={busy === 'stl' || undefined} onClick={() => void exportScene('stl')}>{t('exportStl')}</Button>
          <Button variant="quiet" size="sm" disabled={porting} aria-busy={busy === 'glb' || undefined} onClick={() => void exportScene('glb')}>{t('exportGlb')}</Button>
          <Button variant="quiet" size="sm" disabled={porting} aria-busy={busy === 'png' || undefined} onClick={() => void exportScene('png')}>{t('exportPng')}</Button>
          <Button variant="quiet" size="sm" disabled={porting} aria-busy={busy === 'bom' || undefined} onClick={() => void downloadBom()}>{t('bomBtn')}</Button>
        </span>
        {/* One live region naming the running operation — the four `aria-busy`
            flags say "working", this says WHAT is working. */}
        <span className="sr-only" role="status">{busy ? t(`busy_${busy}`) : ''}</span>
      </div>
      {view === '3d' ? (
        // Read-only inspect. The orbit view owns its own pointer/keyboard
        // orbit; the chassis rails stay the editing path, and the note says so.
        <div className="cv-draw-interactive__view3d" ref={view3dRef}>
          {/* CADU-1 — a CAD-LOCAL boundary: Suspense catches the lazy PROMISE, not
              a render THROW. Without this, a projection/render crash unmounts the
              whole editor to the page boundary; here it degrades ONLY the 3D pane
              (the 2D editor + rails survive). */}
          <ErrorBoundary
            label="CAD 3D view"
            resetKey={view}
            fallback={(_error, reset) => (
              <StateCard announce title={t('view3dError')} action={<Button variant="quiet" size="sm" onClick={reset}>{t('common:retry')}</Button>} />
            )}
          >
            <Suspense fallback={<StateCard loading title={t('view3dLoading')} />}>
              <Cad3dView solids={solids} label={t('interactive3dLabel')} />
            </Suspense>
          </ErrorBoundary>
          <p className="cv-draw-interactive__view3d-note" role="note">{t('view3dReadOnly')}</p>
        </div>
      ) : (
      <>
      {/* ADR 0333 Phase 1: the scene pans/zooms inside the shared viewport.
          The drag math freezes the projection scale at gesture start and reads
          the rendered screen CTM, so the transform doesn't disturb it. */}
      <ViewportSurface vp={vp}>
      <svg
        ref={svgRef}
        className="cv-draw-interactive__svg"
        viewBox={`0 0 ${CAD_W} ${CAD_H}`}
        preserveAspectRatio="xMidYMid meet"
        // A labeled graphic — the keyboard path is the solid list + property
        // panel (grade pass UX; role=application would falsely promise in-widget
        // keyboard navigation this SVG doesn't implement).
        role="img"
        aria-label={t('interactiveLabel')}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerDown={() => onClearSelection()}
      >
        {/* Visuals — the shared projection (applies each solid's rotation). */}
        <CadSolids solids={solids} proj={proj} />
        {doc.sketch ? <CadSketchLayer sketch={doc.sketch as never} proj={proj} /> : null}
        {/* ADR 0388 P3 — derived dimension annotations. */}
        <CadDimensionsLayer solids={solids as never} dimensions={(doc.dimensions ?? []) as never} units={doc.units ?? 'mm'} proj={proj} />

        {/* ADR 0359 residuals — peers' selections in the scene (dashed hue
            outline + name flag over the projected footprint; the solid list's
            rail markers carry the AT path). */}
        <PeerSelectionOverlays outlines={(peerSelections?.(COL) ?? []).flatMap((p) => {
          const s = solids[p.idx];
          if (!s) return [];
          const f = cadFootprint(s);
          const left = proj.sx(f.x), bottom = proj.sy(f.y), pw = f.w * proj.scale, ph = f.h * proj.scale;
          const rot = num(s.rotation);
          return [{
            x: left, y: bottom - ph, w: pw, h: ph, name: p.name, color: p.color,
            ...(rot ? { transform: `rotate(${rot} ${left + pw / 2} ${bottom - ph / 2})` } : {}),
          }];
        })} />

        {/* Transparent hit layer (decorative for AT — the list is the a11y path). */}
        {solids.map((s, i) => {
          const f = cadFootprint(s);
          const left = proj.sx(f.x), bottom = proj.sy(f.y), pw = f.w * proj.scale, ph = f.h * proj.scale;
          const cx = left + pw / 2, cy = bottom - ph / 2, rot = num(s.rotation);
          return (
            <rect
              key={`h${i}`}
              className="cv-draw-interactive__hit"
              x={left} y={bottom - ph} width={Math.max(pw, 6)} height={Math.max(ph, 6)}
              {...(rot ? { transform: `rotate(${rot} ${cx} ${cy})` } : {})}
              onPointerDown={(e) => beginMove(i, e)}
              aria-hidden
            />
          );
        })}

        {/* Selection overlay — wrapped in the shape's rotation so outline +
            handles track it. Handles report gestures in root viewBox coords
            (getScreenCTM), which onPointerMove un-rotates for resize. */}
        {/* ADR 0388 P3 — the selection chrome rides the core TransformGizmo
            seam (src/canvas/): the gizmo owns visuals + pointer plumbing; the
            CAD-specific geometry/resize math stays here. */}
        {g ? (
          <TransformGizmo
            geom={g}
            handles={handles.map((h) => { const p = handlePos(h); return { id: h.id, x: p.x, y: p.y }; })}
            onRotateStart={(e) => beginHandle('rotate', undefined, undefined, e)}
            onResizeStart={(handleId, e) => {
              const h = handles.find((x) => x.id === handleId);
              beginHandle('resize', handleId, h?.axis, e);
            }}
          />
        ) : null}

        {/* §7.4 / CV-6 — smart-guide overlay, model→screen via the live
            projection (guides carry model coords; render converts). */}
        {guides.map((gd, gi) => (
          gd.axis === 'v'
            ? <line key={`g${gi}`} className="cv-draw-interactive__snap-guide" x1={proj.sx(gd.pos)} y1={0} x2={proj.sx(gd.pos)} y2={CAD_H} aria-hidden />
            : <line key={`g${gi}`} className="cv-draw-interactive__snap-guide" x1={0} y1={proj.sy(gd.pos)} x2={CAD_W} y2={proj.sy(gd.pos)} aria-hidden />
        ))}
        {spans.map((sp, si) => (
          sp.dir === 'x' ? (
            <g key={`sp${si}`} aria-hidden>
              <line className="cv-draw-interactive__space-span" x1={proj.sx(sp.from)} y1={proj.sy(sp.at)} x2={proj.sx(sp.to)} y2={proj.sy(sp.at)} />
              <text className="cv-draw-interactive__space-badge" x={(proj.sx(sp.from) + proj.sx(sp.to)) / 2} y={proj.sy(sp.at) - 4} textAnchor="middle" fontSize={10}>{Math.round(sp.gap)}</text>
            </g>
          ) : (
            <g key={`sp${si}`} aria-hidden>
              <line className="cv-draw-interactive__space-span" x1={proj.sx(sp.at)} y1={proj.sy(sp.from)} x2={proj.sx(sp.at)} y2={proj.sy(sp.to)} />
              <text className="cv-draw-interactive__space-badge" x={proj.sx(sp.at) + 4} y={(proj.sy(sp.from) + proj.sy(sp.to)) / 2} dominantBaseline="middle" fontSize={10}>{Math.round(sp.gap)}</text>
            </g>
          )
        ))}
      </svg>
      </ViewportSurface>
      </>
      )}
      {/* §7.4 / CV-7 — the near-selection pill above the selected solid — a rootRef
          SIBLING of the viewport (screen-space coords; inside the transformed
          stage the pan/zoom would apply twice — the grade-pass HIGH-1). The
          anchor comes from the post-commit layout effect, never a render-time
          CTM read (the CTM reflects a pan/zoom only after commit). */}
      {elementActions && g && view === '2d' ? (
        <div ref={pillPosRef} className="cv-selection-pill-anchor">
          <SelectionPill actions={elementActions} className="u-static" />
        </div>
      ) : null}
    </div>
  );
}
