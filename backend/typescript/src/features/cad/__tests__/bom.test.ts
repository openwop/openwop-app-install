/**
 * BOM generation (ADR 0388 P2) — golden-model → golden-BOM, byte-identical
 * determinism, roll-up identity, exact parametric metrics, typed failures,
 * CSV escaping + the CAD-C6 formula-injection guard. (Mesh rows and the
 * CAD2-B3 approximate-total disclosure are covered by `cad-mesh-routes.test.ts`
 * — they need stores.)
 *
 * Expected metrics are LITERALS derived outside `bom.ts` (closed-form formulas
 * evaluated independently, r6-rounded), compared at a fixed precision.
 * Sabotage-witnessed (/grade-tests w34): the cone `/3`, the totals reducer, the
 * material roll-up identity, the unknown-kind typed failure and each
 * neutralised CSV prefix (=, +, -, @) and CR quoting each turn a case red.
 */
import { describe, expect, it } from 'vitest';
import { generateBom, bomCsv } from '../bom.js';

const MODEL = {
  name: 'Bench',
  units: 'mm',
  solids: [
    { kind: 'box', x: 0, y: 0, z: 0, width: 100, height: 20, depth: 40, color: '#a0522d', label: 'seat' },
    { kind: 'cylinder', x: 10, y: -40, z: 5, radius: 4, length: 40, color: '#555555', label: 'leg' },
    { kind: 'cylinder', x: 90, y: -40, z: 5, radius: 4, length: 40, color: '#555555', label: 'leg' },
    { kind: 'sphere', x: 50, y: 30, z: 20, radius: 10 },
    { kind: 'cone', x: 50, y: 40, z: 20, radius: 6, length: 12, color: '#a0522d' },
  ],
};

describe('generateBom (deterministic, zero-AI)', () => {
  it('golden model → golden BOM: roll-up, exact metrics, doc-order rows', async () => {
    const bom = await generateBom('t', MODEL);
    expect(bom.modelName).toBe('Bench');
    expect(bom.units).toBe('mm');
    // 5 solids → 4 rows (two identical legs roll up), first-appearance order;
    // unlabeled solids fall back to `${kind}-${docIndex}`.
    expect(bom.rows.map((r) => [r.label, r.kind, r.quantity])).toEqual([
      ['seat', 'box', 1], ['leg', 'cylinder', 2], ['sphere-4', 'sphere', 1], ['cone-5', 'cone', 1],
    ]);
    const [seat, leg, sphere, cone] = bom.rows;
    // seat: 100·20·40 ; 2·(100·20 + 100·40 + 20·40)
    expect(seat!.volume).toBeCloseTo(80000, 6);
    expect(seat!.area).toBeCloseTo(13600, 6);
    // leg ×2: π·4²·40 each ; 2π·4·(4+40) each
    expect(leg!.volume).toBeCloseTo(4021.238597, 3);
    expect(leg!.area).toBeCloseTo(2211.681228, 3);
    // sphere r10: (4/3)π·10³ ; 4π·10²
    expect(sphere!.volume).toBeCloseTo(4188.790205, 3);
    expect(sphere!.area).toBeCloseTo(1256.637061, 3);
    // cone r6 L12: π·6²·12/3 ; π·6·(6 + √(6²+12²))
    expect(cone!.volume).toBeCloseTo(452.389342, 3);
    expect(cone!.area).toBeCloseTo(365.990666, 3);
    expect(bom.totals.parts).toBe(5);
    expect(bom.totals.volume).toBeCloseTo(88662.418143, 3);
    expect(bom.totals.area).toBeCloseTo(17434.308955, 3);
    // no parametric row (nor the total) carries the approx flag
    expect(bom.rows.every((r) => r.volumeApprox === undefined)).toBe(true);
    expect(bom.totals.volumeApprox).toBeUndefined();
  });

  it('is byte-identical across runs (the determinism gate)', async () => {
    const a = JSON.stringify(await generateBom('t', MODEL));
    const b = JSON.stringify(await generateBom('t', MODEL));
    expect(b).toBe(a);
  });

  it('same dims but different material do NOT roll up', async () => {
    const bom = await generateBom('t', {
      units: 'mm',
      solids: [
        { kind: 'box', width: 10, height: 10, depth: 10, color: '#ff0000' },
        { kind: 'box', width: 10, height: 10, depth: 10, color: '#00ff00' },
      ],
    });
    expect(bom.rows).toHaveLength(2);
  });

  it('typed failures: empty model 422; unknown kind 422', async () => {
    await expect(generateBom('t', { solids: [] })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      generateBom('t', { solids: [{ kind: 'torus', radius: 5 }] }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('CSV: header + rows + total; RFC-4180 quoting for commas/quotes', () => {
    const csv = bomCsv({
      units: 'mm',
      rows: [{ label: 'leg, front "A"', kind: 'box', quantity: 2, dimensions: { width: 10 }, volume: 1, area: 2 }],
      totals: { parts: 2, volume: 1, area: 2 },
    });
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('label,kind,quantity,dimensions,material,volume (mm³),area (mm²),volume approx');
    expect(lines[1]).toContain('"leg, front ""A"""');
    expect(lines[2]).toBe('TOTAL,,2,,,1,2,');
  });
});

describe('GRADE CAD-C6 — CSV formula-injection guard', () => {
  it('neutralizes leading =+-@ and quotes CR', async () => {
    const bom = await generateBom('t1', {
      solids: [
        { kind: 'box', width: 1, height: 1, depth: 1, label: '=HYPERLINK("http://evil","x")' },
        { kind: 'box', width: 2, height: 1, depth: 1, label: '+SUM(1)' },
        { kind: 'box', width: 3, height: 1, depth: 1, label: '-2+3' },
        { kind: 'box', width: 4, height: 1, depth: 1, label: '@cmd' },
        { kind: 'box', width: 5, height: 1, depth: 1, label: 'a\rb' },
      ],
    });
    const csv = bomCsv(bom);
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toMatch(/^=|,=/m);
    const firstCells = csv.split('\n').slice(2, 5).map((l) => l.split(',')[0]);
    expect(firstCells).toEqual([`'+SUM(1)`, `'-2+3`, `'@cmd`]);
    expect(csv).toContain('\n"a\rb",box,');
  });
});
