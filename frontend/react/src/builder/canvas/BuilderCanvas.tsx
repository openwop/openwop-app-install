/**
 * xyflow canvas wired to the zustand builder store.
 *
 * - Converts BuilderNode/BuilderEdge → xyflow Node/Edge on render.
 * - Translates xyflow events (move, select, connect, delete) → store
 *   mutations.
 * - Handles HTML5 DnD from the palette: dataTransfer key
 *   "application/openwop-node-kind" carries the kind string.
 * - `isValidConnection` runs port-type compatibility before accepting
 *   an edge.
 * - During a live-run overlay, per-node status is fed into node data so
 *   BaseNode paints execution state.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  useReactFlow,
  type FinalConnectionState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useBuilderStore } from '../store/builderStore.js';
import { catalogEntry, useCatalog } from '../palette/catalogRegistry.js';
import { isPortCompatible } from './portCompatibility.js';
import type { PortType } from '../schema/workflow.js';
import { BaseNode } from './nodes/BaseNode.js';
import { Notice } from '../../ui/Notice.js';
import { InfoIcon, XIcon } from '../../ui/icons/index.js';
import { useTranslation } from 'react-i18next';
import { ZoomCluster } from '../../canvas/ZoomCluster.js';
import { usePublishViewportHandle } from '../../canvas/viewportHandle.js';

const NODE_TYPES = { builder: BaseNode };
export const PALETTE_MIME = 'application/openwop-node-kind';
// Copy/paste/duplicate moved to builder/nodeClipboard.ts (CV-2 — driven by
// the shell's shortcut registry, not an ad-hoc keydown listener here).

export function BuilderCanvas() {
  return (
    <ReactFlowProvider>
      <BuilderCanvasInner />
    </ReactFlowProvider>
  );
}

function BuilderCanvasInner() {
  const { t } = useTranslation('builder');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { screenToFlowPosition } = useReactFlow();

  const builderNodes = useBuilderStore((s) => s.nodes);
  const builderEdges = useBuilderStore((s) => s.edges);
  const selectedNodeIds = useBuilderStore((s) => s.selectedNodeIds);
  const overlay = useBuilderStore((s) => s.overlay);
  const debugSession = useBuilderStore((s) => s.debugSession);
  const failureHeat = useBuilderStore((s) => s.failureHeat);
  const failureHeatMode = useBuilderStore((s) => s.failureHeatMode);
  const collabPeers = useBuilderStore((s) => s.collabPeers);
  const addNode = useBuilderStore((s) => s.addNode);
  const moveNodes = useBuilderStore((s) => s.moveNodes);
  const removeNodes = useBuilderStore((s) => s.removeNodes);
  const addEdge = useBuilderStore((s) => s.addEdge);
  const removeEdge = useBuilderStore((s) => s.removeEdge);
  const setSelection = useBuilderStore((s) => s.setSelection);
  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

  // §7.3 / CV-3 residue — the shared ZoomCluster replaces xyflow <Controls>;
  // zoom math delegates to xyflow's own viewport (one owner per surface).
  const { zoom } = useViewport();
  const rf = useReactFlow();
  const zoomHandle = useMemo(() => ({
    fit: () => void rf.fitView(),
    zoomToPercent: (pct: number) => void rf.zoomTo(pct / 100),
  }), [rf]);
  usePublishViewportHandle(zoomHandle);

  // §7.4 / CV-5 — keyboard-connect parity (the GraphSurface pattern on
  // xyflow): arm a source from the selected node's chrome; every node with a
  // type-compatible input then offers "Connect to" (validated port pair).
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  /** First type-compatible (output, input) port pair from source → target. */
  const compatiblePair = useCallback((sourceId: string, targetId: string): { sourcePort: string; targetPort: string } | null => {
    if (sourceId === targetId) return null;
    const sourceNode = builderNodes.find((n) => n.id === sourceId);
    const targetNode = builderNodes.find((n) => n.id === targetId);
    const sourceEntry = sourceNode ? catalogEntry(sourceNode.kind) : undefined;
    const targetEntry = targetNode ? catalogEntry(targetNode.kind) : undefined;
    if (!sourceEntry || !targetEntry) return null;
    for (const out of sourceEntry.outputs) {
      for (const inp of targetEntry.inputs) {
        if (isPortCompatible(out.type, inp.type)) return { sourcePort: out.name, targetPort: inp.name };
      }
    }
    return null;
  }, [builderNodes]);
  const connectTo = useCallback((targetId: string) => {
    if (!connectFrom) return;
    const pair = compatiblePair(connectFrom, targetId);
    if (!pair) return;
    addEdge({ source: connectFrom, sourcePort: pair.sourcePort, target: targetId, targetPort: pair.targetPort });
    setConnectFrom(null);
  }, [connectFrom, compatiblePair, addEdge]);

  // §7.4 / CV-10 — link-drag-search (the Blueprints/Blender/n8n convergent
  // gesture): dropping a connection on EMPTY canvas opens a picker at the
  // drop point, filtered to kinds with an input compatible with the dragged
  // output port; picking one creates + auto-wires the node.
  const catalog = useCatalog();
  const [dropPicker, setDropPicker] = useState<{
    x: number; y: number; flow: { x: number; y: number };
    sourceId: string; sourcePort: string; sourceType: PortType; query: string;
  } | null>(null);
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid) return; // a real connection landed on a handle
    if (!state.fromNode || !state.fromHandle || state.fromHandle.type !== 'source') return;
    const targetEl = event.target instanceof HTMLElement ? event.target : null;
    if (!targetEl?.classList.contains('react-flow__pane')) return; // only empty canvas
    const client = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!client) return;
    const sourceNode = useBuilderStore.getState().nodes.find((n) => n.id === state.fromNode?.id);
    const sourceEntry = sourceNode ? catalogEntry(sourceNode.kind) : undefined;
    const portName = state.fromHandle.id ?? sourceEntry?.outputs[0]?.name ?? '';
    const sourceType = sourceEntry?.outputs.find((p) => p.name === portName)?.type;
    if (!sourceType) return;
    const wrap = wrapperRef.current?.getBoundingClientRect();
    setDropPicker({
      x: client.clientX - (wrap?.left ?? 0),
      y: client.clientY - (wrap?.top ?? 0),
      flow: screenToFlowPosition({ x: client.clientX, y: client.clientY }),
      sourceId: state.fromNode.id,
      sourcePort: portName,
      sourceType,
      query: '',
    });
  }, [screenToFlowPosition]);
  const pickerMatches = useMemo(() => {
    if (!dropPicker) return [];
    const q = dropPicker.query.trim().toLowerCase();
    return catalog.filter((e) => {
      if (e.clientOnly) return false;
      const inp = e.inputs.find((p) => isPortCompatible(dropPicker.sourceType, p.type));
      if (!inp) return false;
      return !q || e.label.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q);
    });
  }, [catalog, dropPicker]);
  // No silent caps (§7 canon / DESIGN.md "no silent truncation"): show 12,
  // SAY how many more the search would reveal.
  const pickerKinds = pickerMatches.slice(0, 12);
  const pickerOverflow = pickerMatches.length - pickerKinds.length;
  // Grade-pass CVP-2 — outside-pointerdown dismisses the drop picker (Esc +
  // Cancel already exist; this is the pointer parity path). Capture phase so
  // a click that starts a canvas gesture also closes it.
  const dropPickerRef = useRef<HTMLDivElement | null>(null);
  const dropPickerOpen = dropPicker != null;
  useEffect(() => {
    if (!dropPickerOpen) return undefined;
    const onDown = (e: PointerEvent): void => {
      const el = dropPickerRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setDropPicker(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [dropPickerOpen]);

  const pickKind = useCallback((kind: string) => {
    if (!dropPicker) return;
    const st = useBuilderStore.getState();
    const targetEntry = catalogEntry(kind);
    const targetPort = targetEntry?.inputs.find((p) => isPortCompatible(dropPicker.sourceType, p.type))?.name;
    // One gesture = ONE undo entry: the atomic create wires node + edge in a
    // single history snapshot (addNode + addEdge cost two ⌘Z — CT-CV-3).
    if (targetPort) st.addConnectedNode(kind, dropPicker.flow, { source: dropPicker.sourceId, sourcePort: dropPicker.sourcePort, targetPort });
    else st.addNode(kind, dropPicker.flow);
    setDropPicker(null);
  }, [dropPicker]);

  // Measured node dimensions, captured from xyflow's `dimensions` changes (see
  // onNodesChange). We feed these back onto the controlled nodes as width/height
  // so downstream consumers that read node size — notably the <MiniMap>, which
  // draws each blip from `measured?.width ?? width` — have dimensions to draw.
  // Without this, the controlled nodes carry no size and the minimap renders an
  // empty viewport box with no node blips.
  const [nodeDims, setNodeDims] = useState<Record<string, { width: number; height: number }>>({});

  // ADR 0481 D5 — node id → peers whose selection includes it (quiet markers;
  // order follows the stable clientId sort from the presence hook).
  const peersByNode = useMemo(() => {
    if (!collabPeers || collabPeers.length === 0) return null;
    // clientId rides along (ux-H3): it is the stable per-SESSION identity the
    // marker list keys on — two peers can share a display name.
    const map = new Map<string, { clientId: number; name: string; color: string }[]>();
    for (const p of collabPeers) {
      for (const id of p.selectedNodeIds) {
        const arr = map.get(id) ?? [];
        arr.push({ clientId: p.clientId, name: p.name, color: p.color });
        map.set(id, arr);
      }
    }
    return map;
  }, [collabPeers]);

  const rfNodes: Node[] = useMemo(
    () =>
      builderNodes.map((n) => ({
        id: n.id,
        type: 'builder',
        position: n.position,
        data: {
          kind: n.kind,
          name: n.name,
          runStatus: overlay?.nodeStatus[n.id],
          // ADR 0475 — the debug-pin badge (a pinned node is visibly pinned).
          pinned: debugSession?.pins[n.id] !== undefined,
          // ADR 0476 — failure-heatmap count for this node (undefined = off/none).
          // ADR 0482 §6 — the same slice in 'cost' mode paints per-node USD
          // (the latest terminal run's costByNode stamp) instead of counts.
          failureCount: failureHeatMode === 'failures' ? failureHeat?.[n.id] : undefined,
          costUsd: failureHeatMode === 'cost' ? failureHeat?.[n.id] : undefined,
          // ADR 0481 D5 — live-session peers with this node selected.
          peers: peersByNode?.get(n.id),
          // §7.4 / CV-5 — the keyboard-connect affordance state.
          connect: {
            armed: connectFrom != null,
            isSource: connectFrom === n.id,
            canTarget: connectFrom != null && connectFrom !== n.id && compatiblePair(connectFrom, n.id) != null,
            onArm: () => setConnectFrom(n.id),
            onTarget: () => connectTo(n.id),
          },
        },
        selected: selectedSet.has(n.id),
        ...((d) => (d ? { width: d.width, height: d.height } : {}))(nodeDims[n.id]),
      })),
    [builderNodes, selectedSet, overlay, debugSession, failureHeat, failureHeatMode, peersByNode, nodeDims, connectFrom, compatiblePair, connectTo],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      builderEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourcePort,
        targetHandle: e.targetPort,
        // Liveness: an edge whose target node is currently running carries the
        // marching-dash "data in flight" treatment (CSS .edge-running, §6).
        ...(overlay?.nodeStatus[e.target] === 'running' ? { className: 'edge-running' } : {}),
      })),
    [builderEdges, overlay],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Drive position + selection from xyflow events. Batch position and
      // remove changes so one gesture (group drag, group delete) is one
      // undo entry rather than one-per-node.
      const applied = applyNodeChanges(changes, rfNodes);
      let selectionChanged = false;
      const moves: { id: string; position: { x: number; y: number } }[] = [];
      const removals: string[] = [];
      const dimUpdates: Record<string, { width: number; height: number }> = {};
      for (const change of changes) {
        if (change.type === 'position' && change.position && !change.dragging) {
          moves.push({ id: change.id, position: change.position });
        }
        if (change.type === 'select') selectionChanged = true;
        if (change.type === 'remove') removals.push(change.id);
        // Capture xyflow's measured dimensions so the minimap (and any size-
        // dependent consumer) has a box to draw. Stored, not pushed to the
        // builder store — it's a render concern, not part of the saved workflow.
        if (change.type === 'dimensions' && change.dimensions) {
          dimUpdates[change.id] = { width: change.dimensions.width, height: change.dimensions.height };
        }
      }
      if (moves.length > 0) moveNodes(moves);
      if (removals.length > 0) removeNodes(removals);
      if (Object.keys(dimUpdates).length > 0) {
        // Guard against a re-render loop: only update when a value actually
        // changed (feeding width/height back recomputes rfNodes, which could
        // otherwise re-fire identical dimensions every render).
        setNodeDims((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [id, d] of Object.entries(dimUpdates)) {
            const p = prev[id];
            if (!p || p.width !== d.width || p.height !== d.height) {
              next[id] = d;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
      // Derive the FULL multi-selection from xyflow's applied state — this
      // handles single click, shift-click (add/remove), and box-select
      // (multiple select changes in one batch) uniformly.
      if (selectionChanged) {
        setSelection(applied.filter((n) => n.selected).map((n) => n.id));
      }
    },
    [rfNodes, moveNodes, removeNodes, setSelection],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') {
          removeEdge(change.id);
        }
      }
    },
    [removeEdge],
  );

  const selectEdge = useBuilderStore((s) => s.selectEdge);
  const onEdgeClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      selectEdge(edge.id);
    },
    [selectEdge],
  );
  const onPaneClick = useCallback(() => {
    setSelection([]);
    selectEdge(null);
  }, [setSelection, selectEdge]);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return;
      addEdge({
        source: conn.source,
        target: conn.target,
        sourcePort: conn.sourceHandle,
        targetPort: conn.targetHandle,
      });
    },
    [addEdge],
  );

  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const sourceNode = builderNodes.find((n) => n.id === conn.source);
      const targetNode = builderNodes.find((n) => n.id === conn.target);
      if (!sourceNode || !targetNode) return false;
      if (sourceNode.id === targetNode.id) return false;
      const sourceEntry = catalogEntry(sourceNode.kind);
      const targetEntry = catalogEntry(targetNode.kind);
      if (!sourceEntry || !targetEntry) return false;
      const sourcePort = sourceEntry.outputs.find((p) => p.name === conn.sourceHandle);
      const targetPort = targetEntry.inputs.find((p) => p.name === conn.targetHandle);
      if (!sourcePort || !targetPort) return false;
      return isPortCompatible(sourcePort.type, targetPort.type);
    },
    [builderNodes],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(PALETTE_MIME);
      if (!kind) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(kind, position);
    },
    [addNode, screenToFlowPosition],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // Color each minimap blip with its node-kind accent so the overview is a
  // legible mini-map of the workflow (default xyflow node color is invisible
  // against the themed panel). Reads `data.kind` → catalog accent (a token
  // var), falling back to a neutral ink for unknown kinds.
  const miniMapNodeColor = useCallback((node: Node): string => {
    const kind = node.data?.['kind'];
    const accent = typeof kind === 'string' ? catalogEntry(kind)?.accent : undefined;
    return accent ?? 'var(--ink-2)';
  }, []);

  return (
    // The canvas is a labeled drop-zone group: `onDrop`/`onDragOver` accept
    // nodes dragged from the palette, which is intrinsic to this container.
    // The inner xyflow surface owns node-level keyboard/pointer interaction;
    // this wrapper is a grouping landmark, not a control. Same justified
    // exception as WorkflowProgressPanel's Escape-scoped <aside>.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={wrapperRef}
      className="builder-canvas"
      role="group"
      aria-label={t('canvasAria')}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      {/* RUN-1 — honest small-screen heads-up; the canvas still renders. CSS gates
          its visibility to narrow viewports (.builder-canvas-mobilehint). */}
      <div className="builder-canvas-mobilehint">
        <Notice variant="info">{t('canvasMobileHint')}</Notice>
      </div>
      {/* RUN-3 — a discoverable keyboard-shortcut affordance. */}
      <span className="builder-canvas-help" title={t('canvasShortcuts')}>
        <InfoIcon size={13} aria-hidden /> {t('canvasKeyboardShortcuts')}
      </span>
      {/* E.1 — selected-node affordance for the BLD-1 keyboard-connect path:
          scrolls + focuses the Inspector's Connections form (store nonce). */}
      {selectedNodeIds.length === 1 && (
        <button
          type="button"
          className="builder-canvas-help builder-canvas-connect"
          onClick={() => useBuilderStore.getState().requestConnectionsFocus()}
        >
          {t('canvasConnectHint')}
        </button>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        fitView
        snapToGrid
        snapGrid={[20, 20]}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          nodeColor={miniMapNodeColor}
          nodeStrokeColor={miniMapNodeColor}
          nodeStrokeWidth={2}
          nodeBorderRadius={2}
        />
      </ReactFlow>
      {/* §7.3 / CV-3 — the ONE shared zoom cluster (replaces xyflow Controls);
          zoom math stays xyflow's (rf.zoomIn/zoomTo/fitView). */}
      <ZoomCluster
        percent={Math.round(zoom * 100)}
        zoomIn={() => void rf.zoomIn()}
        zoomOut={() => void rf.zoomOut()}
        zoomToPercent={(pct) => void rf.zoomTo(pct / 100)}
        onFit={() => void rf.fitView()}
        zoomInDisabled={zoom >= 2}
        zoomOutDisabled={zoom <= 0.5}
      />
      {/* §7.4 / CV-10 — the link-drag-search picker at the drop point. */}
      {dropPicker ? (
        // Esc-on-container is the APG dialog dismissal pattern; the rule's
        // non-interactive list predates role="dialog" keyboard handling.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
        <div
          ref={dropPickerRef}
          className="builder-drop-picker"
          role="dialog"
          aria-label={t('dropPickerLabel')}
          style={{ left: Math.min(dropPicker.x, (wrapperRef.current?.clientWidth ?? 600) - 280), top: Math.min(dropPicker.y, (wrapperRef.current?.clientHeight ?? 400) - 240) }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDropPicker(null); } }}
        >
          <input
            autoFocus
            type="search"
            className="ui-input builder-drop-picker__search"
            placeholder={t('dropPickerSearch')}
            aria-label={t('dropPickerSearch')}
            value={dropPicker.query}
            onChange={(e) => setDropPicker((p) => (p ? { ...p, query: e.target.value } : p))}
          />
          <ul className="builder-drop-picker__list">
            {pickerKinds.length === 0 ? <li className="builder-drop-picker__empty">{t('dropPickerEmpty')}</li> : null}
            {pickerKinds.map((e) => (
              <li key={e.kind}>
                <button type="button" className="builder-drop-picker__item" onClick={() => pickKind(e.kind)}>
                  <span className="builder-node-badge" style={{ background: e.accent }}>{e.badge}</span>
                  <span>{e.label}</span>
                </button>
              </li>
            ))}
            {pickerOverflow > 0 ? <li className="builder-drop-picker__empty">{t('dropPickerMore', { count: pickerOverflow })}</li> : null}
          </ul>
          <Button variant="quiet" size="sm" onClick={() => setDropPicker(null)}>{t('cancelConnect')}</Button>
        </div>
      ) : null}
      {/* §7.4 / CV-5 — the armed-connect status bar (the GraphSurface
          pattern): announces the armed source, offers cancel. */}
      {connectFrom ? (
        <div className="builder-connect-bar" role="status">
          <span>{t('connectArmed', { name: builderNodes.find((n) => n.id === connectFrom)?.name ?? connectFrom })}</span>
          <Button variant="quiet" size="sm" onClick={() => setConnectFrom(null)}>
            <XIcon size={13} aria-hidden /> {t('cancelConnect')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
