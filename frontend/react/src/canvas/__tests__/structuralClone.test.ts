/**
 * Structural clone-for-edit (ADR 0333 grade pass DRAW-R1) — the load-bearing
 * safety proof: an edit through the returned doc must NEVER mutate the source
 * (a prior history snapshot), yet unchanged elements must be SHARED (that's the
 * whole point — memory + churn). Pins exactly the aliasing hazard the architect
 * gate called out.
 */
import { describe, it, expect } from 'vitest';
import { structuralClone, readElements, addElement } from '../elementOps.js';

const doc = () => ({
  title: 'D',
  shapes: [
    { kind: 'rect', x: 0, y: 0, points: [{ x: 1, y: 1 }] },
    { kind: 'circle', cx: 5, cy: 5 },
    { kind: 'stroke', points: [{ x: 2, y: 2 }], pressures: [0.5] },
  ] as Record<string, unknown>[],
});

describe('structuralClone', () => {
  it('shares unchanged elements but deep-copies the touched one', () => {
    const src = doc();
    const next = structuralClone(src, 'shapes', [1]);
    expect(next).not.toBe(src);                       // new doc object
    expect(next.shapes).not.toBe(src.shapes);         // new array
    expect(next.shapes[0]).toBe(src.shapes[0]);       // element 0 SHARED
    expect(next.shapes[2]).toBe(src.shapes[2]);       // element 2 SHARED
    expect(next.shapes[1]).not.toBe(src.shapes[1]);   // element 1 DEEP-COPIED
  });

  it('mutating the touched element never touches the source (the invariant)', () => {
    const src = doc();
    const snapshot = JSON.stringify(src);
    const next = structuralClone(src, 'shapes', [0]);
    (next.shapes[0] as { x: number }).x = 999;
    (readElements(next, 'shapes')[0] as { points: { x: number }[] }).points[0].x = 888; // nested array too
    expect(JSON.stringify(src)).toBe(snapshot); // source byte-identical — no aliasing
  });

  it('deep-copies nested arrays so a spine edit cannot corrupt a snapshot', () => {
    const src = doc();
    const next = structuralClone(src, 'shapes', [2]);
    expect(next.shapes[2]).not.toBe(src.shapes[2]);
    expect((next.shapes[2] as { points: unknown[] }).points).not.toBe((src.shapes[2] as { points: unknown[] }).points);
    expect((next.shapes[2] as { pressures: unknown[] }).pressures).not.toBe((src.shapes[2] as { pressures: unknown[] }).pressures);
  });

  it('add-path (deepIdxs=[]) shares all existing elements; splice/push hit only the copy', () => {
    const src = doc();
    const next = structuralClone(src, 'shapes');
    next.shapes.forEach((el, i) => expect(el).toBe(src.shapes[i])); // every element shared
    addElement(next, 'shapes', { kind: 'text' }, 100);
    expect(src.shapes).toHaveLength(3); // source array untouched
    expect(next.shapes).toHaveLength(4);
  });

  it('handles an absent collection (fresh empty array, source unchanged)', () => {
    const src = { title: 'x' } as Record<string, unknown>;
    const next = structuralClone(src, 'shapes', [0]);
    expect(next.shapes).toEqual([]);
    expect(src.shapes).toBeUndefined();
  });
});
