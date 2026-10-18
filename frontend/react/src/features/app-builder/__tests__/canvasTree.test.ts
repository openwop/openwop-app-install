/**
 * App-builder editor tree helpers (ADR 0153 Phase 2b) — the path arithmetic behind
 * select / add / delete / set-prop in the full-screen editor. The subject is the
 * shared `canvas/treeOps.ts` factory (ADR 0310) as the app-builder instantiates it;
 * a wrong index here moves, deletes, or edits the WRONG component in a user's app.
 *
 * Every expectation is a hand-written literal tree — never one derived from the
 * fixture through the function under test (the w33 shared-oracle lesson).
 */
import { describe, it, expect } from 'vitest';
import { nodeAt, addChild, deleteAt, setPropAt, insertAt, moveNode, duplicateAt, type Screen } from '../canvasTree.js';

const base = (): Screen => ({
  id: 'home', name: 'Home',
  components: [
    { type: 'stack', children: [
      { type: 'heading', props: { text: 'Hi', level: 2 } },
      { type: 'button', props: { label: 'Go' } },
    ] },
    { type: 'text', props: { text: 'footer' } },
  ],
});

describe('canvasTree.nodeAt', () => {
  it('resolves nested paths and returns null for invalid ones', () => {
    const s = base();
    expect(nodeAt(s, [0])?.type).toBe('stack');
    expect(nodeAt(s, [0, 1])).toEqual({ type: 'button', props: { label: 'Go' } });
    expect(nodeAt(s, [9])).toBeNull();
    expect(nodeAt(s, [1, 0])).toBeNull(); // text has no children
  });
});

describe('canvasTree.addChild', () => {
  it('appends at screen root when path is null', () => {
    const s = base();
    addChild(s, null, { type: 'divider' });
    expect(s.components).toEqual([
      { type: 'stack', children: [{ type: 'heading', props: { text: 'Hi', level: 2 } }, { type: 'button', props: { label: 'Go' } }] },
      { type: 'text', props: { text: 'footer' } },
      { type: 'divider' },
    ]);
  });
  it('appends under a container path', () => {
    const s = base();
    addChild(s, [0], { type: 'image' });
    expect(s.components).toEqual([
      { type: 'stack', children: [{ type: 'heading', props: { text: 'Hi', level: 2 } }, { type: 'button', props: { label: 'Go' } }, { type: 'image' }] },
      { type: 'text', props: { text: 'footer' } },
    ]);
  });
});

describe('canvasTree.deleteAt', () => {
  it('removes a nested node', () => {
    const s = base();
    deleteAt(s, [0, 0]);
    expect(s.components).toEqual([
      { type: 'stack', children: [{ type: 'button', props: { label: 'Go' } }] },
      { type: 'text', props: { text: 'footer' } },
    ]);
  });
  it('removes a root node and ignores the empty path', () => {
    const s = base();
    deleteAt(s, [1]);
    const after = [{ type: 'stack', children: [{ type: 'heading', props: { text: 'Hi', level: 2 } }, { type: 'button', props: { label: 'Go' } }] }];
    expect(s.components).toEqual(after);
    deleteAt(s, []); // no-op
    expect(s.components).toEqual(after);
  });
});

describe('canvasTree.setPropAt', () => {
  it('sets a prop on the targeted node only', () => {
    const s = base();
    setPropAt(s, [0, 0], 'text', 'Hello');
    // The heading keeps its OTHER prop (`level`) — a write that replaced the
    // whole props bag would lose it.
    expect(s.components).toEqual([
      { type: 'stack', children: [{ type: 'heading', props: { text: 'Hello', level: 2 } }, { type: 'button', props: { label: 'Go' } }] },
      { type: 'text', props: { text: 'footer' } },
    ]);
  });
});

describe('canvasTree.insertAt (ADR 0305 Phase B)', () => {
  it('inserts at an index within root and clamps out-of-range', () => {
    const s = base();
    insertAt(s, null, 1, { type: 'divider' });
    expect(s.components?.map((c) => c.type)).toEqual(['stack', 'divider', 'text']);
    insertAt(s, null, 99, { type: 'badge' });
    expect(s.components?.map((c) => c.type)).toEqual(['stack', 'divider', 'text', 'badge']);
  });
  it('creates the children array on a childless container', () => {
    const s = base();
    insertAt(s, [1], 0, { type: 'badge' }); // text has no children yet
    expect(s.components?.[1]).toEqual({ type: 'text', props: { text: 'footer' }, children: [{ type: 'badge' }] });
  });
});

describe('canvasTree.moveNode (ADR 0305 Phase B — the adjustment arithmetic)', () => {
  it('moves earlier among siblings (no adjustment)', () => {
    const s = base();
    expect(moveNode(s, [0, 1], [0], 0)).toEqual([0, 0]);
    expect(s.components?.[0]).toEqual({ type: 'stack', children: [{ type: 'button', props: { label: 'Go' } }, { type: 'heading', props: { text: 'Hi', level: 2 } }] });
  });
  it('moves later among siblings (same-parent toIndex shifts left)', () => {
    // THREE siblings: with two, the post-removal list has length 1 and the
    // index clamp alone lands the node at 1, masking the shift (w36 probe).
    const s: Screen = { id: 'x', name: 'X', components: [{ type: 'stack', children: [{ type: 'heading' }, { type: 'button' }, { type: 'badge' }] }] };
    // "before the badge" = toIndex 2 → lands at 1 post-removal.
    expect(moveNode(s, [0, 0], [0], 2)).toEqual([0, 1]);
    expect(s.components).toEqual([{ type: 'stack', children: [{ type: 'button' }, { type: 'heading' }, { type: 'badge' }] }]);
  });
  it('moves a root node into a container that was a LATER sibling (dest segment shifts left)', () => {
    const s: Screen = { id: 'x', name: 'X', components: [
      { type: 'text', props: { text: 'a' } },
      { type: 'stack', children: [{ type: 'badge' }] },
    ] };
    // Move root[0] into root[1] (the stack). After removal the stack is root[0].
    expect(moveNode(s, [0], [1], 99)).toEqual([0, 1]);
    expect(s.components).toEqual([{ type: 'stack', children: [{ type: 'badge' }, { type: 'text', props: { text: 'a' } }] }]);
  });
  it('refuses moving into the node itself or its own descendant', () => {
    const s = base();
    expect(moveNode(s, [0], [0], 0)).toBeNull();
    expect(moveNode(s, [0], [0, 1], 0)).toBeNull();
    expect(s).toEqual(base()); // untouched
  });
  it('moves a nested node out to the root after its old parent', () => {
    const s = base();
    expect(moveNode(s, [0, 1], null, 1)).toEqual([1]);
    expect(s.components).toEqual([
      { type: 'stack', children: [{ type: 'heading', props: { text: 'Hi', level: 2 } }] },
      { type: 'button', props: { label: 'Go' } },
      { type: 'text', props: { text: 'footer' } },
    ]);
  });
  it('returns null for an invalid source', () => {
    const s = base();
    expect(moveNode(s, [9, 9], null, 0)).toBeNull();
    expect(moveNode(s, [], null, 0)).toBeNull();
    expect(s).toEqual(base());
  });
});

describe('canvasTree.duplicateAt (ADR 0305 Phase B)', () => {
  it('deep-clones the node right after the original', () => {
    const s = base();
    expect(duplicateAt(s, [0, 0])).toEqual([0, 1]);
    expect(s.components?.[0]).toEqual({ type: 'stack', children: [
      { type: 'heading', props: { text: 'Hi', level: 2 } },
      { type: 'heading', props: { text: 'Hi', level: 2 } },
      { type: 'button', props: { label: 'Go' } },
    ] });
    // Deep clone — mutating the copy leaves the original alone.
    setPropAt(s, [0, 1], 'text', 'copy');
    expect(nodeAt(s, [0, 0])).toEqual({ type: 'heading', props: { text: 'Hi', level: 2 } });
  });
  it('returns null for the empty path', () => {
    expect(duplicateAt(base(), [])).toBeNull();
  });
});
