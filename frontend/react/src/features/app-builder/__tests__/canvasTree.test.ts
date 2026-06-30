/**
 * App-builder editor tree helpers (ADR 0153 Phase 2b) — the path arithmetic behind
 * select / add / delete / set-prop in the full-screen editor.
 */
import { describe, it, expect } from 'vitest';
import { nodeAt, addChild, deleteAt, setPropAt, type Screen } from '../canvasTree.js';

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
