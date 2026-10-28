/**
 * ADR 0960 D3 — read-only builder store instances, for showing a run's graph
 * outside the builder. Kept out of `builderStore.ts` so the builder's entry
 * path does not carry it (it loads only with the lazy run view).
 */
import { createStore, type StoreApi } from 'zustand';
import type { BuilderEdge, BuilderNode } from '../schema/workflow.js';
import { builderStoreInitializer, type BuilderState } from './builderStore.js';

/** Every action that writes the graph, the draft or the module-level sync state.
 *  A read-only instance replaces each with a no-op, so a view can never reach
 *  the user's draft, local storage or the backend write-through (ADR 0960 D3). */
export const MUTATING_ACTIONS = [
  'loadFromSaved', 'setName', 'setDefaultInputs', 'setInputSchema', 'addNode', 'addConnectedNode', 'cloneNodes',
  'pasteNodes', 'alignNodes', 'updateNode', 'moveNodes', 'removeNode', 'removeNodes', 'addEdge', 'updateEdge',
  'applyEditOps', 'removeEdge', 'undo', 'redo', 'clearTransient', 'persist', 'setDebugSession', 'setDebugPin',
  'removeDebugPin', 'setFailureHeat', 'setCollabLive', 'setBaseRevision', 'setCollabPeers',
] as const satisfies ReadonlyArray<keyof BuilderState>;

/** Actions a read-only view may call: selection, focus nonces, the overlay
 *  (pure state) and `snapshot` (a read). Every OTHER function on the store must be
 *  in MUTATING_ACTIONS — a test enforces the partition, so a new builder action
 *  cannot reach a read-only instance un-reviewed. */
export const READ_ONLY_SAFE_ACTIONS = [
  'selectNode', 'setSelection', 'selectEdge', 'requestConnectionsFocus', 'requestPaletteSearchFocus',
  'snapshot', 'startOverlay', 'applyRunEvent', 'clearOverlay',
] as const satisfies ReadonlyArray<keyof BuilderState>;

/**
 * ADR 0960 D3 — an isolated, read-only builder store for showing a run's graph
 * outside the builder. It shares the builder's shape and canvas, never its
 * state: graph writes are no-ops and nothing reaches the draft, local storage or
 * the backend. Load it with `loadReadOnlyGraph`, paint it with `startOverlay` /
 * `applyRunEvent` (pure state updates).
 */
export function createReadOnlyBuilderStore(): StoreApi<BuilderState> {
  const store = createStore<BuilderState>(builderStoreInitializer);
  const noop = (): void => undefined;
  const patch: Partial<Record<(typeof MUTATING_ACTIONS)[number], unknown>> = {};
  for (const k of MUTATING_ACTIONS) patch[k] = noop;
  store.setState({ ...(patch as Partial<BuilderState>), readOnly: true, syncState: 'synced' });
  return store;
}

/** Load a graph into a read-only store (a pure state set: no history, no
 *  persistence, no module-level sync bookkeeping). */
export function loadReadOnlyGraph(store: StoreApi<BuilderState>, graph: { workflowId: string; name: string; nodes: BuilderNode[]; edges: BuilderEdge[] }): void {
  store.setState({
    workflowId: graph.workflowId,
    name: graph.name,
    nodes: graph.nodes.map((n) => ({ ...n, position: { ...n.position }, config: { ...n.config } })),
    edges: graph.edges.map((e) => ({ ...e })),
    selectedNodeId: null, selectedNodeIds: [], selectedEdgeId: null, past: [], future: [], overlay: null,
  });
}
