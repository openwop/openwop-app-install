/**
 * App-builder editor tree helpers (ADR 0153 Phase 2b) — the path arithmetic behind
 * select / add / delete / set-prop in the full-screen editor.
 */
import { describe, it, expect } from 'vitest';
import { nodeAt, addChild, deleteAt, setPropAt, insertAt, moveNode, duplicateAt, type Screen } from '../canvasTree.js';

const base = (): Screen => ({
  id: 'home', name: 'Home',
  components: [
    { type: 'stack', children: [
      { type: 'heading', props: { text: 'Hi' } },
      { type: 'button', props: { label: 'Go' } },
    ] },
    { type: 'text', props: { text: 'footer' } },
  ],
});

describe('canvasTree.nodeAt', () => {
  it('resolves nested paths and returns null for invalid ones', () => {
    const s = base();
    expect(nodeAt(s, [0])?.type).toBe('stack');
    expect(nodeAt(s, [0, 1])?.type).toBe('button');
    expect(nodeAt(s, [9])).toBeNull();
    expect(nodeAt(s, [1, 0])).toBeNull(); // text has no children
  });
});

describe('canvasTree.addChild', () => {
  it('appends at screen root when path is null', () => {
    const s = base();
    addChild(s, null, { type: 'divider' });
    expect(s.components?.map((c) => c.type)).toEqual(['stack', 'text', 'divider']);
  });
  it('appends under a container path', () => {
    const s = base();
    addChild(s, [0], { type: 'image' });
    expect(nodeAt(s, [0])?.children?.map((c) => c.type)).toEqual(['heading', 'button', 'image']);
  });
});

describe('canvasTree.deleteAt', () => {
  it('removes a nested node', () => {
    const s = base();
    deleteAt(s, [0, 0]);
    expect(nodeAt(s, [0])?.children?.map((c) => c.type)).toEqual(['button']);
  });
  it('removes a root node and ignores the empty path', () => {
    const s = base();
    deleteAt(s, [1]);
    expect(s.components?.map((c) => c.type)).toEqual(['stack']);
    deleteAt(s, []); // no-op
    expect(s.components?.length).toBe(1);
  });
});

describe('canvasTree.setPropAt', () => {
  it('sets a prop on the targeted node only', () => {
    const s = base();
    setPropAt(s, [0, 0], 'text', 'Hello');
    expect(nodeAt(s, [0, 0])?.props?.text).toBe('Hello');
    expect(nodeAt(s, [0, 1])?.props?.label).toBe('Go'); // sibling untouched
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
    expect(nodeAt(s, [1, 0])?.type).toBe('badge');
  });
});

describe('canvasTree.moveNode (ADR 0305 Phase B — the adjustment arithmetic)', () => {
  it('moves earlier among siblings (no adjustment)', () => {
    const s = base();
    expect(moveNode(s, [0, 1], [0], 0)).toEqual([0, 0]);
    expect(nodeAt(s, [0])?.children?.map((c) => c.type)).toEqual(['button', 'heading']);
  });
  it('moves later among siblings (same-parent toIndex shifts left)', () => {
    const s = base();
    // "after the heading's next sibling" = toIndex 2 → lands at 1 post-removal.
    expect(moveNode(s, [0, 0], [0], 2)).toEqual([0, 1]);
    expect(nodeAt(s, [0])?.children?.map((c) => c.type)).toEqual(['button', 'heading']);
  });
  it('moves a root node into a container that was a LATER sibling (dest segment shifts left)', () => {
    const s: Screen = { id: 'x', name: 'X', components: [
      { type: 'text', props: { text: 'a' } },
      { type: 'stack', children: [{ type: 'badge' }] },
    ] };
    // Move root[0] into root[1] (the stack). After removal the stack is root[0].
    expect(moveNode(s, [0], [1], 99)).toEqual([0, 1]);
    expect(s.components?.length).toBe(1);
    expect(nodeAt(s, [0])?.children?.map((c) => c.type)).toEqual(['badge', 'text']);
  });
  it('refuses moving into the node itself or its own descendant', () => {
    const s = base();
    expect(moveNode(s, [0], [0], 0)).toBeNull();
    expect(moveNode(s, [0], [0, 1], 0)).toBeNull();
    expect(nodeAt(s, [0])?.children?.length).toBe(2); // untouched
  });
  it('moves a nested node out to the root after its old parent', () => {
    const s = base();
    expect(moveNode(s, [0, 1], null, 1)).toEqual([1]);
    expect(s.components?.map((c) => c.type)).toEqual(['stack', 'button', 'text']);
    expect(nodeAt(s, [0])?.children?.map((c) => c.type)).toEqual(['heading']);
  });
  it('returns null for an invalid source', () => {
    const s = base();
    expect(moveNode(s, [9, 9], null, 0)).toBeNull();
    expect(moveNode(s, [], null, 0)).toBeNull();
  });
});

describe('canvasTree.duplicateAt (ADR 0305 Phase B)', () => {
  it('deep-clones the node right after the original', () => {
    const s = base();
    expect(duplicateAt(s, [0, 0])).toEqual([0, 1]);
    const kids = nodeAt(s, [0])?.children ?? [];
    expect(kids.map((c) => c.type)).toEqual(['heading', 'heading', 'button']);
    // Deep clone — mutating the copy leaves the original alone.
    setPropAt(s, [0, 1], 'text', 'copy');
    expect(nodeAt(s, [0, 0])?.props?.text).toBe('Hi');
  });
  it('returns null for the empty path', () => {
    expect(duplicateAt(base(), [])).toBeNull();
  });
});
