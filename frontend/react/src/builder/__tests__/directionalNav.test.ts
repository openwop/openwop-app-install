/**
 * UX_UPGRADE-workflows-builder P3 — directionalTarget, the pure picker behind
 * Alt+Arrow node navigation. Left/right walk edges (tie-break: vertical
 * distance); up/down are spatial; no current node = enter at top-left
 * (LEFTMOST first, then topmost). Accessibility: this is the keyboard path to
 * every node.
 *
 * Sabotage that turns it red: ordering entry by y before x, tie-breaking on x,
 * walking left downstream, swapping above/below, dropping the empty-graph
 * guard, the range de-dup, the flood direction, or the flood's `seen` de-dup.
 */
import { describe, it, expect } from 'vitest';
import { directionalTarget, floodSelection, nextRangeSelection } from '../builderShellHelpers.js';

const N = (id: string, x: number, y: number) => ({ id, position: { x, y } });

//    a → b → d
//        ↓ (edge b→c, c sits below b)
//        c        e is a stray node below-left, unconnected
const nodes = [N('a', 0, 100), N('b', 200, 100), N('c', 200, 300), N('d', 400, 100), N('e', 50, 400)];
const edges = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'd' },
  { source: 'b', target: 'c' },
];

describe('directionalTarget', () => {
  it('returns null on an empty graph', () => {
    expect(directionalTarget([], [], null, 'left')).toBeNull();
  });

  it('enters the graph at the top-left-most node when nothing is selected', () => {
    expect(directionalTarget(nodes, edges, null, 'down')).toBe('a');
    expect(directionalTarget(nodes, edges, 'missing-id', 'up')).toBe('a');
    // Leftmost beats topmost: `t` is higher, `l` is further left.
    expect(directionalTarget([N('t', 300, 0), N('l', 0, 200)], [], null, 'down')).toBe('l');
  });

  it('right = downstream neighbor, tie broken by vertical closeness', () => {
    // b fans out to d (same row) and c (below); d is vertically closer.
    expect(directionalTarget(nodes, edges, 'b', 'right')).toBe('d');
  });

  it('left = upstream neighbor', () => {
    expect(directionalTarget(nodes, edges, 'b', 'left')).toBe('a');
    // a has no upstream — stay put (null).
    expect(directionalTarget(nodes, edges, 'a', 'left')).toBeNull();
  });

  it('down/up are spatial, not edge-bound', () => {
    expect(directionalTarget(nodes, edges, 'b', 'down')).toBe('c'); // nearest below
    expect(directionalTarget(nodes, edges, 'c', 'down')).toBe('e'); // unconnected still reachable
    expect(directionalTarget(nodes, edges, 'c', 'up')).toBe('b');
    expect(directionalTarget(nodes, edges, 'b', 'up')).toBeNull(); // nothing above the top row
  });
});

describe('nextRangeSelection (BLDKB-1, round 2)', () => {
  it('appends an unselected target', () => {
    expect(nextRangeSelection(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });
  it('never duplicates an already-selected target and starts from empty', () => {
    expect(nextRangeSelection(['a', 'b'], 'b')).toEqual(['a', 'b']);
    expect(nextRangeSelection([], 'a')).toEqual(['a']);
  });
});

describe('R3 flood-select — everything reachable in ONE direction, and only that', () => {
  // a → b → c, a → d; e is disconnected.
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'a', target: 'd' },
  ];

  it('downstream from a reaches b, c, d — and never the disconnected e', () => {
    const out = floodSelection(['a'], edges, ['a'], 'downstream');
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(out).not.toContain('e');
    expect(out[0]).toBe('a'); // current-first, stable
  });

  it('upstream from c reaches b and a only — the flood never crosses direction', () => {
    const out = floodSelection(['c'], edges, ['c'], 'upstream');
    expect([...out].sort()).toEqual(['a', 'b', 'c']);
    expect(out).not.toContain('d'); // d is a's OTHER child — reachable only by reversing at a
  });

  it('an empty anchor set floods nothing, and a cycle terminates', () => {
    expect(floodSelection([], edges, [], 'downstream')).toEqual([]);
    const cyclic = [...edges, { source: 'c', target: 'a' }];
    const out = floodSelection(['a'], cyclic, ['a'], 'downstream');
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']); // no infinite loop, no dupes
    // A reached node that is ALREADY in the selection is not added twice.
    expect(floodSelection(['a', 'c'], edges, ['a'], 'downstream')).toEqual(['a', 'c', 'b', 'd']);
  });
});
