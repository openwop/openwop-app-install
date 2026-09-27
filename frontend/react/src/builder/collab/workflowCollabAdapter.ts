/**
 * ADR 0481 P3 (ADR 0364 Phase 3) — the LIVE builder-store ⇄ Yjs binding
 * adapter. While a workflow room is live:
 *
 *  - builder mutations flow INTO the binding: a store subscription watches the
 *    room-carried slices (nodes/edges/name/defaultInputs/inputSchema) and
 *    pushes the whole slice through `binding.set` on a ~300 ms trailing
 *    debounce. One debounced flush = one gesture-scale undo step (`set` closes
 *    the open step; `replace` alone would fold the entire session into a
 *    single ⌘Z). The adapter NEVER order-normalizes: arrays are pushed in
 *    store order verbatim (the workflowCollabShape known limitation — sorting
 *    before commit would turn every flush into an identity-losing reorder;
 *    pinned by the adapter round-trip test).
 *  - remote (and per-user undo/redo) transactions materialize INTO the store
 *    via `onDocChanged`, guarded against echo (the store subscription skips
 *    while a remote doc is being applied).
 *  - the FE-serialized WorkflowDefinition is written to the `definition` root
 *    scalar on a ~1.5 s debounce — the server derive vehicle (ADR 0481 §3).
 *    A graph that does not serialize (empty/cycle/orphan) keeps the previous
 *    scalar: stale beats invalid, matching the derive's validate-gate SKIP.
 *  - the backend autosave is SUSPENDED on attach (`collabLive` + cancel of any
 *    pending debounce — the room is the head's only writer, ADR 0481 §4) and
 *    resumed with ONE catch-up sync on destroy; the solo snapshot undo stacks
 *    are cleared on attach AND destroy (the M4 class: a pre-room snapshot
 *    restoring over post-room state).
 *
 * Transport-independent by construction (tests drive it with a local Y.Doc):
 * the binding is injected; this module never touches yjs at runtime (the
 * type-only import erases — the collabDocBinding bundle rule).
 */
import type { CollabDocBinding } from '../../canvas/collabDocBinding.js';
import { useBuilderStore, cancelPendingBackendSync } from '../store/builderStore.js';
import { workflowCollabSlice } from './workflowCollabShape.js';
import { serializeWithIdMap } from '../schema/serialize.js';
import type { BuilderEdge, BuilderNode } from '../schema/workflow.js';

export const COLLAB_PUSH_DEBOUNCE_MS = 300;
export const COLLAB_DEFINITION_DEBOUNCE_MS = 1500;

type Dict = Record<string, unknown>;

export interface WorkflowCollabAdapter {
  /** Per-user Y.UndoManager verbs — BuilderShell routes ⌘Z here while live. */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  onStackChanged(cb: () => void): () => void;
  /** Leave: final flush, resume autosave (one catch-up sync), clear stacks. */
  destroy(): void;
}

/** Serialize the current store snapshot for the `definition` root scalar.
 *  Null when the graph is not serializable — the caller keeps the previous
 *  value (stale beats invalid). */
function serializeDefinitionScalar(): string | null {
  try {
    const snap = useBuilderStore.getState().snapshot();
    return JSON.stringify(serializeWithIdMap(snap).definition);
  } catch {
    return null;
  }
}

/** The room doc from the store, in STORE ORDER (no normalization), plus the
 *  carried `definition` scalar (commit() deletes absent root keys, so every
 *  flush must include it once known). */
function buildRoomDoc(definition: string | undefined): Dict {
  const s = useBuilderStore.getState();
  // ADR 0524 — allowlist #8. Widening `WORKFLOW_COLLAB_FIELDS` alone was INERT:
  // `workflowCollabSlice` skips `undefined`, so a field never passed in here can
  // never reach the room, and `commit()` DELETES absent root keys — this writer
  // would actively erase a `variables` key any other writer added. The field
  // list and the two ends of the adapter are three hand-maintained lists for one
  // contract, which is this ADR's own root cause reproduced one layer in.
  const slice = workflowCollabSlice({
    name: s.name,
    nodes: s.nodes,
    edges: s.edges,
    defaultInputs: s.defaultInputs,
    inputSchema: s.inputSchema,
    variables: s.variables,
    configurableSchema: s.configurableSchema,
  });
  return definition !== undefined ? { ...slice, definition } : slice;
}

/** Materialize a room doc into the store (no persist — the room is the
 *  authority while live). Selection self-prunes to surviving ids. */
function applyRemoteDoc(doc: Dict): void {
  const nodes = Array.isArray(doc['nodes']) ? (doc['nodes'] as BuilderNode[]) : [];
  const edges = Array.isArray(doc['edges']) ? (doc['edges'] as BuilderEdge[]) : [];
  const s = useBuilderStore.getState();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeIds = new Set(edges.map((e) => e.id));
  const selectedNodeIds = s.selectedNodeIds.filter((id) => nodeIds.has(id));
  useBuilderStore.setState({
    nodes,
    edges,
    selectedNodeIds,
    selectedNodeId: selectedNodeIds.length === 1 ? selectedNodeIds[0]! : null,
    selectedEdgeId: s.selectedEdgeId && edgeIds.has(s.selectedEdgeId) ? s.selectedEdgeId : null,
    ...(typeof doc['name'] === 'string' ? { name: doc['name'] } : {}),
    ...(typeof doc['defaultInputs'] === 'string' ? { defaultInputs: doc['defaultInputs'] } : {}),
    ...(typeof doc['inputSchema'] === 'string' ? { inputSchema: doc['inputSchema'] } : {}),
    // Read back what the writer above now sends, or a peer's edits arrive and
    // are immediately discarded.
    ...(doc['variables'] !== undefined ? { variables: doc['variables'] } : {}),
    ...(doc['configurableSchema'] !== undefined ? { configurableSchema: doc['configurableSchema'] } : {}),
  });
}

/** code-H1 (FE half) — a room doc with no nodes, no edges, and no name is a
 *  seedless blank, not a workflow: materializing it would wipe the joiner's
 *  real graph. */
function isBlankRoomDoc(doc: Dict): boolean {
  const nodes = Array.isArray(doc['nodes']) ? doc['nodes'] : [];
  const edges = Array.isArray(doc['edges']) ? doc['edges'] : [];
  const name = typeof doc['name'] === 'string' ? doc['name'] : '';
  return nodes.length === 0 && edges.length === 0 && name === '';
}

export function attachWorkflowCollabAdapter(
  binding: CollabDocBinding<Dict>,
  opts: { seed: boolean; pushDebounceMs?: number; definitionDebounceMs?: number },
): WorkflowCollabAdapter | null {
  const pushMs = opts.pushDebounceMs ?? COLLAB_PUSH_DEBOUNCE_MS;
  const defMs = opts.definitionDebounceMs ?? COLLAB_DEFINITION_DEBOUNCE_MS;
  /** Guards the final flush/sync against a workflow swapped under the session
   *  (navigation loads the next workflow BEFORE the effect cleanup runs —
   *  flushing then would write the new workflow's graph into the old room). */
  const attachedWorkflowId = useBuilderStore.getState().workflowId;
  const storeMatches = (): boolean => useBuilderStore.getState().workflowId === attachedWorkflowId;

  // code-H1 (FE half) — joiner blank-wipe bailout, BEFORE any join duty runs:
  // the seeder election said someone else seeded (`seed:false`), yet the
  // synced room is empty. Materializing that blank over the user's loaded
  // workflow would destroy real work; the session must fail instead. The
  // caller treats `null` as `status:'failed'` and destroys without applying.
  if (!opts.seed && isBlankRoomDoc(binding.current())) return null;

  // Join duties (ADR 0481 §4/§5): suspend the debounced backend autosave and
  // clear the solo snapshot stacks. A pre-existing REFUSED-save banner is
  // reset to 'pending' (ux-H1): while the room is live the head saves through
  // the session — a stale failure banner would directly contradict the Live
  // chip beside it.
  cancelPendingBackendSync();
  useBuilderStore.setState({
    collabLive: true,
    past: [],
    future: [],
    ...(useBuilderStore.getState().syncState === 'failed' ? { syncState: 'pending' as const } : {}),
  });

  let applyingRemote = false;
  let disposed = false;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let defTimer: ReturnType<typeof setTimeout> | null = null;
  let lastDefinition: string | undefined;

  if (opts.seed) {
    // Election winner: the loaded builder store snapshot seeds the room.
    lastDefinition = serializeDefinitionScalar() ?? undefined;
    binding.seed(buildRoomDoc(lastDefinition));
  } else {
    // Joiner: the room is the authority — take its state.
    const room = binding.current();
    lastDefinition = typeof room['definition'] === 'string' ? room['definition'] : undefined;
    applyingRemote = true;
    try {
      applyRemoteDoc(room);
    } finally {
      applyingRemote = false;
    }
  }

  const flushGraph = (): void => {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    if (disposed || !storeMatches()) return;
    binding.set(buildRoomDoc(lastDefinition));
  };
  const flushDefinition = (): void => {
    if (defTimer) {
      clearTimeout(defTimer);
      defTimer = null;
    }
    if (disposed || !storeMatches()) return;
    const next = serializeDefinitionScalar();
    if (next !== null && next !== lastDefinition) {
      lastDefinition = next;
      // `replace`: the scalar trails the graph writes it derives from — it
      // coalesces into the open undo step instead of minting its own.
      binding.replace(buildRoomDoc(lastDefinition));
    }
  };

  const unsubscribe = useBuilderStore.subscribe((s, prev) => {
    if (applyingRemote || disposed) return;
    const changed =
      s.nodes !== prev.nodes ||
      s.edges !== prev.edges ||
      s.name !== prev.name ||
      s.defaultInputs !== prev.defaultInputs ||
      s.inputSchema !== prev.inputSchema;
    if (!changed) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(flushGraph, pushMs);
    if (defTimer) clearTimeout(defTimer);
    defTimer = setTimeout(flushDefinition, defMs);
  });

  const offDoc = binding.onDocChanged((doc) => {
    // code-M5 — same wrong-workflow guard as the flush paths: navigation can
    // load the next workflow before the effect cleanup runs, and a late remote
    // transaction must not materialize the OLD room into the NEW store.
    if (disposed || !storeMatches()) return;
    // Remote peers (or this user's Y undo/redo) landed a transaction —
    // materialize without echoing back through the store subscription.
    if (typeof doc['definition'] === 'string') lastDefinition = doc['definition'];
    applyingRemote = true;
    try {
      applyRemoteDoc(doc);
    } finally {
      applyingRemote = false;
    }
  });

  // ux-L2 — a tab close / bfcache navigation mid-debounce would silently drop
  // the last gesture from the room (whose teardown derive persists the head).
  // `pagehide` is the last reliable moment to flush; the handlers no-op when
  // nothing is pending (flush guards disposed + storeMatches internally).
  const onPageHide = (): void => {
    if (pushTimer) flushGraph();
    if (defTimer) flushDefinition();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

  return {
    undo: () => binding.undo(),
    redo: () => binding.redo(),
    canUndo: () => binding.canUndo(),
    canRedo: () => binding.canRedo(),
    onStackChanged: (cb) => binding.onStackChanged(cb),
    destroy(): void {
      if (disposed) return;
      unsubscribe();
      offDoc();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      // Final flush so the room (whose teardown force-derives, ADR 0481 §4)
      // holds the last local edits + a fresh definition scalar.
      const pendingPush = pushTimer !== null;
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
      if (defTimer) {
        clearTimeout(defTimer);
        defTimer = null;
      }
      // code-M4 — try/finally: the leave duties below are UNCONDITIONAL. If
      // the final flush throws (a torn-down Y.Doc, a binding bug), leaving
      // `collabLive:true` would suspend the backend autosave FOREVER — every
      // later edit silently stops reaching the server.
      try {
        if (storeMatches()) {
          if (pendingPush) binding.set(buildRoomDoc(lastDefinition));
          const next = serializeDefinitionScalar();
          if (next !== null && next !== lastDefinition) {
            lastDefinition = next;
            binding.replace(buildRoomDoc(lastDefinition));
          }
        }
      } finally {
        disposed = true;
        // Leave duties: clear the in-room undo residue, resume the autosave and
        // land ONE catch-up sync so the REST head is truthful immediately.
        useBuilderStore.setState({ collabLive: false, past: [], future: [], collabPeers: null });
        if (storeMatches()) useBuilderStore.getState().persist();
      }
    },
  };
}
