/**
 * GraphSurface (ADR 0323) — the reusable node-graph / screen-flow canvas for the
 * `graph` trait. Domain-neutral: it renders positioned nodes (via a render-prop)
 * connected by SVG edges (EdgeLayer), with pan/zoom, click/keyboard selection,
 * drag-to-move (pointer + keyboard arrows), and connect (pointer edge-handle drag
 * + a keyboard/click Connect affordance — the WCAG-canonical path, since the
 * workflow canvas is capped today for lacking one). The surface owns only its
 * VIEWPORT (pan/zoom + transient focus/connect state); every DOCUMENT mutation is
 * reported via callbacks so the chassis records one undo step per gesture.
 *
 * jsdom note: pointer-drag geometry needs a real bounding rect (jsdom returns a
 * 0-rect), so the pointer path is proven via the pure `clientToCanvas`
 * (edgeRouting.test); the component test exercises the keyboard + Connect paths.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { LinkIcon, XIcon, PlusIcon } from '../../ui/icons/index.js';
import { ZoomCluster } from '../ZoomCluster.js';
import { usePublishViewportHandle } from '../viewportHandle.js';
import { EdgeLayer } from './EdgeLayer.js';
import { gridLayout, clientToCanvas, snap, contentBounds, visibleNodeIds, type Box, type Edge } from './edgeRouting.js';
import { useCanvasViewport, isInteractiveTarget } from '../useCanvasViewport.js';
import { visibleCanvasRect } from '../viewport.js';
import type { ZoomLimits } from '../viewport.js';
import type { GraphNodeView, GraphEdgeView, GraphDeviceFrame } from '../types.js';

type Phase = 'start' | 'move' | 'end';

// ADR 0323/0337 pins: the board INTERACTS to 2.5× (wheel/pinch/±) but FITS at
// ≤1:1 (fit-all-nodes never magnifies past 100%). Preserved on the DRAW-1
// migration to the shared viewport (ADR 0337 Phase 2c).
const GRAPH_ZOOM_LIMITS: ZoomLimits = { min: 0.25, max: 2.5 };
const GRAPH_FIT_LIMITS: ZoomLimits = { min: 0.25, max: 1 };

export interface GraphSurfaceLabels {
  surface: string;         // aria-label for the whole surface
  connectFrom: string;     // "Start a connection from {label}" (has {label})
  connectTo: string;       // "Connect to {label}" (has {label})
  cancelConnect: string;   // cancel the armed connection
  connectArmed: string;    // announced when a source is armed (has {label})
  connected: string;       // announced on connect (has {from},{to})
  deletedEdge: string;     // announced on edge delete
  home: string;            // home badge text
  empty: string;           // message when there are no nodes
  addConnected: string;    // "Add connected screen" (audit gap #2; has {label})
  edgeSelected: string;    // announced when 'e' cycles onto an edge (has {from}/{to})
  deviceFrame: string;     // ADR 0337 P2b — the device selector label
  minimap: string;         // §7.3 / CV-4 — the minimap aria-label (click to pan, Enter fits)
}
// Zoom chrome labels moved INTO the shared ZoomCluster (canvas ns, CV-3) —
// the fit/zoom* label fields this interface carried are gone with the bespoke
// zoom bar they labeled.

export interface GraphSurfaceProps {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  nodeSize: { w: number; h: number };
  renderNode: (node: GraphNodeView, ctx: { selected: boolean }) => ReactNode;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onMoveNode: (id: string, x: number, y: number, phase: Phase) => void;
  /** Absent (ADR 0360) = edges are DERIVED: no connect handles, no Connect
   *  buttons, no drag-to-connect, no drop-create arming. */
  onConnect?: (from: string, to: string) => void;
  /** Absent = edges cannot be deleted: Delete-on-edge is inert + silent. */
  onDeleteEdge?: (id: string) => void;
  onActivateNode: (id: string) => void;
  /** Audit gap #2 — spawn a node pre-connected from this one (trait-gated).
   *  §7.4/CV-10: `pos` is the link-drag-create drop point (canvas coords). */
  onAddConnected?: (id: string, pos?: { x: number; y: number }) => void;
  onAnnounce: (message: string, politeness?: 'polite' | 'assertive') => void;
  gridSnap?: number;
  /** ADR 0337 P2b — board device frames (render-only nodeSize override). */
  deviceFrames?: readonly GraphDeviceFrame[];
  defaultDevice?: string;
  labels: GraphSurfaceLabels;
}

const NUDGE = 8; // keyboard move step (canvas units); Shift = ×5
const CREATE_TRAVEL_PX = 32; // min connect-drag travel (SCREEN px — divide by zoom for canvas units) before drop-on-empty creates (CV-10; grade-pass CVR2-1: a canvas-unit threshold shrank to ~8px at min zoom)
const RULER_STEP = 100; // canvas units between ruler ticks

/** ADR 0337 P2b — screen positions of the canvas-coord gridlines within a rail
 *  of `len` px, given pan/zoom. Pure (unit-tested). A tick every RULER_STEP
 *  canvas units; caps the count so a zoomed-out huge board can't emit 10k ticks. */
export function rulerTicks(panOffset: number, zoom: number, len: number, step = RULER_STEP): { pos: number; coord: number }[] {
  if (zoom <= 0 || len <= 0) return [];
  const stepPx = step * zoom;
  if (stepPx < 6) return []; // too dense to read — hide rather than clutter
  const firstCoord = Math.ceil((-panOffset) / stepPx) * step;
  const out: { pos: number; coord: number }[] = [];
  for (let coord = firstCoord, guard = 0; guard < 400; coord += step, guard++) {
    const pos = panOffset + coord * zoom;
    if (pos >= len) break; // exclusive at the far edge — no tick flush to the border
    if (pos >= 0) out.push({ pos: pos + 0, coord: coord + 0 }); // normalize -0 → 0
  }
  return out;
}

export function GraphSurface(props: GraphSurfaceProps): JSX.Element {
  const { nodes, edges, nodeSize, renderNode, selectedNodeId, selectedEdgeId, onSelectNode, onSelectEdge, onMoveNode, onConnect, onDeleteEdge, onActivateNode, onAddConnected, onAnnounce, gridSnap = 0, deviceFrames, defaultDevice, labels } = props;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // ADR 0337 Phase 2c — the shared viewport (ONE owner of pan/zoom state +
  // gestures, closing the DRAW-1 debt): plain-wheel pan / Ctrl-wheel focal zoom,
  // Space+drag & middle-drag pan, two-pointer pinch, edge-scroll while dragging,
  // and arrow-key pan on the focused surface — all inherited. `backgroundPan`
  // keeps the graph's plain-left-drag-on-empty pan (it has no marquee); `limits`
  // pins the [0.25, 2.5] interaction clamp (ADR 0323). Ephemeral (never history).
  const vp = useCanvasViewport({ limits: GRAPH_ZOOM_LIMITS, backgroundPan: true });
  const { pan, zoom, percent, zoomIn, zoomOut, zoomToPercent, centerOn, fitBounds, wrapperProps, onKeyDown: onViewportKey } = vp;
  // ADR 0337 P2b — the active device frame overrides nodeSize at RENDER time
  // (Guardrail 1: one derived size used everywhere nodeSize was). Ephemeral.
  const [deviceId, setDeviceId] = useState<string>(defaultDevice ?? deviceFrames?.[0]?.id ?? '');
  const activeDevice = deviceFrames?.find((d) => d.id === deviceId);
  const nodeSizeW = activeDevice?.width ?? nodeSize.w;
  const nodeSizeH = activeDevice?.height ?? nodeSize.h;
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  // ADR 0360 grade pass — derived-edge mode: no connect chrome at all.
  const connectable = typeof onConnect === 'function';
  const drag = useRef<{ id: string; startX: number; startY: number; ox: number; oy: number; started: boolean } | null>(null);
  const connectDrag = useRef<{ from: string; sourceEdge: Edge; start: { x: number; y: number } } | null>(null);
  const [preview, setPreview] = useState<{ from: string; sourceEdge: Edge; to: { x: number; y: number } } | null>(null);

  // Resolve every node to a box: stored position wins, else a stable grid slot.
  const auto = useMemo(() => gridLayout(nodes.map((n) => n.id), { w: nodeSizeW, h: nodeSizeH }), [nodes, nodeSizeW, nodeSizeH]);
  const boxes = useMemo(() => {
    const m = new Map<string, Box>();
    for (const n of nodes) {
      const a = auto.get(n.id) ?? { x: 0, y: 0 };
      m.set(n.id, { x: n.x ?? a.x, y: n.y ?? a.y, w: n.w ?? nodeSizeW, h: n.h ?? nodeSizeH });
    }
    return m;
  }, [nodes, auto, nodeSizeW, nodeSizeH]);

  // Content extent (+margin) so the transform layer and svg hold everything.
  const extent = useMemo(() => {
    let w = 400, h = 300;
    for (const b of boxes.values()) { w = Math.max(w, b.x + b.w + 200); h = Math.max(h, b.y + b.h + 200); }
    return { w, h };
  }, [boxes]);

  // Audit polish P3 — virtualization: only nodes near the viewport (plus the
  // selection) render their LIVE body, capped at LIVE_CAP; the rest keep their
  // full shell (box, edges, selection, keyboard) with a lightweight placeholder
  // body. Viewport culling needs a real measurement, so it FAILS OPEN when the
  // surface is unmeasurable (jsdom / first paint) — the cap still applies.
  const LIVE_CAP = 24;
  // Grade-pass MED-3 — the observed surface size lives in STATE so render
  // never reads clientWidth/Height (a synchronous reflow per pan/zoom frame);
  // the ResizeObserver fires once on observe, seeding the initial size.
  const [surfaceSize, setSurfaceSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSurfaceSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const liveIds = useMemo(() => {
    const measurable = surfaceSize.w > 0 && surfaceSize.h > 0;
    const inView = measurable ? visibleNodeIds(boxes, pan, zoom, surfaceSize.w, surfaceSize.h) : null;
    const out = new Set<string>();
    for (const n of nodes) {
      if (out.size >= LIVE_CAP) break;
      if (!inView || inView.has(n.id)) out.add(n.id);
    }
    if (selectedNodeId) out.add(selectedNodeId); // the edited node is always live
    return out;
  }, [surfaceSize, boxes, pan, zoom, nodes, selectedNodeId]);

  const rect = useCallback((): { left: number; top: number } => {
    const r = surfaceRef.current?.getBoundingClientRect();
    return { left: r?.left ?? 0, top: r?.top ?? 0 };
  }, []);

  // Frame all nodes in the viewport (ADR 0323 Phase 5) — sets ONLY the viewport
  // (never the doc), clamped to ≤1:1 via GRAPH_FIT_LIMITS. Delegates to the
  // shared viewport's canvas-space fit (ADR 0337 Phase 2c); the hook guards an
  // unmeasured surface (jsdom returns a 0-rect).
  const fit = useCallback(() => {
    const b = contentBounds(boxes.values());
    if (!b) return;
    fitBounds(b, GRAPH_FIT_LIMITS);
  }, [boxes, fitBounds]);

  // §7.3 / CV-3 — publish the zoom handle so the chassis ⇧1/⇧0 shortcuts
  // reach the board (no second window listener; architect ruling P1-2).
  const zoomHandle = useMemo(() => ({ fit, zoomToPercent }), [fit, zoomToPercent]);
  usePublishViewportHandle(zoomHandle);

  // Auto-fit ONCE on first layout so a generated app (Phase 4 emits spread-out
  // positions) opens framed — never re-fires, so it can't fight the user's pan.
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current || nodes.length === 0) return;
    const el = surfaceRef.current;
    if (!el || el.clientWidth <= 0) return;
    fit();
    didFit.current = true;
  }, [nodes.length, fit]);

  // ADR 0337 P2b (Guardrail 2) — switching the device frame reflows every
  // default-sized node to a new aspect, so refit the board (a tall→wide switch
  // would otherwise leave nodes clipped). Only on an actual CHANGE, never the
  // initial mount (the auto-fit above owns that).
  const prevDevice = useRef(deviceId);
  useEffect(() => {
    if (prevDevice.current === deviceId) return;
    prevDevice.current = deviceId;
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit reads the fresh boxes; deviceId is the trigger
  }, [deviceId]);

  // ---- pointer: node drag -------------------------------------------------
  const onNodePointerDown = useCallback((e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    const b = boxes.get(id);
    if (!b) return;
    onSelectNode(id);
    const c = clientToCanvas(e.clientX, e.clientY, rect(), pan, zoom);
    // Grade F1: arm only — the history 'start' is emitted lazily on the FIRST
    // real move, so a plain click never pushes an undo entry, marks the doc
    // dirty, or persists an auto-layout position.
    drag.current = { id, startX: c.x, startY: c.y, ox: b.x, oy: b.y, started: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  }, [boxes, onSelectNode, pan, zoom, rect]);

  /** The node whose box contains a canvas point (topmost = last in order). */
  const nodeAt = useCallback((p: { x: number; y: number }): string | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const b = boxes.get(nodes[i]!.id);
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return nodes[i]!.id;
    }
    return null;
  }, [nodes, boxes]);

  /** Commit a connection (shared by the pointer-drag and keyboard/button paths). */
  const doConnect = useCallback((from: string, to: string) => {
    if (from === to || !onConnect) return;
    onConnect(from, to);
    const fl = nodes.find((x) => x.id === from)?.label ?? from;
    const tl = nodes.find((x) => x.id === to)?.label ?? to;
    onAnnounce(labels.connected.replace('{from}', fl).replace('{to}', tl), 'polite');
  }, [onConnect, nodes, onAnnounce, labels]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (connectDrag.current) {
      const c = clientToCanvas(e.clientX, e.clientY, rect(), pan, zoom);
      setPreview({ from: connectDrag.current.from, sourceEdge: connectDrag.current.sourceEdge, to: c });
    } else if (drag.current) {
      const d = drag.current;
      const c = clientToCanvas(e.clientX, e.clientY, rect(), pan, zoom);
      const nx = snap(d.ox + (c.x - d.startX), gridSnap);
      const ny = snap(d.oy + (c.y - d.startY), gridSnap);
      if (!d.started) {
        if (nx === d.ox && ny === d.oy) return; // sub-threshold jitter — still a click
        onMoveNode(d.id, d.ox, d.oy, 'start');  // snapshot the pre-drag position once
        d.started = true;
      }
      onMoveNode(d.id, nx, ny, 'move');
    }
    // Background/Space/middle pan is owned by the shared viewport (composed on
    // the wrapper's onPointerMove) — no panDrag branch here anymore.
  }, [onMoveNode, pan, zoom, gridSnap, rect]);

  const endDrag = useCallback((e: ReactPointerEvent) => {
    if (connectDrag.current) {
      const c = clientToCanvas(e.clientX, e.clientY, rect(), pan, zoom);
      const target = nodeAt(c);
      const from = connectDrag.current.from;
      if (target && target !== from) {
        doConnect(from, target);
      } else if (!target && onAddConnected
        && Math.hypot(c.x - connectDrag.current.start.x, c.y - connectDrag.current.start.y) >= CREATE_TRAVEL_PX / (zoom > 0 ? zoom : 1)) {
        // §7.4 / CV-10 — link-drag-CREATE: a deliberate drop on EMPTY canvas
        // spawns a pre-connected node at the drop point (one node kind — no
        // picker ceremony). The travel threshold keeps a handle-jiggle from
        // creating; the keyboard path stays the armed-connect + Add button.
        onAddConnected(from, c);
      }
      connectDrag.current = null;
      setPreview(null);
    }
    if (drag.current) {
      const d = drag.current;
      if (d.started) {
        const c = clientToCanvas(e.clientX, e.clientY, rect(), pan, zoom);
        onMoveNode(d.id, snap(d.ox + (c.x - d.startX), gridSnap), snap(d.oy + (c.y - d.startY), gridSnap), 'end');
      }
      drag.current = null;
    }
    // panDrag lives in the shared viewport now (its own onPointerUp).
  }, [onMoveNode, pan, zoom, gridSnap, nodeAt, doConnect, onAddConnected, rect]);

  // ---- background click: deselect (pan itself is the shared viewport's) ----
  // A background pointer-down clears the selection; the shared viewport arms the
  // pan in its OWN composed onPointerDown. Node/handle downs stopPropagation, so
  // this fires for empty-canvas AND bubbled chrome downs — gate on the SAME
  // interactive-target predicate the pan-arm uses, so clicking the zoom bar or
  // switching the device frame never clears the selected screen.
  const onBgPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 || isInteractiveTarget(e.target)) return;
    onSelectNode(null);
    onSelectEdge(''); // clear edge selection (empty id = none)
  }, [onSelectNode, onSelectEdge]);

  // ---- connect (pointer edge-handle OR keyboard/click affordance) --------
  const beginConnect = useCallback((id: string) => {
    // Grade UX-13: the role="status" connect-bar announces the armed state on
    // appearance — no explicit announce here (it double-fired before).
    setConnectFrom(id);
  }, []);

  const completeConnect = useCallback((to: string) => {
    if (!connectFrom || connectFrom === to) { setConnectFrom(null); return; }
    doConnect(connectFrom, to);
    setConnectFrom(null);
  }, [connectFrom, doConnect]);

  const onConnectButton = useCallback((id: string) => {
    if (connectFrom && connectFrom !== id) completeConnect(id);
    else beginConnect(id);
  }, [connectFrom, completeConnect, beginConnect]);

  // Grade UX-3/code-F6: keyboard edge selection — 'e' on a node cycles through
  // its incident edges (selecting each, announced with resolved labels), so
  // the edge panel + Delete are reachable without a pointer.
  const labelOf = useCallback((id: string): string => nodes.find((x) => x.id === id)?.label ?? id, [nodes]);
  const cycleEdges = useCallback((nodeId: string) => {
    const incident = edges.filter((ed) => ed.from === nodeId || ed.to === nodeId);
    if (!incident.length) return;
    const at = incident.findIndex((ed) => ed.id === selectedEdgeId);
    const next = incident[(at + 1) % incident.length]!;
    onSelectEdge(next.id);
    onAnnounce(labels.edgeSelected.replace('{from}', labelOf(next.from)).replace('{to}', labelOf(next.to)), 'polite');
  }, [edges, selectedEdgeId, onSelectEdge, onAnnounce, labels, labelOf]);

  // Grade UX-14: coalesce a burst of arrow nudges into ONE undo entry — the
  // first press snapshots ('start'), the rest replace ('move'); an 800ms lull
  // ends the gesture.
  const nudgeActive = useRef(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- keyboard on a node -------------------------------------------------
  const onNodeKey = useCallback((e: ReactKeyboardEvent, id: string) => {
    // Grade UX-2: keydown from the node-bar buttons (Connect / Add connected)
    // bubbles here — those buttons own their keys; never hijack their Enter.
    if (e.target !== e.currentTarget) return;
    const b = boxes.get(id);
    if (!b) return;
    const step = e.shiftKey ? NUDGE * 5 : NUDGE;
    let dx = 0, dy = 0;
    switch (e.key) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dy = -step; break;
      case 'ArrowDown': dy = step; break;
      case 'Enter': e.preventDefault(); onActivateNode(id); return;
      case 'c': case 'C': e.preventDefault(); onConnectButton(id); return;
      case 'e': case 'E': e.preventDefault(); cycleEdges(id); return;
      case 'Escape': if (connectFrom) { e.preventDefault(); setConnectFrom(null); } return;
      default: return;
    }
    e.preventDefault();
    const phase = nudgeActive.current ? 'move' : 'start';
    nudgeActive.current = true;
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => { nudgeActive.current = false; }, 800);
    onMoveNode(id, snap(b.x + dx, gridSnap), snap(b.y + dy, gridSnap), phase);
  }, [boxes, onActivateNode, onConnectButton, onMoveNode, gridSnap, connectFrom, cycleEdges]);

  // Delete a selected edge / zoom from the keyboard (grade UX-10).
  const onSurfaceKey = useCallback((e: ReactKeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedEdgeId && onDeleteEdge) {
      e.preventDefault();
      onDeleteEdge(selectedEdgeId);
      onAnnounce(labels.deletedEdge, 'polite');
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut(); }
  }, [selectedEdgeId, onDeleteEdge, onAnnounce, labels, zoomIn, zoomOut]);

  // Grade code-F6: a pointer edge-click moves focus into the surface so the
  // Delete key works immediately after selecting an edge.
  const selectEdgeFocused = useCallback((id: string) => {
    onSelectEdge(id);
    surfaceRef.current?.focus();
  }, [onSelectEdge]);

  const EDGES: Edge[] = ['top', 'right', 'bottom', 'left'];

  // The surface element is BOTH the graph's ref (focus, measurement, capture)
  // and the shared viewport's wrapper (wheel binding, pan geometry) — fan the
  // callback ref to both. wrapperProps is memoized, so this stays stable.
  const setSurfaceRef = useCallback((el: HTMLDivElement | null) => {
    surfaceRef.current = el;
    wrapperProps.ref(el);
  }, [wrapperProps]);

  return (
    // The surface is a labeled interactive canvas region: pan/drag are pointer
    // enhancements, and every DOCUMENT action has a keyboard path (node buttons
    // move/activate/connect; Delete removes the selected edge here). The rule
    // can't see those child-level alternatives.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={setSurfaceRef}
      className={`cv-graph${vp.panning ? ' is-panning' : vp.panReady ? ' is-pan-ready' : ''}`}
      role="group"
      aria-label={labels.surface}
      // Compose the graph's gesture handlers with the shared viewport's: the
      // graph owns node/connect drag + deselect; the viewport owns pan/pinch/
      // edge-scroll (down) and arrow-key pan (keydown). Space/middle pan is
      // captured before children via onPointerDownCapture.
      onPointerDownCapture={wrapperProps.onPointerDownCapture}
      onPointerDown={(e) => { wrapperProps.onPointerDown(e); onBgPointerDown(e); }}
      onPointerMove={(e) => { onPointerMove(e); wrapperProps.onPointerMove(e); }}
      onPointerUp={(e) => { endDrag(e); wrapperProps.onPointerUp(e); }}
      onPointerCancel={(e) => { endDrag(e); wrapperProps.onPointerCancel(e); }}
      onPointerEnter={wrapperProps.onPointerEnter}
      onPointerLeave={wrapperProps.onPointerLeave}
      tabIndex={-1}
      onKeyDown={(e) => { onSurfaceKey(e); onViewportKey(e); }}
    >
      {/* ADR 0337 P2b — the ruler: decorative measurement rails OUTSIDE the
          transform (so they never scale), tick positions derived from pan/zoom.
          aria-hidden — purely a spatial aid; the node buttons are the AT path. */}
      {nodes.length > 0 ? (
        <div className="cv-graph__ruler" aria-hidden="true">
          <div className="cv-graph__ruler-top">
            {rulerTicks(pan.x, zoom, surfaceSize.w).map((t) => (
              <span key={`x${t.coord}`} className="cv-graph__ruler-tick" style={{ insetInlineStart: `${t.pos}px` }}>{t.coord}</span>
            ))}
          </div>
          <div className="cv-graph__ruler-left">
            {rulerTicks(pan.y, zoom, surfaceSize.h).map((t) => (
              <span key={`y${t.coord}`} className="cv-graph__ruler-tick" style={{ insetBlockStart: `${t.pos}px` }}>{t.coord}</span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="cv-graph__transform" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <EdgeLayer
          boxes={boxes}
          edges={edges}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={selectEdgeFocused}
          preview={preview}
          width={extent.w}
          height={extent.h}
        />
        {nodes.map((n) => {
          const b = boxes.get(n.id)!;
          const selected = n.id === selectedNodeId;
          const isConnectSource = connectFrom === n.id;
          const connectLabel = connectFrom && !isConnectSource
            ? labels.connectTo.replace('{label}', n.label)
            : labels.connectFrom.replace('{label}', n.label);
          return (
            <div
              key={n.id}
              className={`cv-graph__node${selected ? ' cv-graph__node--sel' : ''}${isConnectSource ? ' cv-graph__node--connect-src' : ''}`}
              style={{ transform: `translate(${b.x}px, ${b.y}px)`, width: b.w, height: b.h }}
              aria-label={n.label}
              role="group"
              onPointerDown={(e) => onNodePointerDown(e, n.id)}
            >
              <div className="cv-graph__node-bar">
                {/* The node's keyboard owner is a real button, deliberately a
                    sibling of Connect/Add. The former `role=button` wrapper
                    contained those real buttons, an invalid nested-interactive
                    composite for assistive technology. */}
                <Button
                  variant="quiet"
                  type="button"
                  className="cv-graph__node-title"
                  tabIndex={0}
                  aria-pressed={selected}
                  onFocus={() => { if (!selected) onSelectNode(n.id); }}
                  onKeyDown={(e) => onNodeKey(e, n.id)}
                  onClick={(e) => { e.stopPropagation(); onSelectNode(n.id); }}
                >{n.label}</Button>
                {n.isHome ? <span className="chip chip--muted cv-graph__home">{labels.home}</span> : null}
                {connectable ? (
                  <Button
                    variant="quiet" size="sm" className="cv-graph__connect"
                    aria-label={connectLabel}
                    title={connectLabel}
                    onClick={(e) => { e.stopPropagation(); onConnectButton(n.id); }}
                  >
                    <LinkIcon size={13} aria-hidden />
                  </Button>
                ) : null}
                {selected && onAddConnected ? (
                  <Button
                    variant="quiet" size="sm" className="cv-graph__connect"
                    aria-label={labels.addConnected.replace('{label}', n.label)}
                    title={labels.addConnected.replace('{label}', n.label)}
                    onClick={(e) => { e.stopPropagation(); onAddConnected(n.id); }}
                  >
                    <PlusIcon size={13} aria-hidden />
                  </Button>
                ) : null}
              </div>
              {/* The body is a decorative live preview; the node's accessible name
                  is its label, and editing happens in the tree editor on activate,
                  so the rendered component text is hidden from assistive tech. */}
              <div className="cv-graph__node-body" aria-hidden>
                {liveIds.has(n.id) ? renderNode(n, { selected }) : <span className="cv-graph__node-ghost" />}
              </div>
              {/* Pointer connect handles — drag from a dot to another node. Keyboard
                  users use the Connect button above (the a11y-canonical path).
                  Derived-edge graphs (no onConnect) hide them UNLESS drag-to-
                  empty create (onAddConnected) still gives the drag meaning. */}
              {(connectable || onAddConnected) ? EDGES.map((side) => (
                // A pointer-only drag-connect handle; the keyboard path is the
                // aria-labeled Connect button above (WCAG 2.5.7 alternative), so
                // the handle is aria-hidden and carries only a pointer listener.
                <span
                  key={side}
                  className={`cv-graph__handle cv-graph__handle--${side}`}
                  aria-hidden
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    connectDrag.current = { from: n.id, sourceEdge: side, start: clientToCanvas(e.clientX, e.clientY, rect(), pan, zoom) };
                    surfaceRef.current?.setPointerCapture?.(e.pointerId);
                  }}
                />
              )) : null}
            </div>
          );
        })}
      </div>
      {nodes.length === 0 ? (
        <div className="cv-graph__empty"><p>{labels.empty}</p></div>
      ) : (
        <>
        {/* ADR 0337 P2b — the device-frame selector (render-only nodeSize
            override; ephemeral). Sits in the board's bottom bar beside zoom. */}
        {deviceFrames && deviceFrames.length > 0 ? (
          // A native <select> carries its own keyboard + global focus ring; the
          // aria-label is its single accessible name (no wrapping <label> — that
          // would double-label with the aria-label, which wins anyway).
          <select className="btn-sm cv-graph__device-select" value={deviceId} aria-label={labels.deviceFrame} onChange={(e) => setDeviceId(e.target.value)}>
            {deviceFrames.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        ) : null}
        {/* §7.3 / CV-4 — pure-SVG minimap, shown once content exceeds ~1.5
            viewports: node blips + the visible-rect frame; click centers the
            board there (centerOn), Enter/Space fits. A layered aid — never
            load-bearing (the zoom cluster + fit cover everything). */}
        {(() => {
          const b = contentBounds(boxes.values());
          if (!b || surfaceSize.w <= 0) return null;
          const vw = surfaceSize.w, vh = surfaceSize.h;
          if ((b.maxX - b.minX) * zoom < vw * 1.5 && (b.maxY - b.minY) * zoom < vh * 1.5) return null;
          const W = 160, H = 100, pad = 6;
          const sc = Math.min((W - pad * 2) / Math.max(1, b.maxX - b.minX), (H - pad * 2) / Math.max(1, b.maxY - b.minY));
          const mx = (x: number): number => pad + (x - b.minX) * sc;
          const my = (y: number): number => pad + (y - b.minY) * sc;
          const vis = visibleCanvasRect(pan, zoom, vw, vh, 0);
          return (
            <svg
              className="cv-graph__minimap"
              width={W}
              height={H}
              role="button"
              tabIndex={0}
              aria-label={labels.minimap}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                centerOn({ x: b.minX + (e.clientX - r.left - pad) / sc, y: b.minY + (e.clientY - r.top - pad) / sc });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fit(); } }}
            >
              {[...boxes.values()].map((bx, i) => (
                <rect key={i} className="cv-graph__minimap-node" x={mx(bx.x)} y={my(bx.y)} width={Math.max(2, bx.w * sc)} height={Math.max(2, bx.h * sc)} />
              ))}
              <rect className="cv-graph__minimap-view" x={mx(vis.minX)} y={my(vis.minY)} width={Math.max(2, (vis.maxX - vis.minX) * sc)} height={Math.max(2, (vis.maxY - vis.minY) * sc)} />
            </svg>
          );
        })()}
        {/* §7.3 / CV-3 — the ONE shared zoom cluster (bottom-right) replaces
            the ADR 0337 P2 bespoke zoom bar. Fit semantics stay graph-owned
            (fitBounds at the ≤1:1 clamp). */}
        <ZoomCluster
          percent={percent}
          zoomIn={zoomIn}
          zoomOut={zoomOut}
          zoomToPercent={zoomToPercent}
          onFit={fit}
          zoomInDisabled={zoom >= GRAPH_ZOOM_LIMITS.max}
          zoomOutDisabled={zoom <= GRAPH_ZOOM_LIMITS.min}
        />
        </>
      )}
      {connectFrom ? (
        <div className="cv-graph__connect-bar" role="status">
          <span>{labels.connectArmed.replace('{label}', nodes.find((x) => x.id === connectFrom)?.label ?? connectFrom)}</span>
          <Button variant="quiet" size="sm" onClick={() => setConnectFrom(null)}>
            <XIcon size={13} aria-hidden /> {labels.cancelConnect}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
