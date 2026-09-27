/**
 * ADR 0364 Phase 1 — workflow collab shape convergence pins. Two bindings on
 * two real Y.Docs exchange updates through a manual relay (the
 * collabDocBinding test harness pattern). The load-bearing semantics:
 *
 *  - ID-KEYED pairing: workflow nodes/edges carry stable ids that OTHER items
 *    reference (edges → node ids). A swap+edit full-clone gesture must pair
 *    leftovers BY ID — positional pairing would cross-wire one user's
 *    concurrent field edit onto the other user's node (the CRDT Y.Map is the
 *    identity concurrent edits merge into).
 *  - The graph scalars (name/defaultInputs) converge on the root map.
 *  - `workflowCollabSlice` keeps REST-owned identity fields (id/version/
 *    timestamps) OUT of the room.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { createCollabDocBinding } from '../../../canvas/collabDocBinding.js';
import { WORKFLOW_COLLAB_SHAPE, workflowCollabSlice } from '../workflowCollabShape.js';

type Dict = Record<string, unknown>;
interface WfDoc extends Dict { name: string; nodes: Dict[]; edges: Dict[] }

function pair() {
  const a = new Y.Doc(); const b = new Y.Doc();
  const toB: Uint8Array[] = []; const toA: Uint8Array[] = [];
  a.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'relay') toB.push(u); });
  b.on('update', (u: Uint8Array, origin: unknown) => { if (origin !== 'relay') toA.push(u); });
  const flush = (): void => {
    while (toB.length > 0 || toA.length > 0) {
      const ub = toB.splice(0); const ua = toA.splice(0);
      for (const u of ub) Y.applyUpdate(b, u, 'relay');
      for (const u of ua) Y.applyUpdate(a, u, 'relay');
    }
  };
  return { a, b, flush };
}

const node = (id: string, extra: Dict = {}): Dict => ({ id, kind: 'noop', name: id, position: { x: 0, y: 0 }, config: {}, ...extra });
const edge = (id: string, source: string, target: string): Dict => ({ id, source, sourcePort: 'out', target, targetPort: 'in' });
const clone = (d: Dict): Dict => JSON.parse(JSON.stringify(d)) as Dict;

function seeded() {
  const { a, b, flush } = pair();
  const A = createCollabDocBinding<WfDoc>(a, WORKFLOW_COLLAB_SHAPE);
  const B = createCollabDocBinding<WfDoc>(b, WORKFLOW_COLLAB_SHAPE);
  const n1 = node('n_1'); const n2 = node('n_2');
  const e1 = edge('e_1', 'n_1', 'n_2');
  A.seed({ name: 'Wf', nodes: [n1, n2], edges: [e1] });
  flush();
  B.current();
  return { A, B, flush, n1, n2, e1 };
}

const byId = (doc: Dict, id: string): Dict | undefined => (doc.nodes as Dict[]).find((n) => n.id === id);

describe('workflow collab shape (ADR 0364)', () => {
  it('seeds and materializes the graph + scalars on the peer', () => {
    const { B } = seeded();
    const doc = B.current();
    expect(doc.name).toBe('Wf');
    expect((doc.nodes as Dict[]).map((n) => n.id)).toEqual(['n_1', 'n_2']);
    expect((doc.edges as Dict[]).map((e) => e.id)).toEqual(['e_1']);
  });

  it('a swap+edit full-clone gesture pairs by ID — a peer concurrent field edit lands on the RIGHT node', () => {
    const { A, B, flush, n1, n2, e1 } = seeded();
    // A: full-clone swap + edits (deep-equal fails on both; only id pairing is safe).
    const c1 = { ...clone(n1), name: 'renamed' };
    const c2 = { ...clone(n2), position: { x: 200, y: 40 } };
    A.set({ name: 'Wf', nodes: [c2, c1], edges: [e1] } as WfDoc);
    // B concurrently (before seeing A): edits n_1's config via its own clone.
    const b1 = { ...clone(n1), config: { foo: 1 } };
    B.set({ name: 'Wf', nodes: [b1, clone(n2)], edges: [clone(e1)] } as WfDoc);
    flush();
    const docA = A.current(); const docB = B.current();
    expect(docA).toEqual(docB);
    // Both users' edits to n_1 merged onto the SAME identity — no cross-wire.
    const m1 = byId(docA, 'n_1')!;
    expect(m1.name).toBe('renamed');
    expect((m1.config as Dict).foo).toBe(1);
    // n_2 kept its identity and took only A's position edit.
    const m2 = byId(docA, 'n_2')!;
    expect(m2.name).toBe('n_2');
    expect(m2.position).toEqual({ x: 200, y: 40 });
    // The edge still references intact node ids.
    expect((docA.edges as Dict[])[0]).toMatchObject({ source: 'n_1', target: 'n_2' });
  });

  it('concurrent node-add + edge-add referencing an existing node both survive', () => {
    const { A, B, flush } = seeded();
    const docA0 = A.current();
    A.set({ ...docA0, nodes: [...(docA0.nodes as Dict[]), node('n_3')] } as WfDoc);
    const docB0 = B.current();
    B.set({ ...docB0, edges: [...(docB0.edges as Dict[]), edge('e_2', 'n_2', 'n_1')] } as WfDoc);
    flush();
    const docA = A.current(); const docB = B.current();
    expect(docA).toEqual(docB);
    expect((docA.nodes as Dict[]).map((n) => n.id).sort()).toEqual(['n_1', 'n_2', 'n_3']);
    expect((docA.edges as Dict[]).map((e) => e.id).sort()).toEqual(['e_1', 'e_2']);
  });

  it('a deleted id is a genuine delete — never positionally revived by a leftover', () => {
    const { A, B, flush, n1, e1 } = seeded();
    // A deletes n_2 (and its edge); B concurrently renames n_2 via a clone.
    A.set({ name: 'Wf', nodes: [clone(n1)], edges: [] } as WfDoc);
    const docB0 = B.current();
    B.set({ ...docB0, nodes: [clone(n1), { ...node('n_2'), name: 'late-edit' }], edges: [clone(e1)] } as WfDoc);
    flush();
    const docA = A.current(); const docB = B.current();
    expect(docA).toEqual(docB);
    // Convergent outcome must be consistent; the load-bearing assertion is
    // that n_1 never absorbed n_2's fields (no cross-wire on delete).
    expect(byId(docA, 'n_1')!.name).toBe('n_1');
  });

  it('per-user undo scope holds for the graph (A undo never reverts B)', () => {
    const { A, B, flush } = seeded();
    const docA0 = A.current();
    A.set({ ...docA0, name: 'A-renamed' } as WfDoc);
    flush();
    const docB0 = B.current();
    B.set({ ...docB0, nodes: [...(docB0.nodes as Dict[]), node('n_9')] } as WfDoc);
    flush();
    A.undo(); // reverts A's rename ONLY
    flush();
    const doc = B.current();
    expect(doc.name).toBe('Wf');
    expect((doc.nodes as Dict[]).some((n) => n.id === 'n_9')).toBe(true);
  });

  it('workflowCollabSlice strips REST-owned identity fields', () => {
    const slice = workflowCollabSlice({
      id: 'wf-1', version: '1.0.0', createdAt: 'x', updatedAt: 'y',
      name: 'Wf', nodes: [], edges: [], defaultInputs: '{}', inputSchema: '',
    });
    expect(Object.keys(slice).sort()).toEqual(['defaultInputs', 'edges', 'inputSchema', 'name', 'nodes']);
  });
});
