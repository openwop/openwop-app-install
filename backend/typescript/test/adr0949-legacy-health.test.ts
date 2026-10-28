/**
 * ADR 0949 P0 (E-4) — the funnel step projection withholds `significant` on a
 * sample ratio mismatch, like the CMS projection (whose route-level cases live in
 * `cms-page-experiments.test.ts`). The CDP read and the funnel row are stubbed:
 * what is under test is the projection, not ingest.
 *
 * Sabotage (run 2026-10-20): `withheld = false` in funnelStats reds the
 * mismatch case.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Evt = { eventType: string; payload: Record<string, unknown>; at: string };
const events: Evt[] = [];
vi.mock('../src/features/cdp/collectService.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listCollectedEvents: async () => events,
}));
vi.mock('../src/features/funnels/funnelsService.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFunnel: async () => ({
    funnelId: 'f1',
    steps: [{ stepId: 's1', experiment: { experimentId: 'x1', status: 'running', salt: 's', createdAt: '2026-10-01T00:00:00.000Z', variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: 'p2', weight: 50 }] } }],
  }),
}));

const { stepExperimentResults } = await import('../src/features/funnels/funnelStats.js');
const { createApp } = await import('../src/index.js');
// ADR 0949 P1b — the projection now reads the rollup it rebuilds, so storage is real.
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
const { legacyResultHealth } = await import('../src/host/experiments/legacyHealth.js');

function seed(arm: string, viewed: number, completed: number): void {
  for (let i = 0; i < viewed; i++) {
    const payload = { stepId: 's1', visitor: `${arm}-${i}`, experiment: { experimentId: 'x1', variant: arm } };
    events.push({ eventType: 'funnel.step_viewed', payload, at: '2026-10-02T00:00:00.000Z' });
    if (i < completed) events.push({ eventType: 'funnel.step_completed', payload, at: '2026-10-02T01:00:00.000Z' });
  }
}

describe('ADR 0949 P0 — funnel step results', () => {
  it('a balanced split keeps its verdict', async () => {
    events.length = 0;
    seed('control', 100, 10); seed('b', 100, 40);
    const r = await stepExperimentResults('t', 'o', 'f1', 's1');
    expect(r?.health.srm).toMatchObject({ mismatch: false, chiSquare: 0 });
    expect(r?.significanceWithheld).toBeUndefined();
    expect(r?.variants[1]?.significant).toBe(true);
  });
  it('a broken split withholds every verdict', async () => {
    events.length = 0;
    seed('control', 300, 30); seed('b', 100, 40);
    const r = await stepExperimentResults('t', 'o', 'f1', 's1');
    expect(r?.health.srm).toMatchObject({ mismatch: true, chiSquare: 100 });
    expect(r?.significanceWithheld).toBe('srm');
    expect(r?.variants.map((v) => v.significant)).toEqual([null, null]);
  });
});

describe('legacyResultHealth', () => {
  it('always carries the stop-early notice; no SRM with no traffic', () => {
    expect(legacyResultHealth([0, 0], [50, 50])).toEqual({ srm: null, stopEarly: 'fixed_horizon_do_not_stop_early' });
  });
});
