/**
 * ADR 0950 P1 — monotone ramps, finalize, rollback and the decision log.
 *
 *   1. THE P1 EXIT (witness): over 100,000 keys and several launch layouts,
 *      across stages 50 → 90 → 98 (holdout 2%), no unit ever moves from the
 *      winner to anything else, a unit on the winner at launch stays on it, and
 *      no holdout unit ever sees the winner.
 *   2. applyRamp is idempotent per stage, refuses to shrink the winner or go
 *      back a stage, and its epoch drives assignment (CMS public path).
 *   3. THE P1 EXIT (rollback): a CMS promotion finalizes the winner's version as
 *      the page; rollback restores the recorded baseline version, puts every
 *      unit back on control, and is idempotent. A funnel step swaps its page and
 *      back.
 *   4. Every ramp / finalize / rollback appends `experiment.decision` to the
 *      tenant hash chain (ids and numbers only), and the chain verifies.
 *
 *   5. (code-review) the holdout size is fixed for a promotion; two concurrent
 *      finalizers ship once and log once; the CMS baseline is the newest
 *      PUBLISHED snapshot, never a newer `seed`/`submit` row that was never live.
 *   6. (grade-workflows) a fork of a run that began before a rollback assigns
 *      exactly as its source did; a stage retried with other numbers is refused.
 *
 * Sabotage (run 2026-10-20): laying the bands out afresh from the low end
 * ([winner W% | control], the ADR's original D3 wording) reds all four cases of 1; dropping the stage idempotency reds 2; not restoring
 * the baseline reds 3; dropping the decision log reds 4;
 * taking the CMS baseline from the newest row of any origin, or dropping the
 * finalize claim, reds 5; dropping `rolled_back` from `assigningAt` reds 6.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { assignWeightedVariant, rampLayout } from '../src/host/variantAssignment.js';
import { applyRamp, finalize, rollback } from '../src/host/experiments/promote.js';
import { assignAt } from '../src/host/experiments/runFreeze.js';
import { getExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { listChain, verifyChain } from '../src/host/auditChainService.js';
import type { Experiment } from '../src/host/experiments/types.js';
import { createPage, getPage, listVersions, offerSeedVersion, transitionPage, updatePage } from '../src/features/cms/cmsService.js';
import { assignVisitorArm, getExperiment as getPageExperiment } from '../src/features/cms/pageExperimentsService.js';
import { createDraft, launch, lockPlan } from '../src/features/experiments/experimentsService.js';
import { createFunnel, getFunnel } from '../src/features/funnels/funnelsService.js';

let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

const PLAN = { primaryMetric: { kind: 'conversion', name: 'signup' }, guardrails: [], baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };
const ctx = (over: Partial<{ actor: string; runId: string; now: string }> = {}) => ({ actor: 'u-1', now: '2026-10-20T00:00:00.000Z', ...over });

describe('ADR 0950 P1 — 1. the monotone ramp (100k-key witness)', () => {
  const cases: Array<{ name: string; launch: Array<{ key: string; weight: number }>; winner: string }> = [
    { name: 'A/B, winner last', launch: [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }], winner: 'b' },
    { name: 'A/B/C, winner in the middle', launch: [{ key: 'control', weight: 34 }, { key: 'a', weight: 33 }, { key: 'b', weight: 33 }], winner: 'a' },
    { name: 'A/B/C, winner last', launch: [{ key: 'control', weight: 34 }, { key: 'a', weight: 33 }, { key: 'b', weight: 33 }], winner: 'b' },
    { name: 'uneven, control 1%', launch: [{ key: 'control', weight: 1 }, { key: 'b', weight: 59 }, { key: 'c', weight: 40 }], winner: 'c' },
  ];
  for (const c of cases) {
    it(`${c.name}: no unit leaves the winner, launch winners stay, no holdout unit sees the winner`, () => {
      const stages = [50, 90, 98].map((pct) => rampLayout(c.launch, c.winner, Math.max(pct, c.launch.find((a) => a.key === c.winner)!.weight), 2, 'control'));
      const final = stages[stages.length - 1]!;
      for (let i = 0; i < 100_000; i++) {
        const key = `u-${i}`;
        const seq = [c.launch, ...stages].map((layout) => assignWeightedVariant(key, 'exp:w', 'salt', layout));
        const finalArm = seq[seq.length - 1];
        for (let s = 1; s < seq.length; s++) if (seq[s - 1] === c.winner) expect(seq[s]).toBe(c.winner);
        if (finalArm !== c.winner) expect(seq.includes(c.winner)).toBe(false); // holdout units never saw it
      }
      expect(final.filter((s) => s.key === c.winner).reduce((t, s) => t + s.weight, 0)).toBe(98);
    });
  }
});

async function cmsPromotion() {
  const tenantId = `t-p1-${n++}`;
  const orgId = 'o';
  const page = await createPage({ tenantId, orgId, title: 'LP', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Winner copy' } }] });
  await transitionPage(tenantId, orgId, page.pageId, 'publish', 'u');
  const winnerVersion = (await listVersions(tenantId, orgId, page.pageId))[0]!.versionId;
  await transitionPage(tenantId, orgId, page.pageId, 'unpublish', 'u');
  await updatePage(tenantId, orgId, page.pageId, { sections: [{ type: 'hero', data: { heading: 'Baseline copy' } }] }, 'u');
  await transitionPage(tenantId, orgId, page.pageId, 'publish', 'u');
  const baselineVersion = (await listVersions(tenantId, orgId, page.pageId))[0]!.versionId;
  const d = await createDraft(tenantId, orgId, 'u', { name: 'Hero', surface: { kind: 'cms.page', ref: page.pageId }, arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: winnerVersion, weight: 50 }] });
  await lockPlan(tenantId, orgId, d.experimentId, PLAN);
  await launch(tenantId, orgId, d.experimentId, 'u');
  return { tenantId, orgId, page, id: d.experimentId, winnerVersion, baselineVersion };
}
const heading = async (tenantId: string, orgId: string, pageId: string) => ((await getPage(tenantId, orgId, pageId))?.sections[0] as { data?: { heading?: string } } | undefined)?.data?.heading;

describe('ADR 0950 P1 — 2/3/4. ramp, finalize, rollback, the decision log', () => {
  it('a ramp is idempotent per stage, never shrinks or goes back, and drives the public assignment', async () => {
    const s = await cmsPromotion();
    const one = await applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 90, holdoutPct: 2 }, ctx({ runId: 'run-1' }));
    expect(one.outcome).toBe('applied');
    expect((await applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 90, holdoutPct: 2 }, ctx())).outcome).toBe('existing');
    await expect(applyRamp(s.tenantId, s.orgId, s.id, { stage: 2, winner: 'b', winnerPct: 60, holdoutPct: 2 }, ctx())).rejects.toMatchObject({ details: { reason: 'ramp_shrinks' } });
    await expect(applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 95, holdoutPct: 2 }, ctx())).rejects.toMatchObject({ details: { reason: 'stage_mismatch' } });
    const row = (await getExperimentRow(s.tenantId, s.orgId, s.id))!;
    expect(row.epochs.at(-1)).toMatchObject({ reason: 'ramp', stage: 1, decidedByRunId: 'run-1', weights: { b: 90, control: 10 } });
    const pageExp = (await getPageExperiment(s.tenantId, s.orgId, s.page.pageId, s.id))!;
    expect(pageExp.engineMode).toBe('ramp');
    let onB = 0;
    for (let i = 0; i < 2000; i++) if ((await assignVisitorArm(pageExp, `vk-${i}`))?.key === 'b') onB += 1;
    expect(onB / 2000).toBeGreaterThan(0.85);
  });

  it("finalize ships the winner's version; rollback restores the recorded baseline (the P1 exit) and is idempotent", async () => {
    const s = await cmsPromotion();
    expect(await heading(s.tenantId, s.orgId, s.page.pageId)).toBe('Baseline copy');
    await applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 98, holdoutPct: 2 }, ctx());
    const f = await finalize(s.tenantId, s.orgId, s.id, ctx());
    expect(f.outcome).toBe('finalized');
    expect(f.experiment.promotion).toMatchObject({ winner: 'b', baselineRef: s.baselineVersion });
    expect(await heading(s.tenantId, s.orgId, s.page.pageId)).toBe('Winner copy');
    expect((await finalize(s.tenantId, s.orgId, s.id, ctx())).outcome).toBe('existing');

    const r = await rollback(s.tenantId, s.orgId, s.id, { ...ctx(), reason: 'guardrail_breach' });
    expect(r.outcome).toBe('rolled_back');
    expect(await heading(s.tenantId, s.orgId, s.page.pageId)).toBe('Baseline copy');
    expect(r.experiment).toMatchObject({ status: 'rolled_back' });
    expect(r.experiment.epochs.at(-1)).toMatchObject({ reason: 'rollback', weights: { control: 100 } });
    expect((await rollback(s.tenantId, s.orgId, s.id, { ...ctx(), reason: 'again' })).outcome).toBe('existing');

    const decisions = (await listChain(s.tenantId)).filter((e) => e.kind === 'experiment.decision').map((e) => e.payload);
    expect(decisions.map((d) => d.action)).toEqual(['ramp', 'finalize', 'rollback']);
    expect(decisions[0]).toMatchObject({ experimentId: s.id, orgId: s.orgId, stage: 1, winner: 'b', winnerPct: 98, holdoutPct: 2, actor: 'u-1' });
    expect(JSON.stringify(decisions)).not.toMatch(/Winner copy|Baseline copy|vk-/);
    expect((await verifyChain(s.tenantId)).ok).toBe(true);
  });

  it('a funnel step promotion swaps the step page, and rollback swaps it back', async () => {
    const tenantId = `t-p1f-${n++}`;
    const holdout = await createPage({ tenantId, orgId: 'o', title: 'Old', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Old' } }] });
    const challenger = await createPage({ tenantId, orgId: 'o', title: 'New', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'New' } }] });
    for (const p of [holdout, challenger]) await transitionPage(tenantId, 'o', p.pageId, 'publish', 'u');
    const f = await createFunnel({ tenantId, orgId: 'o', createdBy: 'u', name: 'F', steps: [{ stepId: 's1', kind: 'landing', pageId: holdout.pageId }] });
    const d = await createDraft(tenantId, 'o', 'u', { name: 'Step', surface: { kind: 'funnel.step', ref: `${f.funnelId}:s1` }, arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: challenger.pageId, weight: 50 }] });
    await lockPlan(tenantId, 'o', d.experimentId, PLAN);
    await launch(tenantId, 'o', d.experimentId, 'u');
    await applyRamp(tenantId, 'o', d.experimentId, { stage: 1, winner: 'b', winnerPct: 98, holdoutPct: 2 }, ctx());
    await finalize(tenantId, 'o', d.experimentId, ctx());
    expect((await getFunnel(tenantId, 'o', f.funnelId))?.steps[0]?.pageId).toBe(challenger.pageId);
    await rollback(tenantId, 'o', d.experimentId, { ...ctx(), reason: 'manual' });
    expect((await getFunnel(tenantId, 'o', f.funnelId))?.steps[0]?.pageId).toBe(holdout.pageId);
  });

  it('code-review: a fixed holdout, one finalize under a race, a baseline that was live', async () => {
    const s = await cmsPromotion();
    await applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 90, holdoutPct: 2 }, ctx());
    await expect(applyRamp(s.tenantId, s.orgId, s.id, { stage: 2, winner: 'b', winnerPct: 90, holdoutPct: 5 }, ctx())).rejects.toMatchObject({ details: { reason: 'holdout_changed' } });
    // A seed offer is now the newest version row; it was never the live page.
    const live = (await getPage(s.tenantId, s.orgId, s.page.pageId))!;
    await offerSeedVersion(live, { title: 'LP', sections: [{ type: 'hero', data: { heading: 'Seed offer' } }] as never }, 'seed');
    expect((await listVersions(s.tenantId, s.orgId, s.page.pageId))[0]!.origin).toBe('seed');
    const [a, b] = await Promise.all([finalize(s.tenantId, s.orgId, s.id, ctx()), finalize(s.tenantId, s.orgId, s.id, ctx())]);
    expect([a.outcome, b.outcome].sort()).toEqual(['existing', 'finalized']);
    const row = (await getExperimentRow(s.tenantId, s.orgId, s.id))!;
    expect(row.promotion?.baselineRef).toBe(s.baselineVersion);
    const actions = (await listChain(s.tenantId)).filter((e) => e.kind === 'experiment.decision').map((e) => e.payload.action);
    expect(actions).toEqual(['ramp', 'finalize']);
  });

  it('grade-workflows: a run frozen before the rollback still assigns as its source did (fork after rollback)', async () => {
    const s = await cmsPromotion();
    await applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 90, holdoutPct: 2 }, ctx({ now: '2026-10-21T00:00:00.000Z' }));
    const asOf = '2026-10-22T00:00:00.000Z';
    const before = (await getExperimentRow(s.tenantId, s.orgId, s.id))!;
    const keys = Array.from({ length: 200 }, (_, i) => `c-${i}`);
    const source = keys.map((k) => assignAt(before, k, asOf)?.arm.key);
    await rollback(s.tenantId, s.orgId, s.id, { ...ctx({ now: '2026-10-23T00:00:00.000Z' }), reason: 'manual' });
    const after = (await getExperimentRow(s.tenantId, s.orgId, s.id))!;
    expect(keys.map((k) => assignAt(after, k, asOf)?.arm.key)).toEqual(source);
    expect(source.filter((a) => a === 'b').length).toBeGreaterThan(150);
    // A run started after the rollback is not in the test.
    expect(assignAt(after, 'c-0', '2026-10-24T00:00:00.000Z')).toBeNull();
  });

  it('a non-running or legacy experiment cannot ramp', async () => {
    const s = await cmsPromotion();
    const row = (await getExperimentRow(s.tenantId, s.orgId, s.id))!;
    await putExperimentRow({ ...row, status: 'stopped' } as Experiment);
    await expect(applyRamp(s.tenantId, s.orgId, s.id, { stage: 1, winner: 'b', winnerPct: 90, holdoutPct: 2 }, ctx())).rejects.toMatchObject({ details: { reason: 'not_running' } });
  });
});
