/**
 * ADR 0174 — market-intel.shift-detect node: a deterministic diff of two prior
 * market-research result sets → a MarketShiftAlert. Pure (no ctx.callAI), so it is
 * tested directly with in-memory inputs. Replay-safe by construction.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(out.outputs.alert.hasShift).toBe(false);
    expect(out.outputs.alert.newPains).toEqual([]);
  });

  it('detects new + resolved pain points', async () => {
    const prev = { records: [{ quote: 'billing is confusing', tagType: 'pain' }] };
    const curr = { records: [{ quote: 'setup takes forever', tagType: 'pain' }] };
    const out = await run(prev, curr);
    expect(out.outputs.alert.hasShift).toBe(true);
    expect(out.outputs.alert.newPains.map((p: { quote: string }) => p.quote)).toContain('setup takes forever');
    expect(out.outputs.alert.resolvedPains.map((p: { quote: string }) => p.quote)).toContain('billing is confusing');
    expect(out.outputs.alert.summary).toMatch(/new pain point/);
  });

  it('detects intensifying pains (confidence delta) + angle-score deltas', async () => {
    const prev = { records: [{ quote: 'price too high', tagType: 'objection', confidence: 0.5 }], angles: [{ id: 'value', score: 0.4 }] };
    const curr = { records: [{ quote: 'price too high', tagType: 'objection', confidence: 0.8 }], angles: [{ id: 'value', score: 0.75 }] };
    const out = await run(prev, curr);
    expect(out.outputs.alert.intensifiedPains).toHaveLength(1);
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
});
