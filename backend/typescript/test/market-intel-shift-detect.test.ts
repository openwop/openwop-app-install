/**
 * ADR 0174 — market-intel.shift-detect node: a deterministic diff of two prior
 * market-research result sets → a MarketShiftAlert. Pure (no ctx.callAI), so it is
 * tested directly with in-memory inputs. Replay-safe by construction.
 *
 * Red if the pain-set diff, the 0.15 confidence threshold, the angle delta or the
 * summary changes; the determinism case reds on any clock/random use (replay).
 * ADR 1116 D4 (CC-CHAIN-7): also red if a missing previous or current set reads
 * as "no shift" instead of a typed failure, if the chain's `records` +
 * `rankedAngles` ports stop counting as the current set, if `config.previous`
 * stops being read, or if `snapshot` stops being the next run's `previous`.
 */
import { describe, it, expect } from 'vitest';
import { nodes } from '../../../packs/vendor.myndhyve.market-intel-shift-detect/index.mjs';

interface Alert {
  newPains: { quote: string; tagType: string }[];
  resolvedPains: { quote: string; tagType: string }[];
  intensifiedPains: { quote: string; delta: number }[];
  angleDeltas: { angle: string; before: number; after: number; delta: number }[];
  summary: string;
  hasShift: boolean;
}
async function run(previous: unknown, current: unknown): Promise<{ status: string; outputs: { alert: Alert } }> {
  const out = await nodes['market-intel.shift-detect']({ inputs: { previous, current } });
  return out as { status: string; outputs: { alert: Alert } };
}

describe('market-intel.shift-detect', () => {
  it('reports no shift for identical result sets', async () => {
    const set = { records: [{ quote: 'onboarding is slow', tagType: 'pain' }], angles: [{ id: 'a1', score: 0.7 }] };
    const out = await run(set, set);
    expect(out.status).toBe('success');
    expect(out.outputs.alert).toEqual({
      newPains: [], resolvedPains: [], intensifiedPains: [], angleDeltas: [],
      summary: 'No material market shift since the prior research run.', hasShift: false,
    });
  });

  it('detects new + resolved pain points', async () => {
    const prev = { records: [{ quote: 'billing is confusing', tagType: 'pain' }] };
    const curr = { records: [{ quote: 'setup takes forever', tagType: 'pain' }] };
    const out = await run(prev, curr);
    expect(out.outputs.alert.hasShift).toBe(true);
    expect(out.outputs.alert.newPains).toEqual([{ tagType: 'pain', quote: 'setup takes forever' }]);
    expect(out.outputs.alert.resolvedPains).toEqual([{ tagType: 'pain', quote: 'billing is confusing' }]);
    expect(out.outputs.alert.summary).toBe('Market shift detected: 1 new pain point(s), 1 resolved.');
  });

  it('detects intensifying pains (confidence delta) + angle-score deltas', async () => {
    // `support slow` rises by 0.1 — under the 0.15 threshold, so it must NOT intensify.
    const prev = { records: [{ quote: 'price too high', tagType: 'objection', confidence: 0.5 }, { quote: 'support slow', tagType: 'pain', confidence: 0.5 }], angles: [{ id: 'value', score: 0.4 }] };
    const curr = { records: [{ quote: 'price too high', tagType: 'objection', confidence: 0.8 }, { quote: 'support slow', tagType: 'pain', confidence: 0.6 }], angles: [{ id: 'value', score: 0.75 }] };
    const out = await run(prev, curr);
    expect(out.outputs.alert.intensifiedPains).toHaveLength(1);
    expect(out.outputs.alert.intensifiedPains[0].quote).toBe('price too high');
    expect(out.outputs.alert.intensifiedPains[0].delta).toBeCloseTo(0.3, 5);
    expect(out.outputs.alert.angleDeltas[0]).toMatchObject({ angle: 'value', delta: expect.closeTo(0.35, 5) });
    expect(out.outputs.alert.hasShift).toBe(true);
  });

  it('is deterministic (same inputs → identical output)', async () => {
    const prev = { records: [{ quote: 'a', tagType: 'pain' }, { quote: 'b', tagType: 'desire' }] };
    const curr = { records: [{ quote: 'b', tagType: 'desire' }, { quote: 'c', tagType: 'pain' }] };
    const a = await run(prev, curr);
    const b = await run(prev, curr);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  // ADR 1116 D4 — the market-intel chain's shape, and no false all-clear.
  const call = (inputs: unknown, config?: unknown) =>
    nodes['market-intel.shift-detect']({ inputs, config }) as Promise<{ status: string; outputs?: { alert: Alert; snapshot: { records: unknown[]; angles: unknown[] } }; error?: { code: string; message: string } }>;

  it('a missing current set is a typed failure, never "no shift"', async () => {
    const out = await call({ previous: { records: [{ quote: 'a', tagType: 'pain' }] } });
    expect(out.status).toBe('error');
    expect(out.error!.code).toBe('INVALID_INPUTS');
    expect(out.error!.message).toContain('current is required');
  });

  it('a missing previous set is a typed failure', async () => {
    const out = await call({ current: { records: [] } });
    expect(out.status).toBe('error');
    expect(out.error!.code).toBe('INVALID_INPUTS');
    expect(out.error!.message).toContain('previous is required');
  });

  it('records + rankedAngles (the chain ports) are the current set; score.total is the angle score', async () => {
    const out = await call({
      previous: JSON.stringify({ records: [{ quote: 'old pain', tagType: 'pain' }], angles: [{ id: 'own-onboarding', score: 5 }] }),
      records: [{ quote: 'new pain', tagType: 'pain', confidence: 0.8 }],
      rankedAngles: [{ angleId: 'own-onboarding', angleName: 'Own onboarding', score: { total: 6.4 } }],
    });
    expect(out.status).toBe('success');
    expect(out.outputs!.alert.newPains.map((p) => p.quote)).toEqual(['new pain']);
    expect(out.outputs!.alert.resolvedPains.map((p) => p.quote)).toEqual(['old pain']);
    expect(out.outputs!.alert.angleDeltas).toEqual([{ angle: 'own-onboarding', before: 5, after: 6.4, delta: 1.4 }]);
    expect(out.outputs!.snapshot).toEqual({ records: [{ quote: 'new pain', tagType: 'pain', confidence: 0.8 }], angles: [{ id: 'own-onboarding', score: 6.4 }] });
  });

  it('previous is still read from config when inputs lack it (back-compat)', async () => {
    const out = await call({ current: { records: [{ quote: 'x', tagType: 'pain' }] } }, { previous: { records: [{ quote: 'x', tagType: 'pain' }] } });
    expect(out.status).toBe('success');
    expect(out.outputs!.alert).toMatchObject({ hasShift: false, newPains: [], resolvedPains: [] });
  });
});
