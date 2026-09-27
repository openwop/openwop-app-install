/**
 * DRAW-R4/DATA-D9 — the save-boundary clamp. `clampDocForSave` bounds every
 * numeric/text field to its propDef limits so a value that reached the doc
 * without a widget blur (paste, programmatic, AI-authored) can't 422 the CAS
 * save — while preserving the clone-on-edit invariant (unchanged elements are
 * shared, never mutated).
 */
import { describe, expect, it } from 'vitest';
import { clampNumber, clampValue, clampDocForSave } from '../propBounds.js';
import type { CanvasPropDef } from '../types.js';

const numDef = (name: string, min?: number, max?: number): CanvasPropDef => ({ name, type: 'number', label: name, min, max });
const strDef = (name: string, maxLength: number): CanvasPropDef => ({ name, type: 'string', label: name, maxLength });

describe('clampNumber', () => {
  it('bounds into [min,max] and passes undefined bounds through', () => {
    expect(clampNumber(150, 0, 100)).toBe(100);
    expect(clampNumber(-5, 0, 100)).toBe(0);
    expect(clampNumber(40, 0, 100)).toBe(40);
    expect(clampNumber(9999, undefined, undefined)).toBe(9999);
    expect(clampNumber(2, 0.5)).toBe(2); // min-only
  });
});

describe('clampValue', () => {
  it('clamps finite numbers, passes non-finite/undefined through', () => {
    expect(clampValue(150, numDef('w', 0, 100))).toBe(100);
    expect(clampValue(undefined, numDef('w', 0, 100))).toBeUndefined();
    expect(clampValue(NaN, numDef('w', 0, 100))).toBeNaN();
    expect(clampValue('nope', numDef('w', 0, 100))).toBe('nope');
  });
  it('truncates over-length strings, leaves shorter ones by reference', () => {
    expect(clampValue('abcdef', strDef('t', 3))).toBe('abc');
    const short = 'ab';
    expect(clampValue(short, strDef('t', 3))).toBe(short);
  });
  it('a def without bounds never changes the value', () => {
    expect(clampValue(9999, numDef('x'))).toBe(9999);
    expect(clampValue('anything', { name: 's', type: 'string', label: 's' })).toBe('anything');
  });
});

describe('clampDocForSave', () => {
  const def = {
    elements: [{ key: 'shapes', propDefs: (el: Record<string, unknown>) => (el.kind === 'stroke' ? [numDef('opacity', 0, 1)] : [numDef('strokeWidth', 0, 100), strDef('text', 3)]) }],
    docPropDefs: [numDef('width', 1, 4000)],
  };

  it('clamps out-of-range element and doc fields', () => {
    const doc = { width: 9000, shapes: [{ kind: 'rect', strokeWidth: 500, text: 'toolong' }] };
    const out = clampDocForSave(doc, def) as typeof doc;
    expect(out.width).toBe(4000);
    expect(out.shapes[0]!.strokeWidth).toBe(100);
    expect(out.shapes[0]!.text).toBe('too');
  });

  it('per-element propDefs are honored (a stroke clamps opacity, not strokeWidth)', () => {
    const doc = { width: 100, shapes: [{ kind: 'stroke', opacity: 5, strokeWidth: 999 }] };
    const out = clampDocForSave(doc, def) as typeof doc;
    expect(out.shapes[0]!.opacity).toBe(1);
    expect(out.shapes[0]!.strokeWidth).toBe(999); // not a stroke propDef → untouched
  });

  it('an already-bounded doc is returned by reference (no churn)', () => {
    const doc = { width: 800, shapes: [{ kind: 'rect', strokeWidth: 2, text: 'ok' }] };
    expect(clampDocForSave(doc, def)).toBe(doc);
  });

  it('preserves the clone-on-edit invariant — unchanged elements are shared, the input never mutated', () => {
    const shared = { kind: 'rect', strokeWidth: 2, text: 'ok' };
    const changed = { kind: 'rect', strokeWidth: 500, text: 'ok' };
    const doc = { width: 800, shapes: [shared, changed] };
    const out = clampDocForSave(doc, def) as typeof doc;
    expect(out).not.toBe(doc);                 // a new doc
    expect(out.shapes).not.toBe(doc.shapes);   // a new array
    expect(out.shapes[0]).toBe(shared);        // the unchanged element is the SAME reference
    expect(out.shapes[1]).not.toBe(changed);   // the clamped element is a copy
    expect(changed.strokeWidth).toBe(500);     // the original element is NOT mutated
  });
});
