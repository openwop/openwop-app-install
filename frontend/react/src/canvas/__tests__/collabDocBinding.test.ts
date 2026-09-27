/**
 * collabDocBinding tests (ADR 0359 Phase 3 / D3-D4). Two bindings on two real
 * Y.Docs exchange updates through a manual relay (flush-controlled so true
 * concurrency — both sides commit before either sees the other — is testable).
 * Pins the load-bearing semantics:
 *  - reference-identity reconciliation: a reorder is a MOVE of the minority
 *    (LIS), so a peer's concurrent field edit on a kept element SURVIVES;
 *  - positional per-field update keeps CRDT identity: concurrent edits to
 *    DIFFERENT fields of the same element both survive;
 *  - per-user undo (Y.UndoManager + LOCAL origin): A's undo never reverts B;
 *  - one undo step per gesture (set = new step, replace coalesces);
 *  - D4 remap: remote inserts/deletes shift/drop positional selection indices.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { createCollabDocBinding, type CollabDocShape, type CollabIndexRemap } from '../collabDocBinding.js';

type Dict = Record<string, unknown>;
interface DrawDoc extends Dict { title: string; shapes: Dict[] }
const SHAPES: CollabDocShape = { collections: [{ key: 'shapes' }] };
const TREE: CollabDocShape = { collections: [{ key: 'frames', nested: { field: 'root', childrenKey: 'children' } }] };

/** Two Y.Docs with a manual relay; flush() delivers queued updates both ways. */
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

const shape = (id: string, extra: Dict = {}): Dict => ({ kind: 'rect', label: id, x: 0, y: 0, ...extra });

function seeded() {
  const { a, b, flush } = pair();
  const A = createCollabDocBinding<DrawDoc>(a, SHAPES);
  const B = createCollabDocBinding<DrawDoc>(b, SHAPES);
  const s0 = shape('s0'); const s1 = shape('s1'); const s2 = shape('s2');
  A.seed({ title: 'T', shapes: [s0, s1, s2] });
  flush();
  B.current(); // materialize B's mirror
  return { A, B, flush, s0, s1, s2 };
}

describe('collabDocBinding', () => {
  it('seeds and materializes the same doc on the peer (props + collection)', () => {
    const { B } = seeded();
    const doc = B.current();
    expect(doc.title).toBe('T');
    expect((doc.shapes as Dict[]).map((s) => s.label)).toEqual(['s0', 's1', 's2']);
  });

  it('concurrent edits to DIFFERENT fields of the SAME element both survive (identity kept)', () => {
    const { A, B, flush } = seeded();
    const aDoc = A.current() as DrawDoc; const bDoc = B.current() as DrawDoc;
    // A sets fill on shapes[0]; B sets x on shapes[0] — before either syncs.
    const aShapes = (aDoc.shapes as Dict[]).slice(); aShapes[0] = { ...aShapes[0], fill: 'red' };
    A.set({ ...aDoc, shapes: aShapes });
    const bShapes = (bDoc.shapes as Dict[]).slice(); bShapes[0] = { ...bShapes[0], x: 42 };
    B.set({ ...bDoc, shapes: bShapes });
    flush();
    const fa = (A.current().shapes as Dict[])[0]!;
    const fb = (B.current().shapes as Dict[])[0]!;
    expect(fa.fill).toBe('red');
    expect(fa.x).toBe(42);
    expect(fb).toEqual(fa);
    expect((A.current().shapes as Dict[]).length).toBe(3); // never duplicated
  });

  it('a reorder is a minimal move — a concurrent edit on a KEPT element survives', () => {
    const { A, B, flush } = seeded();
    const aDoc = A.current() as DrawDoc;
    // A moves s2 to the front (reference-shared reorder: [s2, s0, s1]).
    const [r0, r1, r2] = aDoc.shapes as Dict[];
    A.set({ ...aDoc, shapes: [r2!, r0!, r1!] });
    // B concurrently edits s1 (a kept element under LIS).
    const bDoc = B.current() as DrawDoc;
    const bShapes = (bDoc.shapes as Dict[]).slice(); bShapes[1] = { ...bShapes[1], label: 's1-edited' };
    B.set({ ...bDoc, shapes: bShapes });
    flush();
    const labels = (A.current().shapes as Dict[]).map((s) => s.label);
    expect(labels).toEqual(['s2', 's0', 's1-edited']);
    expect((B.current().shapes as Dict[]).map((s) => s.label)).toEqual(labels);
  });

  it('a FULL-CLONE gesture (editDoc style) still keeps unchanged-element identity via deep-equal match', () => {
    const { A, B, flush } = seeded();
    const aDoc = A.current() as DrawDoc;
    // Full JSON clone (reference sharing broken), one element edited.
    const cloned = JSON.parse(JSON.stringify(aDoc)) as DrawDoc;
    (cloned.shapes as Dict[])[2] = { ...(cloned.shapes as Dict[])[2], label: 's2-edited' };
    A.set(cloned);
    // B concurrently edits s0 — must survive (s0 was deep-equal matched, not rebuilt).
    const bDoc = B.current() as DrawDoc;
    const bShapes = (bDoc.shapes as Dict[]).slice(); bShapes[0] = { ...bShapes[0], y: 99 };
    B.set({ ...bDoc, shapes: bShapes });
    flush();
    const merged = A.current().shapes as Dict[];
    expect(merged.map((s) => s.label)).toEqual(['s0', 's1', 's2-edited']);
    expect(merged[0]!.y).toBe(99);
    expect(B.current()).toEqual(A.current());
  });

  it('per-user undo: A undoes only A\'s gesture, never B\'s', () => {
    const { A, B, flush } = seeded();
    flush();
    const aDoc = A.current() as DrawDoc;
    A.set({ ...aDoc, shapes: [...(aDoc.shapes as Dict[]), shape('a-new')] });
    flush();
    const bDoc = B.current() as DrawDoc;
    B.set({ ...bDoc, shapes: [...(bDoc.shapes as Dict[]), shape('b-new')] });
    flush();
    expect((A.current().shapes as Dict[]).map((s) => s.label)).toEqual(['s0', 's1', 's2', 'a-new', 'b-new']);
    expect(A.canUndo()).toBe(true);
    A.undo();
    flush();
    const after = (A.current().shapes as Dict[]).map((s) => s.label);
    expect(after).toContain('b-new');   // B's work untouched
    expect(after).not.toContain('a-new'); // A's own gesture reverted
  });

  it('one undo step per gesture: replace() coalesces into the open set()', () => {
    const { A } = seeded();
    const d0 = A.current() as DrawDoc;
    const patch = (doc: DrawDoc, x: number): DrawDoc => {
      const shapes = (doc.shapes as Dict[]).slice(); shapes[0] = { ...shapes[0], x };
      return { ...doc, shapes };
    };
    A.set(patch(d0, 10));           // gesture start (new step)
    A.replace(patch(A.current() as DrawDoc, 20)); // drag move
    A.replace(patch(A.current() as DrawDoc, 30)); // drag move
    A.undo();                        // one step ⇒ back to pre-gesture
    expect((A.current().shapes as Dict[])[0]!.x).toBe(0);
  });

  it('D4 remap: a remote insert above shifts indices; a remote delete drops to null', () => {
    const { A, B, flush } = seeded();
    flush();
    const remaps: CollabIndexRemap[] = [];
    B.onDocChanged((_d, remap) => remaps.push(remap));
    // Remote INSERT at the head (reference-shared).
    const aDoc = A.current() as DrawDoc;
    A.set({ ...aDoc, shapes: [shape('head'), ...(aDoc.shapes as Dict[])] });
    flush();
    expect(remaps.length).toBeGreaterThan(0);
    const insRemap = remaps[remaps.length - 1]!;
    expect(insRemap('shapes', 1)).toBe(2);
    // Remote DELETE of index 0.
    const aDoc2 = A.current() as DrawDoc;
    A.set({ ...aDoc2, shapes: (aDoc2.shapes as Dict[]).slice(1) });
    flush();
    const delRemap = remaps[remaps.length - 1]!;
    expect(delRemap('shapes', 0)).toBe(null);
    expect(delRemap('shapes', 2)).toBe(1);
  });

  it('doc-level props (name/title) ride the CRDT', () => {
    const { A, B, flush } = seeded();
    flush();
    A.replace({ ...(A.current() as DrawDoc), title: 'Renamed' });
    flush();
    expect(B.current().title).toBe('Renamed');
  });

  it('nested tree collections (frames → root nodes → children) converge on concurrent node edits', () => {
    const { a, b, flush } = pair();
    const A = createCollabDocBinding<Dict>(a, TREE);
    const B = createCollabDocBinding<Dict>(b, TREE);
    const node = (id: string, children: Dict[] = []): Dict => ({ type: 'box', id, children });
    A.seed({ title: 'T', frames: [{ name: 'f0', root: [node('n0', [node('n0a')]), node('n1')] }] });
    flush();
    B.current();
    // A edits n0a's type; B edits n1's type — different nodes, both survive.
    const edit = (doc: Dict, fn: (root: Dict[]) => void): Dict => {
      const clone = JSON.parse(JSON.stringify(doc)) as Dict;
      fn(((clone.frames as Dict[])[0]!.root as Dict[]));
      return clone;
    };
    A.set(edit(A.current(), (root) => { ((root[0]!.children as Dict[])[0]!).type = 'circle'; }));
    B.set(edit(B.current(), (root) => { root[1]!.type = 'hex'; }));
    flush();
    const rootA = ((A.current().frames as Dict[])[0]!.root as Dict[]);
    expect(((rootA[0]!.children as Dict[])[0]!).type).toBe('circle');
    expect(rootA[1]!.type).toBe('hex');
    expect(B.current()).toEqual(A.current());
  });
});
