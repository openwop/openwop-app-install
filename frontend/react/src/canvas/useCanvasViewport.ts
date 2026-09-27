/**
 * Per-instance viewport gesture state for canvas surfaces (ADR 0333 Phase 1).
 * No god store (ADR 0310 rule 1) — each surface owns its own pan/zoom.
 *
 * Gesture grammar (the app-wide convention, matching GraphSurface):
 * - plain wheel PANS; Ctrl/⌘+wheel ZOOMS focally at the cursor (this is also
 *   how trackpad pinch arrives). React's onWheel is PASSIVE on the root, so a
 *   native non-passive listener is attached (the GraphSurface F2 precedent).
 * - Space+left-drag and middle-drag PAN (captured before children, so shape
 *   drags/marquees never start underneath). Plain left-drag stays the
 *   consumer's (marquee, shape drag).
 * - Two-pointer touch pinch zooms + pans (tracked in the bubble phase, so
 *   pointers claimed by a child gesture — which stopPropagation their downs —
 *   don't trigger it).
 *
 * Viewport state is EPHEMERAL UI state: it never enters `useHistoryState`
 * (no undo entries for pan/zoom).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  clampZoom, clientBoundsToStage, DEFAULT_ZOOM_LIMITS, edgeScrollVector, fitToBounds, zoomAtPoint,
  type ViewBounds, type ViewPt, type ViewportState, type ZoomLimits,
} from './viewport.js';

const ZOOM_STEP = 1.2;
const WHEEL_ZOOM_STEP = 1.1;
const ARROW_PAN_STEP = 24;
const EDGE_ZONE = 24;          // px — widened past tldraw's 8 for coarse pointers
const EDGE_MAX_SPEED = 14;     // px per frame at the very edge
const EDGE_START_DELAY_MS = 200;

interface PanDrag { pointerId: number; startX: number; startY: number; ox: number; oy: number }
interface Pinch { d0: number; mid0: ViewPt; vp0: ViewportState }

export interface CanvasViewport {
  pan: ViewPt;
  zoom: number;
  /** Rounded percentage for the readout (100 = the fitted 1:1 layout). */
  percent: number;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to the fitted view (zoom 1, no pan — the untransformed layout
   *  already letterbox-fits the artboard via `preserveAspectRatio`). */
  reset: () => void;
  /** Frame CLIENT-coordinate bounds (screen px — e.g. selection corners
   *  through `getScreenCTM`) in the wrapper with a margin (ADR 0333 Phase 2,
   *  zoom-to-selection). */
  fitClientBounds: (b: ViewBounds) => void;
  /** Frame CANVAS-coordinate (pre pan/zoom / stage-space) bounds in the wrapper
   *  with a margin — the "fit to content" path when the consumer already knows
   *  the box in canvas units (the GraphSurface fit-all-nodes precedent, ADR 0337
   *  Phase 2c). `fitLimits` overrides the interaction clamp for THIS fit (the
   *  graph fits at ≤1:1 while it interacts to 2.5×); omit to reuse `limits`. */
  fitBounds: (b: ViewBounds, fitLimits?: ZoomLimits) => void;
  /** Absolute zoom about the viewport center — the §7.3 preset-menu path
   *  (50/100/200%, ⇧0). Percent is relative to the fitted 1:1 layout. */
  zoomToPercent: (pct: number) => void;
  /** Center on a CANVAS-space point at the current zoom (minimap click). */
  centerOn: (pt: ViewPt) => void;
  /** Arrow-key pan handler for the focused wrapper (the WCAG single-pointer/
   *  keyboard alternative recorded by the Phase-1 ux-review). Shift = ×4. */
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** True while a pan drag is live (cursor: grabbing). */
  panning: boolean;
  /** True while Space is held over the surface (cursor: grab). */
  panReady: boolean;
  /** Spread onto the wrapper element. */
  wrapperProps: {
    ref: React.RefCallback<HTMLDivElement>;
    onPointerDownCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

/** Targets whose Space key must never be hijacked for pan-ready: text entry
 *  (typing) AND focusable controls that Space ACTIVATES (a keyboard user's
 *  cursor may happen to rest over the canvas). Non-widget roles (region,
 *  group — e.g. the focusable viewport wrapper itself) stay pannable. */
const SPACE_ACTIVATED_ROLES = new Set([
  'button', 'link', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'textbox', 'slider', 'searchbox',
]);
/** Whether an event target is a control that keyboard/pointer activation "owns"
 *  (text entry + Space-activated widgets) — so viewport gestures never hijack a
 *  down/Space headed for chrome. Exported so canvas consumers gate their own
 *  background handlers on the SAME predicate (the GraphSurface deselect). */
export const isInteractiveTarget = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || t.isContentEditable) return true;
  const role = t.getAttribute('role');
  return Boolean(role && SPACE_ACTIVATED_ROLES.has(role));
};

/** Whether a pointer-down should arm a BACKGROUND pan (ADR 0337 Phase 2c): the
 *  opt-in is on, it's a plain primary-button non-touch down, Space isn't held,
 *  no pan is already live, and the target isn't an interactive control (so
 *  chrome buttons / the device select never start a pan). Pure + exported so
 *  the gate is unit-testable — jsdom drops `button`/`pointerType` from synthetic
 *  pointer events, so the arming can't be proven through a rendered fireEvent. */
export function armsBackgroundPan(o: {
  backgroundPan: boolean; button: number; pointerType: string; spaceDown: boolean; panActive: boolean; target: EventTarget | null;
}): boolean {
  return o.backgroundPan && o.button === 0 && o.pointerType !== 'touch'
    && !o.spaceDown && !o.panActive && !isInteractiveTarget(o.target);
}

export function useCanvasViewport(opts?: { limits?: ZoomLimits; backgroundPan?: boolean }): CanvasViewport {
  const limits = opts?.limits ?? DEFAULT_ZOOM_LIMITS;
  const backgroundPan = opts?.backgroundPan ?? false;
  const [vp, setVp] = useState<ViewportState>({ pan: { x: 0, y: 0 }, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [panReady, setPanReady] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hover = useRef(false);
  const spaceDown = useRef(false);
  const panDrag = useRef<PanDrag | null>(null);
  const pointers = useRef(new Map<number, ViewPt>());
  const pinch = useRef<Pinch | null>(null);
  const vpRef = useRef(vp);
  vpRef.current = vp;

  const localPoint = useCallback((clientX: number, clientY: number): ViewPt => {
    const r = wrapRef.current?.getBoundingClientRect();
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
  }, []);

  // ---- Space tracking (pan-ready) ----------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isInteractiveTarget(e.target)) return;
      if (hover.current) e.preventDefault(); // keep the page from scrolling under the canvas
      if (!spaceDown.current) {
        spaceDown.current = true;
        if (hover.current) setPanReady(true);
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return;
      spaceDown.current = false;
      setPanReady(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  // ---- wheel: plain = pan, Ctrl/⌘ = focal zoom (native, non-passive) ------
  // React 17+ attaches root wheel listeners PASSIVELY, so preventDefault in a
  // React onWheel is a no-op (the GraphSurface F2 precedent) — attach natively.
  const wheelHandler = useRef<(e: WheelEvent) => void>(() => undefined);
  wheelHandler.current = (e: WheelEvent) => {
    e.preventDefault();
    const cur = vpRef.current;
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
      setVp(zoomAtPoint(cur, factor, localPoint(e.clientX, e.clientY), limits));
    } else {
      setVp({ zoom: cur.zoom, pan: { x: cur.pan.x - e.deltaX, y: cur.pan.y - e.deltaY } });
    }
  };
  const wheelBound = useRef<{ el: HTMLDivElement; h: (e: WheelEvent) => void } | null>(null);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    // Idempotent bind: StrictMode re-invokes callback refs with the SAME
    // element — detach the previous listener first so it never doubles.
    if (wheelBound.current) {
      wheelBound.current.el.removeEventListener('wheel', wheelBound.current.h);
      wheelBound.current = null;
    }
    wrapRef.current = el;
    if (!el) return;
    const h = (e: WheelEvent): void => wheelHandler.current(e);
    el.addEventListener('wheel', h, { passive: false });
    wheelBound.current = { el, h };
  }, []);

  // ---- pan drag (Space+left / middle), captured before children ----------
  const onPointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const spacePan = e.button === 0 && spaceDown.current;
    if (!spacePan && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation(); // the consumer never sees this down — it's a viewport gesture
    const cur = vpRef.current;
    panDrag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, ox: cur.pan.x, oy: cur.pan.y };
    wrapRef.current?.setPointerCapture?.(e.pointerId);
    setPanning(true);
  }, []);

  // ---- two-pointer pinch (bubble: only downs the consumer didn't claim) ---
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Opt-in background pan (ADR 0337 Phase 2c) — for consumers with no marquee
    // (the node graph): a plain primary-button drag on EMPTY canvas pans. Runs
    // in the bubble phase, so interactive children (which stopPropagation their
    // downs) and chrome controls never arm it. Space/middle pan stay in capture.
    if (armsBackgroundPan({ backgroundPan, button: e.button, pointerType: e.pointerType, spaceDown: spaceDown.current, panActive: panDrag.current != null, target: e.target })) {
      const cur = vpRef.current;
      panDrag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, ox: cur.pan.x, oy: cur.pan.y };
      wrapRef.current?.setPointerCapture?.(e.pointerId);
      setPanning(true);
      return;
    }
    if (e.pointerType !== 'touch') return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [ViewPt, ViewPt];
      pinch.current = {
        d0: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        mid0: localPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
        vp0: vpRef.current,
      };
      wrapRef.current?.setPointerCapture?.(e.pointerId);
    }
  }, [localPoint, backgroundPan]);

  // ---- edge scrolling during CONSUMER drags (ADR 0333 Phase 2) ------------
  // A shape drag / marquee captures to the consumer's element, but its moves
  // bubble through the wrapper (an ancestor). When a primary-button drag rides
  // near the wrapper edge, pan on a rAF loop after a short delay; the
  // consumer's per-move `getScreenCTM` math keeps the dragged shape under the
  // pointer while the canvas slides. Never active during the viewport's own
  // pan (pointless at the edge) or pinch.
  const edge = useRef<{ vec: ViewPt; raf: number; since: number } | null>(null);
  const stopEdge = useCallback(() => {
    if (edge.current) { cancelAnimationFrame(edge.current.raf); edge.current = null; }
  }, []);
  const driveEdge = useCallback(() => {
    const cur = edge.current;
    if (!cur) return;
    if (performance.now() - cur.since >= EDGE_START_DELAY_MS && (cur.vec.x || cur.vec.y)) {
      const v = vpRef.current;
      setVp({ zoom: v.zoom, pan: { x: v.pan.x + cur.vec.x, y: v.pan.y + cur.vec.y } });
    }
    cur.raf = requestAnimationFrame(driveEdge);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (panDrag.current && e.pointerId === panDrag.current.pointerId) {
      const p = panDrag.current;
      setVp({ zoom: vpRef.current.zoom, pan: { x: p.ox + (e.clientX - p.startX), y: p.oy + (e.clientY - p.startY) } });
      return;
    }
    // Consumer drag in flight (primary button held, not our pan/pinch)?
    if ((e.buttons & 1) === 1 && !pinch.current) {
      const el = wrapRef.current;
      if (el) {
        const local = localPoint(e.clientX, e.clientY);
        const vec = edgeScrollVector(local, el.clientWidth, el.clientHeight, EDGE_ZONE, EDGE_MAX_SPEED);
        if (vec.x || vec.y) {
          if (!edge.current) {
            edge.current = { vec, raf: 0, since: performance.now() };
            edge.current.raf = requestAnimationFrame(driveEdge);
          } else {
            edge.current.vec = vec;
          }
        } else {
          stopEdge();
        }
      }
    } else if (edge.current) {
      stopEdge();
    }
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.current && pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()] as [ViewPt, ViewPt];
        const d = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const mid = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
        const { d0, mid0, vp0 } = pinch.current;
        const zoom = clampZoom(vp0.zoom * (d / d0), limits);
        const scale = zoom / vp0.zoom;
        // Keep the canvas point under the initial midpoint pinned, then follow
        // the midpoint's travel — pinch zoom + two-finger pan in one formula.
        setVp({
          zoom,
          pan: {
            x: mid.x - (mid0.x - vp0.pan.x) * scale,
            y: mid.y - (mid0.y - vp0.pan.y) * scale,
          },
        });
      }
    }
  }, [limits, localPoint, driveEdge, stopEdge]);

  const endPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (panDrag.current && e.pointerId === panDrag.current.pointerId) {
      panDrag.current = null;
      setPanning(false);
    }
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    stopEdge();
  }, [stopEdge]);

  // Kill any live edge-scroll loop on unmount.
  useEffect(() => stopEdge, [stopEdge]);

  const onPointerEnter = useCallback(() => {
    hover.current = true;
    if (spaceDown.current) setPanReady(true);
  }, []);
  const onPointerLeave = useCallback(() => {
    hover.current = false;
    setPanReady(false);
  }, []);

  // ---- chrome actions ------------------------------------------------------
  const zoomBy = useCallback((factor: number) => {
    const el = wrapRef.current;
    const focal = el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
    setVp((cur) => zoomAtPoint(cur, factor, focal, limits));
  }, [limits]);
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const reset = useCallback(() => setVp({ pan: { x: 0, y: 0 }, zoom: 1 }), []);
  // §7.3 / CV-4 — center the viewport on a CANVAS-space point at the current
  // zoom (the minimap click-to-pan path).
  const centerOn = useCallback((pt: ViewPt) => {
    const el = wrapRef.current;
    if (!el) return;
    setVp((cur) => ({
      zoom: cur.zoom,
      pan: { x: el.clientWidth / 2 - pt.x * cur.zoom, y: el.clientHeight / 2 - pt.y * cur.zoom },
    }));
  }, []);
  // Absolute zoom about the viewport CENTER (the §7.3 preset-menu path — 50/
  // 100/200/⇧0). Reuses zoomAtPoint so the clamp + focal math stay one owner.
  const zoomToPercent = useCallback((pct: number) => {
    if (!Number.isFinite(pct) || pct <= 0) return;
    setVp((cur) => {
      const el = wrapRef.current;
      const focal = el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
      const z = cur.zoom > 0 ? cur.zoom : 1;
      return zoomAtPoint(cur, (pct / 100) / z, focal, limits);
    });
  }, [limits]);

  const fitClientBounds = useCallback((b: ViewBounds) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const stage = clientBoundsToStage(b, rect, vpRef.current);
    if (stage.maxX <= stage.minX || stage.maxY <= stage.minY) return;
    setVp(fitToBounds(stage, el.clientWidth, el.clientHeight, 40, limits));
  }, [limits]);

  const fitBounds = useCallback((b: ViewBounds, fitLimits?: ZoomLimits) => {
    const el = wrapRef.current;
    if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return; // jsdom / unmeasured
    if (b.maxX <= b.minX || b.maxY <= b.minY) return;
    setVp(fitToBounds(b, el.clientWidth, el.clientHeight, 40, fitLimits ?? limits));
  }, [limits]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only when the wrapper ITSELF is focused — never intercept keys headed
    // for the chrome buttons or consumer controls inside it.
    if (e.target !== e.currentTarget) return;
    const step = ARROW_PAN_STEP * (e.shiftKey ? 4 : 1);
    const d = e.key === 'ArrowLeft' ? { x: step, y: 0 }
      : e.key === 'ArrowRight' ? { x: -step, y: 0 }
      : e.key === 'ArrowUp' ? { x: 0, y: step }
      : e.key === 'ArrowDown' ? { x: 0, y: -step }
      : null;
    if (!d) return;
    e.preventDefault();
    const v = vpRef.current;
    setVp({ zoom: v.zoom, pan: { x: v.pan.x + d.x, y: v.pan.y + d.y } });
  }, []);

  return useMemo(() => ({
    pan: vp.pan,
    zoom: vp.zoom,
    percent: Math.round(vp.zoom * 100),
    zoomIn,
    zoomOut,
    reset,
    fitClientBounds,
    fitBounds,
    zoomToPercent,
    centerOn,
    onKeyDown,
    panning,
    panReady,
    wrapperProps: {
      ref: setRef,
      onPointerDownCapture,
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onPointerEnter,
      onPointerLeave,
    },
  }), [vp, panning, panReady, zoomIn, zoomOut, reset, fitClientBounds, fitBounds, zoomToPercent, centerOn, onKeyDown, setRef, onPointerDownCapture, onPointerDown, onPointerMove, endPointer, onPointerEnter, onPointerLeave]);
}
