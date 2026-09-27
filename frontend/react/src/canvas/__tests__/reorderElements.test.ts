/**
 * Z-order reorder (ADR 0333 Phase 2) — array order = paint order; overlap-aware
 * stepping via bboxFor; multi-selection preserves relative order; no-ops report
 * null so the chassis pushes no history entry.
 */
import { describe, it, expect } from 'vitest';
import { reorderElements, type ElementBox } from '../elementOps.js';

type El = Record<string, unknown>;
const el = (id: string, x = 0): El => ({ id, x, y: 0, w: 10, h: 10 });
const bbox = (e: El): ElementBox => ({ x: e.x as number, y: e.y as number, w: e.w as number, h: e.h as number });
const doc = (...els: El[]): { shapes: El[] } => ({ shapes: els });
const ids = (d: { shapes: El[] }): string[] => d.shapes.map((s) => s.id as string);

describe('reorderElements', () => {
  it('front/back move the selection to the extremes', () => {
    const d = doc(el('a'), el('b'), el('c'));
    expect(reorderElements(d, 'shapes', [0], 'front')).toEqual([2]);
    expect(ids(d)).toEqual(['b', 'c', 'a']);
    expect(reorderElements(d, 'shapes', [2], 'back')).toEqual([0]);
    expect(ids(d)).toEqual(['a', 'b', 'c']);
  });

  it('plain forward/backward step adjacent without bboxFor', () => {
    const d = doc(el('a'), el('b'), el('c'));
    expect(reorderElements(d, 'shapes', [0], 'forward')).toEqual([1]);
    expect(ids(d)).toEqual(['b', 'a', 'c']);
    expect(reorderElements(d, 'shapes', [1], 'backward')).toEqual([0]);
    expect(ids(d)).toEqual(['a', 'b', 'c']);
  });

  it('overlap-aware forward skips non-overlapping siblings', () => {
    // a at x=0; b far away (no overlap); c overlaps a.
    const d = doc(el('a', 0), el('b', 100), el('c', 5));
    expect(reorderElements(d, 'shapes', [0], 'forward', bbox)).toEqual([2]);
    // a stepped past c (the overlapping one), landing above it; b untouched.
    expect(ids(d)).toEqual(['b', 'c', 'a']);
  });

  it('overlap-aware forward is a no-op when nothing above overlaps', () => {
    const d = doc(el('a', 0), el('b', 100), el('x', 200));
    expect(reorderElements(d, 'shapes', [0], 'forward', bbox)).toBeNull();
    expect(ids(d)).toEqual(['a', 'b', 'x']);
  });

  it('multi-selection preserves relative order (returned indices follow the SORTED selection)', () => {
    const d = doc(el('a'), el('b'), el('c'), el('d'));
    expect(reorderElements(d, 'shapes', [3, 1], 'back')).toEqual([0, 1]);
    expect(ids(d)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('no-ops report null (extremes, whole-set selection, bad indices)', () => {
    const d = doc(el('a'), el('b'));
    expect(reorderElements(d, 'shapes', [1], 'front')).toBeNull();
    expect(reorderElements(d, 'shapes', [0], 'back')).toBeNull();
    expect(reorderElements(d, 'shapes', [0, 1], 'front')).toBeNull();
    expect(reorderElements(d, 'shapes', [9], 'front')).toBeNull();
    expect(ids(d)).toEqual(['a', 'b']);
  });
});
