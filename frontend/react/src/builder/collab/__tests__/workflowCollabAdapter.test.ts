/**
 * ADR 0481 P3 — store⇄binding adapter pins (real Y.Docs, no network; the
 * workflowCollab.test.ts harness pattern). The load-bearing semantics:
 *
 *  - ROUND-TRIP ORDER: store snapshot → binding → materialize preserves the
 *    graph INCLUDING array order (the no-order-normalization pin — sorting
 *    before commit would turn every flush into an identity-losing reorder).
 *  - AUTOSAVE SUSPENSION: while `collabLive` the debounced backend autosave
 *    is a no-op; destroy() resumes it and lands exactly ONE catch-up sync.
 *  - DEFINITION SCALAR: the ~1.5 s debounced serializer writes valid JSON
 *    with the right workflowId to the `definition` root scalar; an
 *    unserializable graph keeps the previous value (stale beats invalid).
 *  - ECHO SAFETY: a remote transaction materializes into the store without
 *    bouncing back through the local push debounce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { createCollabDocBinding, type CollabDocBinding } from '../../../canvas/collabDocBinding.js';
import { WORKFLOW_COLLAB_SHAPE } from '../workflowCollabShape.js';
import { attachWorkflowCollabAdapter, type WorkflowCollabAdapter } from '../workflowCollabAdapter.js';
import { useBuilderStore } from '../../store/builderStore.js';
import type { BuilderEdge, BuilderNode, SavedWorkflow } from '../../schema/workflow.js';

vi.mock('../../persistence/backendStore.js', () => ({
  saveWorkflow: vi.fn(async () => ({})),
  loadWorkflow: vi.fn(async () => null),
}));
import { saveWorkflow as mockedSaveWorkflow } from '../../persistence/backendStore.js';

type Dict = Record<string, unknown>;

const node = (id: string, x = 0, y = 0): BuilderNode =>
  ({ id, kind: 'noop', name: `n-${id}`, position: { x, y }, config: {} });
const edge = (id: string, source: string, target: string): BuilderEdge =>
  ({ id, source, sourcePort: 'out', target, targetPort: 'in' });

/** DELIBERATELY unsorted ids — the order pin needs an order a sort would change. */
function loadFixture(): void {
  const wf: SavedWorkflow = {
    id: 'wf_adapter_test',
    name: 'Adapter Wf',
    version: '1.0.0',
    nodes: [node('n_z', 0, 0), node('n_a', 100, 0), node('n_m', 200, 0)],
    edges: [edge('e_9', 'n_z', 'n_a'), edge('e_1', 'n_z', 'n_m')],
    defaultInputs: '{}',
    createdAt: 'now',
    updatedAt: 'now',
  };
  useBuilderStore.getState().loadFromSaved(wf);
}

function relayPair(): { a: Y.Doc; b: Y.Doc; flush: () => void } {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const toB: Uint8Array[] = [];
  const toA: Uint8Array[] = [];
  a.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'relay') toB.push(u); });
  b.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'relay') toA.push(u); });
  const flush = (): void => {
    while (toB.length > 0 || toA.length > 0) {
      const ub = toB.splice(0);
      const ua = toA.splice(0);
      for (const u of ub) Y.applyUpdate(b, u, 'relay');
      for (const u of ua) Y.applyUpdate(a, u, 'relay');
    }
  };
  return { a, b, flush };
}

let adapter: WorkflowCollabAdapter | null = null;
let binding: CollabDocBinding<Dict> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(mockedSaveWorkflow).mockClear();
});

afterEach(async () => {
  adapter?.destroy();
  adapter = null;
  binding?.destroy();
  binding = null;
  await vi.runAllTimersAsync(); // drain any resumed autosave debounce
  vi.useRealTimers();
  useBuilderStore.setState({
    workflowId: '', nodes: [], edges: [], selectedNodeIds: [], selectedNodeId: null,
    past: [], future: [], collabLive: false, collabPeers: null, syncState: 'pending',
  });
});

describe('adapter round-trip (the no-order-normalization pin)', () => {
  it('seeds the room in STORE order and a peer materializes the identical graph, order included', () => {
    const { a, b, flush } = relayPair();
    loadFixture();
    binding = createCollabDocBinding<Dict>(a, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    const peer = createCollabDocBinding<Dict>(b, WORKFLOW_COLLAB_SHAPE);
    flush();
    const doc = peer.current();
    // Order preserved verbatim — NOT sorted (n_a < n_m < n_z would be the tell).
    expect((doc.nodes as Dict[]).map((n) => n.id)).toEqual(['n_z', 'n_a', 'n_m']);
    expect((doc.edges as Dict[]).map((e) => e.id)).toEqual(['e_9', 'e_1']);
    expect(doc.name).toBe('Adapter Wf');
    // Round-trip back into the store shape: unchanged, order included.
    const store = useBuilderStore.getState();
    expect((doc.nodes as BuilderNode[]).map((n) => ({ id: n.id, kind: n.kind, name: n.name })))
      .toEqual(store.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name })));
    peer.destroy();
  });

  it('a debounced local mutation flushes in insertion order (append stays last)', () => {
    const ydoc = new Y.Doc();
    loadFixture();
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    // Insert a node whose id sorts FIRST — order-normalizing would move it.
    useBuilderStore.setState({
      nodes: [...useBuilderStore.getState().nodes, node('n_0', 300, 0)],
    });
    vi.advanceTimersByTime(400);
    const doc = binding.current();
    expect((doc.nodes as Dict[]).map((n) => n.id)).toEqual(['n_z', 'n_a', 'n_m', 'n_0']);
  });

  it('a remote transaction materializes into the store without echoing back', () => {
    const { a, b, flush } = relayPair();
    loadFixture();
    binding = createCollabDocBinding<Dict>(a, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    const peer = createCollabDocBinding<Dict>(b, WORKFLOW_COLLAB_SHAPE);
    flush();
    const peerDoc = peer.current();
    peer.set({
      ...peerDoc,
      name: 'Renamed by peer',
      nodes: [...(peerDoc.nodes as Dict[]), node('n_new', 400, 0) as unknown as Dict],
    });
    flush();
    const store = useBuilderStore.getState();
    expect(store.name).toBe('Renamed by peer');
    expect(store.nodes.map((n) => n.id)).toEqual(['n_z', 'n_a', 'n_m', 'n_new']);
    // No echo: the remote apply must not schedule a local push that rewrites
    // the room (a rewrite would rebuild items and drop CRDT identity).
    vi.advanceTimersByTime(400);
    flush();
    expect((peer.current().nodes as Dict[]).map((n) => n.id)).toEqual(['n_z', 'n_a', 'n_m', 'n_new']);
    peer.destroy();
  });
});

describe('joiner blank-wipe bailout (code-H1, FE half)', () => {
  it('seed:false + an EMPTY room doc returns null and leaves the store untouched', () => {
    const ydoc = new Y.Doc();
    loadFixture();
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    // Nobody seeded this doc — a joiner materializing it would blank-wipe the
    // user's real workflow.
    const result = attachWorkflowCollabAdapter(binding, { seed: false });
    expect(result).toBeNull();
    const s = useBuilderStore.getState();
    expect(s.nodes.map((n) => n.id)).toEqual(['n_z', 'n_a', 'n_m']);
    expect(s.edges.map((e) => e.id)).toEqual(['e_9', 'e_1']);
    expect(s.name).toBe('Adapter Wf');
    // No join duty ran: autosave is NOT suspended, stacks untouched.
    expect(s.collabLive).toBe(false);
  });

  it('a stale refused-save banner resets to pending on attach (ux-H1)', () => {
    const ydoc = new Y.Doc();
    loadFixture();
    useBuilderStore.setState({ syncState: 'failed', syncFailureStatus: 409, syncFailureReason: 'workflow_room_live' });
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    // While the room is live the head saves through the session — a lingering
    // failure banner would contradict the Live chip.
    expect(useBuilderStore.getState().syncState).toBe('pending');
  });
});

describe('destroy resilience (code-M4)', () => {
  /** A binding whose write verbs throw — simulates a torn-down Y.Doc under
   *  the final flush. Everything else is inert. */
  function throwingBinding(): CollabDocBinding<Dict> {
    return {
      seed: () => {},
      current: () => ({}),
      set: () => { throw new Error('final-flush boom'); },
      replace: () => { throw new Error('final-flush boom'); },
      undo: () => {},
      redo: () => {},
      canUndo: () => false,
      canRedo: () => false,
      onDocChanged: () => () => {},
      onStackChanged: () => () => {},
      destroy: () => {},
    };
  }

  it('resets collabLive + stacks and lands the catch-up sync even when the final flush throws', async () => {
    loadFixture();
    const bad = throwingBinding();
    const a = attachWorkflowCollabAdapter(bad, { seed: true });
    expect(a).not.toBeNull();
    expect(useBuilderStore.getState().collabLive).toBe(true);
    // Leave a debounced push PENDING so destroy's final flush calls set().
    useBuilderStore.getState().updateNode('n_a', { name: 'edited live' });
    expect(() => a!.destroy()).toThrow('final-flush boom');
    // The leave duties MUST have run regardless — a stuck collabLive:true
    // would suspend the backend autosave forever.
    const s = useBuilderStore.getState();
    expect(s.collabLive).toBe(false);
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.collabPeers).toBeNull();
    // The catch-up persist ran: the resumed autosave debounce lands one save.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockedSaveWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('autosave suspension (ADR 0481 §4)', () => {
  it('collabLive makes scheduleBackendSync a no-op; destroy resumes with ONE catch-up sync', async () => {
    const ydoc = new Y.Doc();
    loadFixture();
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    expect(useBuilderStore.getState().collabLive).toBe(true);
    // Solo snapshot stacks cleared on join (the M4 class).
    expect(useBuilderStore.getState().past).toEqual([]);
    expect(useBuilderStore.getState().future).toEqual([]);
    // Store mutations persist locally but never reach the backend while live.
    useBuilderStore.getState().updateNode('n_a', { name: 'renamed live' });
    useBuilderStore.getState().persist();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedSaveWorkflow).not.toHaveBeenCalled();
    // Leave: autosave resumes and exactly one catch-up sync lands.
    adapter!.destroy();
    adapter = null;
    expect(useBuilderStore.getState().collabLive).toBe(false);
    expect(useBuilderStore.getState().past).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockedSaveWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('the definition root scalar (ADR 0481 §3)', () => {
  it('seed writes valid definition JSON carrying the workflowId', () => {
    const ydoc = new Y.Doc();
    loadFixture();
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    const raw = binding.current()['definition'];
    expect(typeof raw).toBe('string');
    const def = JSON.parse(raw as string) as { workflowId: string; nodes: unknown[]; edges: unknown[] };
    expect(def.workflowId).toBe('wf_adapter_test');
    expect(def.nodes).toHaveLength(3);
    expect(def.edges).toHaveLength(2);
  });

  it('the ~1.5s debounce refreshes the scalar after an edit', () => {
    const ydoc = new Y.Doc();
    loadFixture();
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    useBuilderStore.getState().updateNode('n_m', { config: { note: 'edited' } });
    // Push debounce fires first; the definition trails on its own window.
    vi.advanceTimersByTime(400);
    const before = JSON.parse(binding.current()['definition'] as string) as { nodes: { config?: Dict }[] };
    expect(before.nodes.some((n) => n.config?.note === 'edited')).toBe(false);
    vi.advanceTimersByTime(1_200); // past the 1.5 s window
    const after = JSON.parse(binding.current()['definition'] as string) as { workflowId: string; nodes: { config?: Dict }[] };
    expect(after.workflowId).toBe('wf_adapter_test');
    expect(after.nodes.some((n) => n.config?.note === 'edited')).toBe(true);
  });

  it('an unserializable graph keeps the previous scalar (stale beats invalid)', () => {
    const ydoc = new Y.Doc();
    loadFixture();
    binding = createCollabDocBinding<Dict>(ydoc, WORKFLOW_COLLAB_SHAPE);
    adapter = attachWorkflowCollabAdapter(binding, { seed: true });
    const seeded = binding.current()['definition'] as string;
    // Empty graph throws at serialize time — the scalar must not change.
    useBuilderStore.setState({ nodes: [], edges: [] });
    vi.advanceTimersByTime(2_000);
    expect(binding.current()['definition']).toBe(seeded);
  });
});
