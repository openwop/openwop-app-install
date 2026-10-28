/**
 * ADR 0949 P4a — Optimize mode.
 *
 *   1. Thompson weights are deterministic for a seed (THE P4 EXIT: same inputs,
 *      same weights on replay), respect the floor, sum to 100, and favour the
 *      better arm.
 *   2. An epoch is appended once: early runs are `too_soon`, the same instant
 *      finds it `existing` (a fork never re-allocates), and its `at` is the
 *      append instant.
 *   3. Stickiness: a unit keeps its first exposure after the weights move; the
 *      stamp resolver's read-only path never writes; past the cap nothing is
 *      recorded; a Decide experiment never touches the store.
 *   4. Optimize results are a model estimate: probabilityBest and expectedLoss,
 *      never a verdict, a p-value or "significant"; Optimize has no plan.
 *   5. A CMS page Optimize experiment serves sticky through `assignVisitorArm`.
 *
 * Sabotage (run 2026-10-20): an unseeded draw reds 1; dropping the
 * `existing` check reds 2; reading the store after `assignAt` (so a stopped
 * experiment's recorded arm is lost) reds 3's resolver case; dropping the floor
 * reds 1's floor case.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createApp } from '../src/index.js';
import { thompsonWeights } from '../src/host/experiments/stats.js';
import { registerExperimentSurface } from '../src/host/experiments/adapters.js';
import { getExperimentRow, mutateExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { countFirstExposures, eraseExperimentFirstExposures, stickyAssign } from '../src/host/experiments/sticky.js';
import type { Experiment } from '../src/host/experiments/types.js';
import { createDraft, launch, lockPlan, optimizeEpoch, results } from '../src/features/experiments/experimentsService.js';
import { createPage } from '../src/features/cms/cmsService.js';
import { assignVisitorArm, getExperiment as getPageExperiment } from '../src/features/cms/pageExperimentsService.js';
import { defaultWorkflowChainPackRoots, expandChain, getChain, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';

const units: Array<{ arm: string; firstExposureAt: string; converted: boolean }> = [];
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  registerExperimentSurface({
    kind: 'test.optimize',
    validateTarget: async () => undefined,
    launch: async (e) => (await mutateExperimentRow(e.tenantId, e.orgId, e.experimentId, (c) => ({ ...c, status: 'running', startedAt: '2026-10-01T00:00:00.000Z' })))!,
    stop: async (e) => e,
    observe: async () => ({ units, coverage: 'complete', sourceRetainedSince: null }),
  });
});

const ARMS = [{ key: 'a', ref: null, weight: 34 }, { key: 'b', ref: 'v2', weight: 33 }, { key: 'c', ref: 'v3', weight: 33 }];
const OPT = { rewardMetric: { kind: 'conversion', name: 'signup' }, floorPct: 10, epochMinutes: 60 };

async function launched(tenantId = `t-p4-${n++}`) {
  const d = await createDraft(tenantId, tenantId, 'u', { name: 'Hero', surface: { kind: 'test.optimize', ref: 'r' }, arms: ARMS, mode: 'optimize', optimize: OPT });
  await launch(tenantId, tenantId, d.experimentId, 'u');
  const row = await getExperimentRow(tenantId, tenantId, d.experimentId);
  // Pin the launch epoch's instant so the epoch arithmetic below is exact.
  await putExperimentRow({ ...row!, epochs: [{ ...row!.epochs[0]!, at: '2026-10-01T00:00:00.000Z' }] });
  return { tenantId, id: d.experimentId };
}

describe('ADR 0949 P4a — 1. Thompson weights', () => {
  const arms = [{ key: 'a', successes: 20, trials: 400 }, { key: 'b', successes: 60, trials: 400 }, { key: 'c', successes: 22, trials: 400 }];
  it('are deterministic for a seed (same inputs, same weights on replay), sum to 100 and favour the better arm', () => {
    const one = thompsonWeights(arms, { floorPct: 10, seed: 12345 });
    const two = thompsonWeights(arms, { floorPct: 10, seed: 12345 });
    expect(two).toEqual(one);
    expect(Object.values(one.weights).reduce((s, v) => s + v, 0)).toBe(100);
    expect(one.weights.b).toBeGreaterThan(70);
    expect(one.probabilityBest.b).toBeGreaterThan(0.99);
    expect(Object.values(one.probabilityBest).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    expect(one.expectedLoss.b).toBeLessThan(one.expectedLoss.a!);
  });
  it('keep every arm at or above its floor, even a hopeless one', () => {
    const r = thompsonWeights([{ key: 'a', successes: 0, trials: 5000 }, { key: 'b', successes: 2500, trials: 5000 }], { floorPct: 5, seed: 7 });
    expect(r.weights.a).toBeGreaterThanOrEqual(5);
    expect(r.weights.a! + r.weights.b!).toBe(100);
  });
});

describe('ADR 0949 P4a — 2. epochs', () => {
  it('too early is too_soon; the next is appended once; the same instant finds it existing', async () => {
    const { tenantId, id } = await launched();
    units.length = 0;
    for (let i = 0; i < 300; i++) for (const [arm, rate] of [['a', 0.05], ['b', 0.2], ['c', 0.05]] as const) units.push({ arm, firstExposureAt: '2026-10-01T01:00:00.000Z', converted: i < 300 * rate });
    expect((await optimizeEpoch(tenantId, tenantId, id, { asOf: '2026-10-01T00:30:00.000Z', now: '2026-10-01T00:30:00.000Z' })).outcome).toBe('too_soon');
    // run-1 began at 02:00 and appends at 02:00:05.
    const first = await optimizeEpoch(tenantId, tenantId, id, { asOf: '2026-10-01T02:00:00.000Z', now: '2026-10-01T02:00:05.000Z', runId: 'run-1' });
    expect(first).toMatchObject({ outcome: 'appended', epoch: 1 });
    const e1 = first.experiment.epochs.find((e) => e.epoch === 1)!;
    expect(e1).toMatchObject({ reason: 'optimize', at: '2026-10-01T02:00:05.000Z', decidedByRunId: 'run-1' });
    expect(e1.weights.b).toBeGreaterThan(e1.weights.a!);
    // A fork of run-1 (same frozen instant) finds epoch 1 and never re-allocates.
    const fork = await optimizeEpoch(tenantId, tenantId, id, { asOf: '2026-10-01T02:00:00.000Z', now: '2026-10-01T05:00:00.000Z' });
    expect(fork).toMatchObject({ outcome: 'existing', epoch: 1 });
    expect((await getExperimentRow(tenantId, tenantId, id))?.epochs).toHaveLength(2);
  });
});

describe('ADR 0949 P4a — 2b. an epoch appended at the run\'s own instant', () => {
  it('is stamped strictly after it, so that run\'s fork still finds it existing', async () => {
    const { tenantId, id } = await launched();
    const r = await optimizeEpoch(tenantId, tenantId, id, { asOf: '2026-10-01T02:00:00.000Z', now: '2026-10-01T02:00:00.000Z' });
    expect(r.experiment.epochs.find((e) => e.epoch === 1)?.at).toBe('2026-10-01T02:00:00.001Z');
    expect((await optimizeEpoch(tenantId, tenantId, id, { asOf: '2026-10-01T02:00:00.000Z', now: '2026-10-01T09:00:00.000Z' })).outcome).toBe('existing');
  });
});

describe('ADR 0949 P4a — 3. stickiness', () => {
  it('a unit keeps its first exposure after the weights move; read-only never writes; a capped experiment records nothing', async () => {
    const { tenantId, id } = await launched();
    const row = (await getExperimentRow(tenantId, tenantId, id))!;
    const before = await Promise.all(Array.from({ length: 50 }, (_, i) => stickyAssign(row, `vk-${i}`, '2026-10-01T03:00:00.000Z')));
    expect(await countFirstExposures(row)).toBe(50);
    const moved: Experiment = { ...row, epochs: [...row.epochs, { epoch: 1, weights: { a: 2, b: 96, c: 2 }, at: '2026-10-01T04:00:00.000Z', reason: 'optimize' }] };
    const after = await Promise.all(Array.from({ length: 50 }, (_, i) => stickyAssign(moved, `vk-${i}`, '2026-10-01T05:00:00.000Z')));
    expect(after.map((a) => a?.arm.key)).toEqual(before.map((a) => a?.arm.key));
    // The resolver re-derives a STOPPED experiment's arm from the store, and writes nothing.
    const stopped: Experiment = { ...moved, status: 'stopped', stoppedAt: '2026-10-01T06:00:00.000Z' };
    expect((await stickyAssign(stopped, 'vk-0', '2026-10-02T00:00:00.000Z', { readOnly: true }))?.arm.key).toBe(before[0]?.arm.key);
    await stickyAssign(moved, 'new-visitor', '2026-10-01T05:00:00.000Z', { readOnly: true });
    expect(await countFirstExposures(row)).toBe(50);
    await stickyAssign({ ...moved, stickinessCapped: true }, 'another-visitor', '2026-10-01T05:00:00.000Z');
    expect(await countFirstExposures(row)).toBe(50);
  });
});

describe('ADR 0949 P4a — 3b. subject erasure', () => {
  it('deletes exactly the erased subject\'s first exposures, across the tenant\'s Optimize experiments', async () => {
    const { tenantId, id } = await launched();
    const row = (await getExperimentRow(tenantId, tenantId, id))!;
    for (const k of ['contact-gone', 'contact-kept']) await stickyAssign(row, k, '2026-10-01T03:00:00.000Z');
    expect(await countFirstExposures(row)).toBe(2);
    expect(await eraseExperimentFirstExposures(tenantId, 'contact-gone')).toEqual({ rowsTouched: 1 });
    expect(await countFirstExposures(row)).toBe(1);
    expect((await stickyAssign(row, 'contact-kept', '2026-10-01T03:00:00.000Z', { readOnly: true }))?.sticky).toBe(true);
  });
});

describe('ADR 0949 P4a — 4/5. results and the CMS page path', () => {
  it('Optimize results are a model estimate, never a verdict; Optimize has no plan', async () => {
    const { tenantId, id } = await launched();
    const r = await results(tenantId, tenantId, id, '2026-10-01T03:00:00.000Z') as unknown as Record<string, unknown>;
    expect(r).toMatchObject({ mode: 'optimize', epoch: 0, floorPct: 10 });
    expect((r.arms as Array<Record<string, unknown>>)[0]).toHaveProperty('probabilityBest');
    expect(JSON.stringify(r)).not.toMatch(/verdict|pValue|significan|confidenceSequence/);
    await expect(lockPlan(tenantId, tenantId, id, undefined)).rejects.toMatchObject({ details: { reason: 'not_decide' } });
  });

  it('a CMS page Optimize experiment serves sticky; a Decide one never writes the store', async () => {
    const tenantId = `t-p4cms-${n++}`;
    const page = await createPage({ tenantId, orgId: 'o', title: 'LP', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const arms = [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: null, weight: 50 }];
    const opt = await createDraft(tenantId, 'o', 'u', { name: 'Opt', surface: { kind: 'cms.page', ref: page.pageId }, arms, mode: 'optimize', optimize: { ...OPT, floorPct: 5 } });
    await launch(tenantId, 'o', opt.experimentId, 'u');
    const pageExp = (await getPageExperiment(tenantId, 'o', page.pageId, opt.experimentId))!;
    const v1 = await assignVisitorArm(pageExp, 'visitor-1');
    expect(v1).not.toBeNull();
    expect(await countFirstExposures({ tenantId, experimentId: opt.experimentId })).toBe(1);
    expect((await assignVisitorArm(pageExp, 'visitor-1'))?.key).toBe(v1?.key);

    const page2 = await createPage({ tenantId, orgId: 'o', title: 'LP2', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const dec = await createDraft(tenantId, 'o', 'u', { name: 'Dec', surface: { kind: 'cms.page', ref: page2.pageId }, arms });
    const decExp = (await getPageExperiment(tenantId, 'o', page2.pageId, dec.experimentId))!;
    // Observe experiment/first-exposure reads at storage, not unrelated CMS
    // seed work that createApp may still be completing in the background.
    const reads = vi.spyOn(hostExtStorage(), 'kvGet');
    const experimentReads = () => reads.mock.calls.filter(([key]) => key.startsWith('hostext:experiments:experiment:') || key.startsWith('hostext:experiments:first-exposure:'));
    try {
      await assignVisitorArm(pageExp, 'visitor-1');
      expect(experimentReads().length, 'positive control: Optimize reads its durable assignment').toBeGreaterThan(0);
      reads.mockClear();
      expect(await assignVisitorArm({ ...decExp, status: 'running' }, 'visitor-1')).not.toBeNull();
      expect(experimentReads()).toEqual([]);
    } finally { reads.mockRestore(); }
    expect(await countFirstExposures({ tenantId, experimentId: dec.experimentId })).toBe(0);
  });
});

describe('ADR 0949 P4a — 6. the optimize-loop chain through the REAL loader (grade-workflows probe)', () => {
  it('loads without error, binds both params live, pins the side-effect node, and expands deterministically', () => {
    const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    expect(errors.filter((e) => /experiments/.test(e.pack))).toEqual([]);
    const found = getChain('experiments.optimize-loop');
    expect(found?.packName).toBe('core.openwop.workflows.experiments');
    const params = { orgId: 'org-1', experimentId: 'exp:abc' };
    const one = expandChain(found!.chain, { params });
    const two = expandChain(found!.chain, { params });
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    const node = one.nodes.find((x) => x.typeId.startsWith('feature.experiments.nodes.optimize-epoch'));
    expect(node?.inputs).toEqual({ orgId: 'org-1', experimentId: 'exp:abc' });
  });
});
