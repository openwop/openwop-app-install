/**
 * Canvas framework elementOps tests (ADR 0310 Phase C) — the flat
 * element-collection helpers behind the elements trait: cap/min guards,
 * clamped moves, positional duplication.
 */
import { describe, expect, it } from 'vitest';
import { addElement, duplicateElement, moveElement, readElements, removeElement } from '../elementOps.js';

const doc = (): { shapes: Record<string, unknown>[] } => ({
  shapes: [{ kind: 'rect' }, { kind: 'circle' }, { kind: 'text', text: 'hi' }],
});

describe('elementOps', () => {
  it('adds up to the cap and reports the new index', () => {
    const d = { shapes: [] as Record<string, unknown>[] };
    expect(addElement(d, 'shapes', { kind: 'rect' }, 2)).toBe(0);
    expect(addElement(d, 'shapes', { kind: 'circle' }, 2)).toBe(1);
    expect(addElement(d, 'shapes', { kind: 'line' }, 2)).toBe(-1);
    expect(d.shapes).toHaveLength(2);
  });

  it('creates the collection on write but not on read', () => {
    const d: Record<string, unknown> = {};
    expect(readElements(d, 'funnel')).toEqual([]);
    expect('funnel' in d).toBe(false);
    expect(addElement(d, 'funnel', { stage: 'awareness' }, 12)).toBe(0);
    expect(readElements(d, 'funnel')).toHaveLength(1);
  });

  it('refuses removal below min (the schema minItems guard)', () => {
    const d = { shapes: [{ kind: 'rect' }] };
    expect(removeElement(d, 'shapes', 0, 1)).toBe(false);
    expect(d.shapes).toHaveLength(1);
    const d2 = doc();
    expect(removeElement(d2, 'shapes', 1, 1)).toBe(true);
    expect(d2.shapes.map((s) => s.kind)).toEqual(['rect', 'text']);
  });

  it('moves with clamping and returns the landed index', () => {
    const d = doc();
    expect(moveElement(d, 'shapes', 0, 2)).toBe(2);
    expect(d.shapes.map((s) => s.kind)).toEqual(['circle', 'text', 'rect']);
    expect(moveElement(d, 'shapes', 2, -5)).toBe(0);
    expect(d.shapes.map((s) => s.kind)).toEqual(['rect', 'circle', 'text']);
    expect(moveElement(d, 'shapes', 9, 0)).toBe(9); // invalid index → no-op
  });

  it('duplicates deep and respects the cap', () => {
    const d = doc();
    const i = duplicateElement(d, 'shapes', 2, 10);
    expect(i).toBe(3);
    expect(d.shapes[3]).toEqual({ kind: 'text', text: 'hi' });
    expect(d.shapes[3]).not.toBe(d.shapes[2]);
    expect(duplicateElement(d, 'shapes', 0, 4)).toBe(-1); // at cap
  });
});
