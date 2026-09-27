/**
 * BOM generation (ADR 0388 P2) — golden-model → golden-BOM, byte-identical
 * determinism, roll-up identity, exact parametric metrics, typed failures,
 * CSV escaping. (Mesh rows are covered by the route test — they need stores.)
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
    const bom = await generateBom('t', MODEL as never);
    expect(bom.modelName).toBe('Bench');
    expect(bom.units).toBe('mm');
    // 5 solids → 4 rows (two identical legs roll up)
    expect(bom.rows).toHaveLength(4);
    const leg = bom.rows.find((r) => r.label === 'leg');
    expect(leg?.quantity).toBe(2);
    // exact cylinder volume: 2 × π r² L
    expect(leg?.volume).toBeCloseTo(2 * Math.PI * 16 * 40, 3);
    const seat = bom.rows[0];
    expect(seat?.label).toBe('seat'); // first-appearance order
    expect(seat?.volume).toBeCloseTo(100 * 20 * 40, 6);
    expect(seat?.area).toBeCloseTo(2 * (100 * 20 + 100 * 40 + 20 * 40), 6);
    const sphere = bom.rows.find((r) => r.kind === 'sphere');
    expect(sphere?.volume).toBeCloseTo((4 / 3) * Math.PI * 1000, 3);
    expect(bom.totals.parts).toBe(5);
    // no parametric row carries the approx flag
    expect(bom.rows.every((r) => r.volumeApprox === undefined)).toBe(true);
  });

  it('is byte-identical across runs (the determinism gate)', async () => {
    const a = JSON.stringify(await generateBom('t', MODEL as never));
    const b = JSON.stringify(await generateBom('t', MODEL as never));
    expect(b).toBe(a);
  });

  it('same dims but different material do NOT roll up', async () => {
    const bom = await generateBom('t', {
      units: 'mm',
      solids: [
        { kind: 'box', width: 10, height: 10, depth: 10, color: '#ff0000' },
        { kind: 'box', width: 10, height: 10, depth: 10, color: '#00ff00' },
      ],
    } as never);
    expect(bom.rows).toHaveLength(2);
  });

  it('typed failures: empty model 422; unknown kind 422', async () => {
    await expect(generateBom('t', { solids: [] } as never)).rejects.toMatchObject({ httpStatus: 422 });
    await expect(
      generateBom('t', { solids: [{ kind: 'torus', radius: 5 }] } as never),
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
    expect(lines[1]).toContain('"leg, front ""A"""');
    expect(lines[2]).toMatch(/^TOTAL/);
  });
});

describe('GRADE CAD-C6 — CSV formula-injection guard', () => {
  it('neutralizes leading =+-@ and quotes CR', async () => {
    const bom = await generateBom('t1', {
      solids: [{ kind: 'box', width: 1, height: 1, depth: 1, label: '=HYPERLINK("http://evil","x")' }],
    });
    const csv = bomCsv(bom);
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).not.toMatch(/^=|,=/m);
  });
});
