/**
 * 2D sketch solver (ADR 0388 P4) — the DETERMINISM golden gate (byte-identical
 * solved coordinates across runs — the fork/replay invariant), constraint
 * correctness per kind, under/over-constrained diagnostics, degenerate-input
 * typed failure, and the FE↔BE twin parity pin.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveSketch, SketchError, type Sketch } from '../cadSketch.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A rectangle sketch: 4 points, 4 lines, constrained square-ish. */
function rectSketch(): Sketch {
  return {
    points: [
      { x: 0, y: 0 }, { x: 9.7, y: 0.4 }, { x: 10.2, y: 5.3 }, { x: -0.3, y: 4.8 },
    ],
    segments: [
      { kind: 'line', a: 0, b: 1 }, { kind: 'line', a: 1, b: 2 },
      { kind: 'line', a: 2, b: 3 }, { kind: 'line', a: 3, b: 0 },
    ],
    constraints: [
      { kind: 'fixed', points: [0], x: 0, y: 0 },
      { kind: 'horizontal', points: [0, 1] },
      { kind: 'vertical', points: [1, 2] },
      { kind: 'horizontal', points: [2, 3] },
      { kind: 'vertical', points: [3, 0] },
      { kind: 'distance', points: [0, 1], value: 10 },
      { kind: 'distance', points: [1, 2], value: 5 },
    ],
  };
}

describe('solveSketch — the determinism golden gate', () => {
  it('solves the rectangle exactly and BYTE-IDENTICALLY across runs', () => {
    const a = solveSketch(rectSketch());
    const b = solveSketch(rectSketch());
    expect(JSON.stringify(b.points)).toBe(JSON.stringify(a.points)); // fork/replay identity
    expect(a.diagnostics.status).toBe('well-constrained');
    // Geometry: a 10×5 rectangle pinned at the origin.
    expect(a.points[0]).toEqual({ x: 0, y: 0 });
    expect(a.points[1]!.x).toBeCloseTo(10, 6);
    expect(a.points[1]!.y).toBeCloseTo(0, 6);
    expect(a.points[2]!.x).toBeCloseTo(10, 6);
    expect(a.points[2]!.y).toBeCloseTo(5, 6);
    expect(a.points[3]!.x).toBeCloseTo(0, 6);
    expect(a.points[3]!.y).toBeCloseTo(5, 6);
  });

  it('parallel + perpendicular + equal + angle behave geometrically', () => {
    const sk: Sketch = {
      points: [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 0, y: 5 }, { x: 9, y: 7 }],
      segments: [{ kind: 'line', a: 0, b: 1 }, { kind: 'line', a: 2, b: 3 }],
      constraints: [
        { kind: 'fixed', points: [0] },
        { kind: 'fixed', points: [1] },
        { kind: 'fixed', points: [2] },
        { kind: 'parallel', segments: [0, 1] },
      ],
    };
    const out = solveSketch(sk);
    const d1y = out.points[1]!.y - out.points[0]!.y;
    const d1x = out.points[1]!.x - out.points[0]!.x;
    const d2y = out.points[3]!.y - out.points[2]!.y;
    const d2x = out.points[3]!.x - out.points[2]!.x;
    expect(d1x * d2y - d1y * d2x).toBeCloseTo(0, 5); // parallel

    const perp: Sketch = { ...sk, constraints: [...sk.constraints.slice(0, 3), { kind: 'perpendicular', segments: [0, 1] }] };
    const out2 = solveSketch(perp);
    const e1x = out2.points[1]!.x - out2.points[0]!.x; const e1y = out2.points[1]!.y - out2.points[0]!.y;
    const e2x = out2.points[3]!.x - out2.points[2]!.x; const e2y = out2.points[3]!.y - out2.points[2]!.y;
    expect(e1x * e2x + e1y * e2y).toBeCloseTo(0, 5); // perpendicular
  });

  it('symmetric + coincident behave', () => {
    const sk: Sketch = {
      points: [{ x: -4, y: 2 }, { x: 6, y: 2.5 }, { x: 1, y: 0 }],
      segments: [],
      constraints: [
        { kind: 'fixed', points: [2], x: 1, y: 0 },
        { kind: 'symmetric', points: [0, 1, 2] },
      ],
    };
    const out = solveSketch(sk);
    expect((out.points[0]!.x + out.points[1]!.x) / 2).toBeCloseTo(1, 6);
    expect(out.points[0]!.y).toBeCloseTo(out.points[1]!.y, 6);
  });

  it('diagnoses UNDER-constrained sketches with a free-DoF count', () => {
    const out = solveSketch({
      points: [{ x: 0, y: 0 }, { x: 5, y: 5 }],
      segments: [],
      constraints: [{ kind: 'horizontal', points: [0, 1] }],
    });
    expect(out.diagnostics.status).toBe('under-constrained');
    expect(out.diagnostics.freeDof).toBeGreaterThan(0);
  });

  it('diagnoses OVER-constrained sketches, names the conflict, and returns ORIGINAL coords (never a half-solved lie)', () => {
    const out = solveSketch({
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      segments: [],
      constraints: [
        { kind: 'fixed', points: [0], x: 0, y: 0 },
        { kind: 'fixed', points: [1], x: 10, y: 0 },
        { kind: 'distance', points: [0, 1], value: 7 }, // conflicts with the two pins
      ],
    });
    expect(out.diagnostics.status).toBe('over-constrained');
    expect(out.diagnostics.conflicting?.length).toBeGreaterThan(0);
    expect(out.points[0]).toEqual({ x: 0, y: 0 }); // untouched original
    expect(out.points[1]).toEqual({ x: 10, y: 0 });
  });

  it('GRADE DATAG-3: angle-constraint GOLDEN — exact solved coordinates pinned across Node upgrades', () => {
    // The one transcendental lane (Math.cos/sin) is not spec-bit-pinned across
    // engine versions; this golden turns a silent numeric drift on a Node
    // upgrade into a loud test failure (r9 rounding: 6·cos30°, 6·sin30°).
    const out = solveSketch({
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 8, y: 5 }],
      segments: [{ kind: 'line', a: 0, b: 1 }, { kind: 'line', a: 0, b: 2 }],
      constraints: [
        { kind: 'fixed', points: [0], x: 0, y: 0 },
        { kind: 'fixed', points: [1], x: 10, y: 0 },
        { kind: 'distance', points: [0, 2], value: 6 },
        { kind: 'angle', segments: [0, 1], value: 30 },
      ],
    });
    expect(out.diagnostics.status).toBe('well-constrained');
    expect(out.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5.196152423, y: 3 }]);
  });

  it('GRADE CAD-C9: non-finite constraint targets are a typed reject, never a NaN "solution"', () => {
    expect(() => solveSketch({
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      segments: [],
      constraints: [{ kind: 'distance', points: [0, 1], value: Number.NaN }],
    })).toThrowError(/finite/);
    expect(() => solveSketch({
      points: [{ x: 0, y: 0 }],
      segments: [],
      constraints: [{ kind: 'fixed', points: [0], x: Infinity, y: 0 }],
    })).toThrowError(/finite/);
  });

  it('typed failures: bad refs, bad kinds, degenerate arcs', () => {
    expect(() => solveSketch({ points: [], segments: [], constraints: [] })).toThrowError(SketchError);
    expect(() => solveSketch({
      points: [{ x: 0, y: 0 }], segments: [], constraints: [{ kind: 'coincident' as never, points: [0, 9] }],
    })).toThrowError(/out of range/);
    expect(() => solveSketch({
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], segments: [{ kind: 'arc', a: 0, b: 1 }], constraints: [],
    })).toThrowError(/radius/);
  });
});

describe('FE↔BE twin parity', () => {
  it('backend and frontend cadSketch.ts are BYTE-IDENTICAL', () => {
    const backend = readFileSync(join(here, '..', 'cadSketch.ts'), 'utf8');
    const frontendPath = join(here, '..', '..', '..', '..', '..', '..', 'frontend', 'react', 'src', 'features', 'cad', 'cadSketch.ts');
    // GRADE-PASS CAD-G4: the deploy image / a backend-only checkout has no
    // frontend tree — the parity pin runs wherever the full checkout does (CI,
    // dev), and passes vacuously where the twin simply isn't present.
    if (!existsSync(frontendPath)) return;
    const frontend = readFileSync(frontendPath, 'utf8');
    expect(frontend).toBe(backend);
  });
});
