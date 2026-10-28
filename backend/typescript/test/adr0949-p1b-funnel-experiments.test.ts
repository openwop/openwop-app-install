/**
 * ADR 0949 P1b — funnel step experiments on the engine, the daily rollup, and
 * the shared projection.
 *
 *   1. Assignment is byte-identical to the pre-engine formula
 *      (`assignWeightedVariant(vk, 'funnel:<f>:step:<s>', salt, variants)`) over
 *      100,000 keys.
 *   2. Writes go to the engine and the funnel row (the rollback mirror); a
 *      replaced split, a removed step and a deleted funnel take their engine row
 *      with them.
 *   3. A pre-P1b step experiment (no engine row) is imported on its first read; a
 *      stop written only to the mirror (the previous image during a rollback)
 *      converges the engine to stopped.
 *   4. E-2: results count every retained event. An exposure older than the newest
 *      50,000 events (the old window) still counts; a unit is counted once,
 *      at its first exposure.
 *   5. E-2: once retention purges events from the experiment's life, the verdict
 *      is withheld (`significanceWithheld: 'coverage'`).
 *
 * Sabotage (run 2026-10-20): reading the old 50,000 window reds 4; dropping the
 * coverage check in the projection reds 5; deleting the mirror-stop convergence
 * reds 3; dropping the step-removal cascade reds 2.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Evt = { eventId: string; tenantId: string; eventType: string; payload: Record<string, unknown>; piiFields: string[]; at: string };
const synthetic: Evt[] = [];
vi.mock('../src/features/cdp/collectService.js', async (orig) => {
  const real = await orig<typeof import('../src/features/cdp/collectService.js')>();
  // The real read sorts newest-first and slices to `limit`; keep that contract
  // so a caller still asking for the old window would lose the oldest events.
  return { ...real, listCollectedEvents: async (tenantId: string, limit = 100) => synthetic.filter((e) => e.tenantId === tenantId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit) };
});

const { createApp } = await import('../src/index.js');
const { assignWeightedVariant } = await import('../src/host/variantAssignment.js');
const { getExperimentRow, putExperimentRow } = await import('../src/host/experiments/store.js');
const { createPage, transitionPage } = await import('../src/features/cms/cmsService.js');
const { collectEvent } = await import('../src/features/cdp/collectService.js');
const { purgeRetained } = await import('../src/host/retentionPurger.js');
const svc = await import('../src/features/funnels/funnelsService.js');
const { stepExperimentResults } = await import('../src/features/funnels/funnelStats.js');
const { stepToEngine } = await import('../src/features/funnels/stepExperimentsEngine.js');
const { DurableCollection } = await import('../src/host/hostExtPersistence.js');

let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

async function funnelWithSplit(stepIds = ['s1']) {
  const tenantId = `t-p1b-${n++}`;
  const orgId = 'o-p1b';
  const page = await createPage({ tenantId, orgId, title: `P ${n}`, createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
  await transitionPage(tenantId, orgId, page.pageId, 'publish', 'u');
  const f = await svc.createFunnel({ tenantId, orgId, createdBy: 'u', name: `F ${n}`, steps: stepIds.map((stepId) => ({ stepId, kind: 'landing', pageId: page.pageId })) });
  const withExp = await svc.setStepExperiment(tenantId, orgId, f.funnelId, stepIds[0]!, [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: null, weight: 50 }]);
  return { tenantId, orgId, page, funnel: withExp!, exp: withExp!.steps[0]!.experiment! };
}

const view = (tenantId: string, orgId: string, stepId: string, experimentId: string, visitor: string, variant: string, at: string, type = 'funnel.step_viewed'): Evt =>
  ({ eventId: `e-${n++}`, tenantId, eventType: type, payload: { orgId, stepId, visitor, experiment: { experimentId, variant } }, piiFields: [], at });

describe('ADR 0949 P1b — 1. assignment witness', () => {
  it('is byte-identical to the pre-engine formula over 100,000 keys', () => {
    const variants = [{ key: 'a', pageId: null, weight: 20 }, { key: 'b', pageId: 'p2', weight: 30 }, { key: 'c', pageId: 'p3', weight: 50 }];
    const funnel = { funnelId: 'f-w', tenantId: 't', orgId: 'o' } as Parameters<typeof svc.assignStepVariant>[0];
    const step = { stepId: 's-w', kind: 'landing', pageId: 'p', experiment: { experimentId: 'x-w', status: 'running' as const, salt: 'abcd1234', variants, createdAt: '2026-10-01T00:00:00.000Z' } };
    for (let i = 0; i < 100_000; i++) {
      const vk = `vk-${i}`;
      expect(svc.assignStepVariant(funnel, step as never, vk)?.key).toBe(assignWeightedVariant(vk, 'funnel:f-w:step:s-w', 'abcd1234', variants));
    }
  });
});

describe('ADR 0949 P1b — 2/3. engine record, mirror, cascades, import', () => {
  it('a split is written to the engine and mirrored on the funnel row; stop reaches both', async () => {
    const { tenantId, orgId, funnel, exp } = await funnelWithSplit();
    expect(await getExperimentRow(tenantId, orgId, exp.experimentId)).toMatchObject({ surface: { kind: 'funnel.step', ref: `${funnel.funnelId}:s1` }, assignmentScope: `funnel:${funnel.funnelId}:step:s1`, status: 'running', legacy: true });
    const stopped = await svc.stopStepExperiment(tenantId, orgId, funnel.funnelId, 's1');
    expect(stopped?.steps[0]?.experiment?.status).toBe('stopped');
    expect((await getExperimentRow(tenantId, orgId, exp.experimentId))?.status).toBe('stopped');
  });

  it('a replaced split, a removed step and a deleted funnel take their engine rows', async () => {
    const { tenantId, orgId, page, funnel, exp } = await funnelWithSplit(['s1', 's2']);
    const replaced = await svc.setStepExperiment(tenantId, orgId, funnel.funnelId, 's1', [{ key: 'x', pageId: null, weight: 50 }, { key: 'y', pageId: null, weight: 50 }]);
    expect(await getExperimentRow(tenantId, orgId, exp.experimentId)).toBeNull();
    const second = replaced!.steps[0]!.experiment!;
    await svc.updateFunnel(tenantId, orgId, funnel.funnelId, { steps: [{ stepId: 's2', kind: 'landing', pageId: page.pageId }] });
    expect(await getExperimentRow(tenantId, orgId, second.experimentId)).toBeNull();
    const again = await svc.setStepExperiment(tenantId, orgId, funnel.funnelId, 's2', [{ key: 'x', pageId: null, weight: 50 }, { key: 'y', pageId: null, weight: 50 }]);
    const third = again!.steps[0]!.experiment!;
    expect(await svc.deleteFunnel(tenantId, orgId, funnel.funnelId)).toBe(true);
    expect(await getExperimentRow(tenantId, orgId, third.experimentId)).toBeNull();
  });

  it('a pre-P1b split is imported on first serve; a mirror-only stop converges the engine', async () => {
    const { tenantId, orgId, funnel, exp } = await funnelWithSplit();
    const rows = new DurableCollection<{ experimentId: string }>('experiments:experiment', (e) => `${tenantId}::${orgId}::${e.experimentId}`);
    await rows.delete(`${tenantId}::${orgId}::${exp.experimentId}`);
    const served = await svc.publicFunnelStep(tenantId, orgId, funnel, 0, 'vk-1');
    expect(served?.experiment?.experimentId).toBe(exp.experimentId);
    expect((await getExperimentRow(tenantId, orgId, exp.experimentId))?.status).toBe('running');
    // The previous image stops it in the funnel row only.
    const mirrorStopped = { ...funnel, steps: [{ ...funnel.steps[0]!, experiment: { ...exp, status: 'stopped' as const, stoppedAt: '2026-10-05T00:00:00.000Z' } }] };
    expect((await svc.publicFunnelStep(tenantId, orgId, mirrorStopped, 0, 'vk-1'))?.experiment).toBeUndefined();
    expect(await getExperimentRow(tenantId, orgId, exp.experimentId)).toMatchObject({ status: 'stopped', stoppedAt: '2026-10-05T00:00:00.000Z' });
  });
});

describe('ADR 0949 P1b — 4/5. the rollup counts every retained event, and says when events are gone', () => {
  it('an exposure older than the newest 50,000 events still counts, and a unit counts once', async () => {
    const { tenantId, orgId, funnel, exp } = await funnelWithSplit();
    // 40 early units per arm (two views each), 10 + 30 converting; then 50,000 newer unrelated events.
    for (const [arm, conv] of [['control', 10], ['b', 30]] as const) {
      for (let i = 0; i < 40; i++) {
        synthetic.push(view(tenantId, orgId, 's1', exp.experimentId, `${arm}-${i}`, arm, '2026-10-02T00:00:00.000Z'));
        synthetic.push(view(tenantId, orgId, 's1', exp.experimentId, `${arm}-${i}`, arm, '2026-10-03T00:00:00.000Z'));
        if (i < conv) synthetic.push(view(tenantId, orgId, 's1', exp.experimentId, `${arm}-${i}`, arm, '2026-10-03T01:00:00.000Z', 'funnel.step_completed'));
      }
    }
    for (let i = 0; i < 50_000; i++) synthetic.push({ eventId: `noise-${i}`, tenantId, eventType: 'page.viewed', payload: {}, piiFields: [], at: '2026-10-10T00:00:00.000Z' });
    const r = await stepExperimentResults(tenantId, orgId, funnel.funnelId, 's1');
    expect(r?.variants.map((v) => [v.key, v.sessions, v.conversions])).toEqual([['control', 40, 10], ['b', 40, 30]]);
    expect(r?.coverage.status).toBe('complete');
    expect(r?.significanceWithheld).toBeUndefined();
    expect(r?.variants[1]?.significant).toBe(true);
  });

  it('after retention purges events from the experiment\'s life, the verdict is withheld', async () => {
    const { tenantId, orgId, funnel, exp } = await funnelWithSplit();
    for (const [arm, conv] of [['control', 10], ['b', 30]] as const) {
      for (let i = 0; i < 40; i++) {
        synthetic.push(view(tenantId, orgId, 's1', exp.experimentId, `${arm}-${i}`, arm, '2030-01-01T00:00:00.000Z'));
        if (i < conv) synthetic.push(view(tenantId, orgId, 's1', exp.experimentId, `${arm}-${i}`, arm, '2030-01-01T01:00:00.000Z', 'funnel.step_completed'));
      }
    }
    await collectEvent(tenantId, 'page.viewed', { path: '/' });
    const purged = await purgeRetained(tenantId, 'confidential-pii', '2099-01-01T00:00:00.000Z');
    expect(purged.find((p) => p.feature === 'cdp')?.deleted).toBe(1);
    const r = await stepExperimentResults(tenantId, orgId, funnel.funnelId, 's1');
    expect(r?.coverage).toMatchObject({ status: 'partial', retainedSince: '2099-01-01T00:00:00.000Z' });
    expect(r?.significanceWithheld).toBe('coverage');
    expect(r?.variants.map((v) => v.significant)).toEqual([null, null]);
  });

  it('a stale engine row for another step is never served as this step\'s experiment', async () => {
    const { tenantId, orgId, funnel, exp } = await funnelWithSplit();
    await putExperimentRow({ ...stepToEngine(tenantId, orgId, funnel.funnelId, 'other', exp) });
    expect((await svc.publicFunnelStep(tenantId, orgId, funnel, 0, 'vk-2'))?.experiment).toBeUndefined();
  });
});
