/**
 * Dimension system (ADR 0388 P3) — derived values, the flat tolerance grammar
 * (validator closed-world), deterministic suggestions, and the FE↔BE twin
 * byte-parity pin.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveDimensionValue, formatDimension, suggestDimensions } from '../cadDims.js';
import { validateCadDoc } from '../validateCadDoc.js';

const here = dirname(fileURLToPath(import.meta.url));

const BOX = { kind: 'box', width: 20, height: 10, depth: 30 };
const CYL = { kind: 'cylinder', radius: 5, length: 40 };

describe('deriveDimensionValue (values never stored — derived at read)', () => {
  it('derives per kind/axis; unmeasurable combos are null, never fake numbers', () => {
    expect(deriveDimensionValue(BOX, { kind: 'linear', solid: 0, axis: 'x' })).toBe(20);
    expect(deriveDimensionValue(BOX, { kind: 'linear', solid: 0, axis: 'z' })).toBe(30);
    expect(deriveDimensionValue(CYL, { kind: 'radial', solid: 0 })).toBe(5);
    expect(deriveDimensionValue(CYL, { kind: 'diameter', solid: 0 })).toBe(10);
    expect(deriveDimensionValue(CYL, { kind: 'linear', solid: 0, axis: 'z' })).toBe(40);
    expect(deriveDimensionValue({ kind: 'sphere', radius: 7 }, { kind: 'diameter', solid: 0 })).toBe(14);
    expect(deriveDimensionValue({ ...BOX, rotation: 30 }, { kind: 'angular', solid: 0 })).toBe(30);
    // radial on a box is NOT measurable
    expect(deriveDimensionValue(BOX, { kind: 'radial', solid: 0 })).toBeNull();
    // mesh extent comes from the injected bbox reader (× scale)
    expect(deriveDimensionValue({ kind: 'mesh', scale: 2 }, { kind: 'linear', solid: 0, axis: 'x' }, () => 15)).toBe(30);
    expect(deriveDimensionValue({ kind: 'mesh' }, { kind: 'linear', solid: 0, axis: 'x' }, () => null)).toBeNull();
  });

  it('formats values with the tolerance grammar', () => {
    expect(formatDimension(20, { kind: 'linear', solid: 0, tolType: 'symmetric', tolA: 0.5 }, 'mm')).toBe('20 mm ±0.5');
    expect(formatDimension(20, { kind: 'linear', solid: 0, tolType: 'asymmetric', tolA: 0.2, tolB: 0.1 }, 'mm')).toBe('20 mm +0.2/−0.1');
    expect(formatDimension(90, { kind: 'angular', solid: 0 }, 'mm')).toBe('90°');
  });
});

describe('suggestDimensions (deterministic)', () => {
  it('proposes primary dims per kind, skips covered solids, identical across runs', () => {
    const solids = [BOX, CYL, { kind: 'sphere', radius: 9 }];
    const a = suggestDimensions(solids, [], 'mm');
    const b = suggestDimensions(solids, [], 'mm');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.filter((d) => d.solid === 0)).toHaveLength(3); // box: 3 linear
    expect(a.filter((d) => d.solid === 1).map((d) => d.kind)).toEqual(['diameter', 'linear']);
    expect(a.filter((d) => d.solid === 2).map((d) => d.kind)).toEqual(['diameter']);
    // a covered solid gets no proposals
    const c = suggestDimensions(solids, [{ kind: 'linear', solid: 0, axis: 'x' }], 'mm');
    expect(c.every((d) => d.solid !== 0)).toBe(true);
  });
});

describe('validateCadDoc — dimensions mirror (closed world)', () => {
  const base = { name: 'D', units: 'mm', solids: [BOX, CYL] };
  const ok = (dims: unknown): number => validateCadDoc({ ...base, dimensions: dims } as never).errors.length;

  it('accepts a valid dimension set', () => {
    expect(ok([
      { kind: 'linear', solid: 0, axis: 'x', unit: 'mm', tolType: 'symmetric', tolA: 0.1 },
      { kind: 'diameter', solid: 1, tolType: 'limit', tolA: 5.1, tolB: 4.9 },
    ])).toBe(0);
  });

  it('rejects: out-of-range solid, missing axis, wrong unit, bad tolerance grammar, unknown field', () => {
    expect(ok([{ kind: 'linear', solid: 9, axis: 'x' }])).toBeGreaterThan(0);
    expect(ok([{ kind: 'linear', solid: 0 }])).toBeGreaterThan(0); // linear needs axis
    expect(ok([{ kind: 'radial', solid: 1, axis: 'x' }])).toBeGreaterThan(0); // axis only on linear/ordinate
    expect(ok([{ kind: 'linear', solid: 0, axis: 'x', unit: 'in' }])).toBeGreaterThan(0); // unit ≠ doc
    expect(ok([{ kind: 'linear', solid: 0, axis: 'x', tolA: 0.1 }])).toBeGreaterThan(0); // tolA without tolType
    expect(ok([{ kind: 'linear', solid: 0, axis: 'x', tolType: 'asymmetric', tolA: 0.1 }])).toBeGreaterThan(0); // missing tolB
    expect(ok([{ kind: 'linear', solid: 0, axis: 'x', tolType: 'limit', tolA: 1, tolB: 2 }])).toBeGreaterThan(0); // upper < lower
    expect(ok([{ kind: 'linear', solid: 0, axis: 'x', bogus: 1 }])).toBeGreaterThan(0);
  });
});

describe('FE↔BE twin parity', () => {
  it('backend and frontend cadDims.ts are BYTE-IDENTICAL', () => {
    const backend = readFileSync(join(here, '..', 'cadDims.ts'), 'utf8');
    const frontendPath = join(here, '..', '..', '..', '..', '..', '..', 'frontend', 'react', 'src', 'features', 'cad', 'cadDims.ts');
    // GRADE-PASS CAD-G4: the deploy image / a backend-only checkout has no
    // frontend tree — the parity pin runs wherever the full checkout does (CI,
    // dev), and passes vacuously where the twin simply isn't present.
    if (!existsSync(frontendPath)) return;
    const frontend = readFileSync(frontendPath, 'utf8');
    expect(frontend).toBe(backend);
  });
});
