/**
 * ADR 0949 P2c — the contract step (A1, then A2).
 *
 *   1. CMS page experiments are no longer mirrored to `cms:pageexperiment`.
 *   2. The contract sweep imports a legacy row of an org never read, deletes
 *      every legacy row, does NOT resurrect a row its org already imported and
 *      the user has since deleted, and is idempotent.
 *   3. (A2) Every funnel write stores the step's POINTER `{ experimentId }`, and
 *      every read returns the full experiment from the engine.
 *   4. (A2) A full copy is written down to a pointer only when the engine holds
 *      it FOR THIS STEP: a pre-P1b copy with no engine row is imported by the
 *      read and then stored as a pointer; a copy whose engine row belongs to
 *      another step is kept whole.
 *   5. A write after a hydrated read is not refused as a conflict, and a write
 *      from a stale read still is (the CAS compares the row as stored).
 *   6. A pointer whose engine row is missing is never minted into an engine row
 *      (it would have no salt and no arms); reads drop it, a stop is a 404, and
 *      the next write leaves it out.
 *   7. A promotion's receipt CAS stores the pointer too.
 *   8. (A3) A launched managed experiment is stored as the pointer too. When the
 *      engine ends it with no funnel write, every read shows it stopped (A2, the
 *      rollback floor, hydrates the same way) and the next write keeps the
 *      pointer. A draft, or an experiment held for another step, keeps the copy.
 *   9. (A2) A step stays linked to its experiment after the engine ends it,
 *      shown as stopped, even over a stored copy that still says running
 *      (`adr0950-p1-ramp-rollback.test.ts` exercises the real promotion).
 *  10. (A3) The approval lane's publish CAS compares the row as stored, so a
 *      funnel whose step holds a pointer publishes (it was a 409 under A2).
 *  11. (A3) A re-delivered create returns the funnel hydrated, not the pointer.
 *
 * Sabotage, each red, then restored. A1 (2026-10-26, code unchanged since): the
 * mirror write back in `saveExperiment` reds 1; importing marked orgs' rows
 * reds 2; dropping the full-copy guard in `resolveStepExperiment` reds 6.
 * A2 (2026-10-26): `dehydrate` returning its input reds 3, 4's import case, 5
 * and 7; `storesAsPointer` without its surface-ref check reds 4's other-step
 * case; `storesAsPointer` ignoring `legacy` reds 8 and 9; hydrate trying the
 * copy before `linkedStepExperiment` reds 8 and 9; `swapStored` comparing the
 * hydrated read instead of the stored row reds 3, 5, 6, 8, 9 and the ADR 0950
 * funnel-step rollback.
 * A3 (2026-10-26): `storesAsPointer` restored to legacy-only reds 8; it
 * answering `true` for any engine row of the step reds 8's draft case;
 * `publishFunnel`'s approval CAS comparing the hydrated read reds 10; the
 * re-delivered create returning the stored row reds 11.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { getExperimentRow, putExperimentRow } from '../src/host/experiments/store.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { contractLegacyCmsExperiments, createExperiment, deleteExperiment, listExperiments, type PageExperiment } from '../src/features/cms/pageExperimentsService.js';
import {
  createFunnel, funnelPublishDigest, getFunnel, listFunnels, publicFunnelStep, publishFunnel, reconcileStepPromotion, setStepExperiment, stopStepExperiment, updateFunnel, type Funnel,
} from '../src/features/funnels/funnelsService.js';
import { resolveStepExperiment, storesAsPointer } from '../src/features/funnels/stepExperimentsEngine.js';
import { createDraft, launch, lockPlan } from '../src/features/experiments/experimentsService.js';

const legacy = new DurableCollection<PageExperiment>('cms:pageexperiment', (e) => e.experimentId);
const funnelRows = new DurableCollection<Funnel>('funnels:funnel', (f) => f.funnelId, undefined, (f) => f.tenantId);
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

const legacyRow = (tenantId: string, orgId: string, pageId: string): PageExperiment => ({
  experimentId: `pexp:c-${n++}`, tenantId, orgId, pageId, name: 'Old', status: 'stopped', salt: `s-${n}`,
  variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }],
  createdBy: 'u', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
});

describe('ADR 0949 P2c A1 — CMS contract', () => {
  it('writes no longer reach the legacy collection', async () => {
    const tenantId = `t-c1-${n++}`;
    const page = await createPage({ tenantId, orgId: 'o', title: 'LP', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const e = await createExperiment({ tenantId, orgId: 'o', pageId: page.pageId, name: 'New', variants: [{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: null, weight: 50 }], createdBy: 'u' });
    expect(await legacy.get(e.experimentId)).toBeNull();
    expect(await getExperimentRow(tenantId, 'o', e.experimentId)).not.toBeNull();
  });

  it('the sweep imports never-read rows, deletes every row, never resurrects a deleted one, and is idempotent', async () => {
    const tenantId = `t-c2-${n++}`;
    const unread = legacyRow(tenantId, 'o-unread', 'p1');
    await legacy.put(unread);
    // An org read once (marker written), whose experiment the user then deleted:
    const page = await createPage({ tenantId, orgId: 'o-read', title: 'LP', createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    const gone = legacyRow(tenantId, 'o-read', page.pageId);
    await legacy.put(gone);
    expect((await listExperiments(tenantId, 'o-read', page.pageId)).map((e) => e.experimentId)).toEqual([gone.experimentId]);
    expect(await deleteExperiment(tenantId, 'o-read', page.pageId, gone.experimentId, 'u')).toBe(true);
    await legacy.put(gone); // a copy an older image wrote back

    const r = await contractLegacyCmsExperiments();
    expect(r.imported).toBeGreaterThanOrEqual(1);
    expect(await legacy.get(unread.experimentId)).toBeNull();
    expect(await legacy.get(gone.experimentId)).toBeNull();
    expect(await getExperimentRow(tenantId, 'o-unread', unread.experimentId)).toMatchObject({ legacy: true, salt: unread.salt });
    expect(await getExperimentRow(tenantId, 'o-read', gone.experimentId)).toBeNull();
    expect(await contractLegacyCmsExperiments()).toEqual({ imported: 0, deleted: 0 });
  });
});

describe('ADR 0949 P2c — funnel steps store the pointer', () => {
  async function funnelWithSplit() {
    const tenantId = `t-c3-${n++}`;
    const page = await createPage({ tenantId, orgId: 'o', title: `P ${n}`, createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    await transitionPage(tenantId, 'o', page.pageId, 'publish', 'u');
    const f = await createFunnel({ tenantId, orgId: 'o', createdBy: 'u', name: `F ${n}`, steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    const withExp = await setStepExperiment(tenantId, 'o', f.funnelId, 's1', [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: null, weight: 50 }]);
    return { tenantId, page, funnel: withExp! };
  }
  type StepExp = NonNullable<Funnel['steps'][number]['experiment']>;
  const storedExp = async (funnelId: string): Promise<unknown> => (await funnelRows.get(funnelId))?.steps[0]?.experiment;
  const withStepExp = async (funnelId: string, experiment: StepExp): Promise<void> => {
    const raw = (await funnelRows.get(funnelId))!;
    await funnelRows.put({ ...raw, steps: [{ ...raw.steps[0]!, experiment }] });
  };
  const pointer = (experimentId: string): StepExp => ({ experimentId } as StepExp);

  it('every write stores the pointer, and every read returns the full experiment', async () => {
    const { tenantId, page, funnel } = await funnelWithSplit();
    const id = funnel.steps[0]!.experiment!.experimentId;
    expect(funnel.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'running', variants: [{ key: 'control' }, { key: 'b' }] });
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
    await updateFunnel(tenantId, 'o', funnel.funnelId, { name: 'Renamed', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect((await funnelRows.get(funnel.funnelId))?.name).toBe('Renamed');
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
    const stopped = await stopStepExperiment(tenantId, 'o', funnel.funnelId, 's1');
    expect(stopped?.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'stopped' });
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
    const read = await getFunnel(tenantId, 'o', funnel.funnelId);
    expect(read?.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'stopped', salt: expect.any(String), variants: [{ key: 'control' }, { key: 'b' }] });
    expect((await listFunnels(tenantId, 'o'))[0]?.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'stopped' });
  });

  it('the public read serves a pointer-only step', async () => {
    const { tenantId, funnel } = await funnelWithSplit();
    const id = funnel.steps[0]!.experiment!.experimentId;
    const read = await getFunnel(tenantId, 'o', funnel.funnelId);
    expect((await publicFunnelStep(tenantId, 'o', read!, 0, 'vk-1'))?.experiment?.experimentId).toBe(id);
  });

  it('a pre-P1b full copy with no engine row is imported by the read, then stored as a pointer', async () => {
    const { tenantId, page, funnel } = await funnelWithSplit();
    const old = `old-${n++}`;
    await withStepExp(funnel.funnelId, { experimentId: old, status: 'running', salt: 'abcd1234', variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: null, weight: 50 }], createdAt: '2026-09-01T00:00:00.000Z' });
    await updateFunnel(tenantId, 'o', funnel.funnelId, { name: 'Edited', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect(await getExperimentRow(tenantId, 'o', old)).toMatchObject({ salt: 'abcd1234', legacy: true });
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: old });
    expect((await getFunnel(tenantId, 'o', funnel.funnelId))?.steps[0]?.experiment).toMatchObject({ experimentId: old, salt: 'abcd1234' });
  });

  it('a full copy whose engine row belongs to another step is kept whole, never written down to a pointer', async () => {
    const other = await funnelWithSplit();
    const { tenantId, page, funnel } = await funnelWithSplit();
    const foreignId = other.funnel.steps[0]!.experiment!.experimentId;
    // Same tenant and org: the engine holds this id, but for the other funnel's step.
    const engine = (await getExperimentRow(other.tenantId, 'o', foreignId))!;
    const copy: StepExp = { experimentId: foreignId, status: 'running', salt: 'keepme12', variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: null, weight: 50 }], createdAt: '2026-09-01T00:00:00.000Z' };
    await putExperimentRow({ ...engine, tenantId });
    await withStepExp(funnel.funnelId, copy);
    await updateFunnel(tenantId, 'o', funnel.funnelId, { name: 'Edited', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect(await storedExp(funnel.funnelId)).toEqual(copy);
    expect((await getFunnel(tenantId, 'o', funnel.funnelId))?.steps[0]?.experiment).toEqual(copy);
  });

  it('a write over a pointer-only row succeeds (the CAS compares the row as stored)', async () => {
    const { tenantId, page, funnel } = await funnelWithSplit();
    const id = funnel.steps[0]!.experiment!.experimentId;
    await updateFunnel(tenantId, 'o', funnel.funnelId, { name: 'One', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    await updateFunnel(tenantId, 'o', funnel.funnelId, { name: 'Two', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect((await funnelRows.get(funnel.funnelId))?.name).toBe('Two');
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
  });

  it('a pointer whose engine row is missing is never minted; reads drop it, a stop is a 404, and the next write leaves it out', async () => {
    const { tenantId, page, funnel } = await funnelWithSplit();
    const orphan = `orphan-${n++}`;
    await withStepExp(funnel.funnelId, pointer(orphan));
    expect(await resolveStepExperiment(tenantId, 'o', funnel.funnelId, 's1', pointer(orphan))).toBeNull();
    expect(await getExperimentRow(tenantId, 'o', orphan)).toBeNull();
    expect((await getFunnel(tenantId, 'o', funnel.funnelId))?.steps[0]?.experiment).toBeUndefined();
    await expect(stopStepExperiment(tenantId, 'o', funnel.funnelId, 's1')).rejects.toMatchObject({ httpStatus: 404 });
    await updateFunnel(tenantId, 'o', funnel.funnelId, { name: 'Edited', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect(await storedExp(funnel.funnelId)).toBeUndefined();
    expect(await getExperimentRow(tenantId, 'o', orphan)).toBeNull();
  });

  const PLAN = { primaryMetric: { kind: 'conversion', name: 'signup' }, guardrails: [], baselineRate: 0.1, mde: 0.02, alpha: 0.05, power: 0.8, fdrQ: 0.05, minDays: 7, maxDays: 30 };
  async function managedOnStep() {
    const tenantId = `t-c4-${n++}`;
    const page = await createPage({ tenantId, orgId: 'o', title: `M ${n}`, createdBy: 'u', sections: [{ type: 'hero', data: { heading: 'Hi' } }] });
    await transitionPage(tenantId, 'o', page.pageId, 'publish', 'u');
    const f = await createFunnel({ tenantId, orgId: 'o', createdBy: 'u', name: `M ${n}`, steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    const d = await createDraft(tenantId, 'o', 'u', { name: 'Step', surface: { kind: 'funnel.step', ref: `${f.funnelId}:s1` }, arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: page.pageId, weight: 50 }] });
    await lockPlan(tenantId, 'o', d.experimentId, PLAN);
    await launch(tenantId, 'o', d.experimentId, 'u');
    return { tenantId, page, funnelId: f.funnelId, id: d.experimentId };
  }

  it('a launched managed experiment is stored as the pointer, and reads it back after the engine ends it', async () => {
    const { tenantId, page, funnelId, id } = await managedOnStep();
    expect(await storedExp(funnelId)).toEqual({ experimentId: id });
    for (const status of ['concluded', 'promoting', 'promoted', 'rolled_back', 'abandoned'] as const) {
      const row = (await getExperimentRow(tenantId, 'o', id))!;
      await putExperimentRow({ ...row, status, updatedAt: '2026-10-26T00:00:00.000Z' });
      const read = (await getFunnel(tenantId, 'o', funnelId))!.steps[0]?.experiment;
      expect(read, status).toMatchObject({ experimentId: id, salt: expect.any(String), variants: [{ key: 'control' }, { key: 'b' }] });
    }
    await updateFunnel(tenantId, 'o', funnelId, { name: 'Edited', steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect(await storedExp(funnelId)).toEqual({ experimentId: id });
    expect((await getFunnel(tenantId, 'o', funnelId))?.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'stopped' });
  });

  it('a draft, or an experiment held for another step, is never stored as a pointer', async () => {
    const { tenantId, page, funnelId } = await managedOnStep();
    const draft = await createDraft(tenantId, 'o', 'u', { name: 'Draft', surface: { kind: 'funnel.step', ref: `${funnelId}:s1` }, arms: [{ key: 'control', ref: null, weight: 50 }, { key: 'b', ref: page.pageId, weight: 50 }] });
    expect(await storesAsPointer(tenantId, 'o', funnelId, 's1', draft.experimentId)).toBe(false);
    const { id: otherStep } = await managedOnStep();
    expect(await storesAsPointer(tenantId, 'o', funnelId, 's1', otherStep)).toBe(false);
  });

  it('a step stays linked to an experiment the engine has ended, shown as stopped, even over a copy that says running', async () => {
    const { tenantId, funnelId, id } = await managedOnStep();
    // The full `running` copy A2 stored for a managed experiment.
    const copy = (await getFunnel(tenantId, 'o', funnelId))!.steps[0]!.experiment!;
    await withStepExp(funnelId, copy);
    expect(await storedExp(funnelId)).toMatchObject({ experimentId: id, status: 'running', salt: expect.any(String) });
    const row = (await getExperimentRow(tenantId, 'o', id))!;
    await putExperimentRow({ ...row, status: 'rolled_back', updatedAt: '2026-10-26T00:00:00.000Z' });
    expect((await getFunnel(tenantId, 'o', funnelId))?.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'stopped', stoppedAt: '2026-10-26T00:00:00.000Z' });
    // The stale `running` copy no longer blocks a new split on the step.
    const next = await setStepExperiment(tenantId, 'o', funnelId, 's1', [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: null, weight: 50 }]);
    expect(next?.steps[0]?.experiment?.experimentId).not.toBe(id);
  });

  it('the approval lane publishes a pointer-only funnel (its CAS compares the row as stored)', async () => {
    const { tenantId, funnel } = await funnelWithSplit();
    const id = funnel.steps[0]!.experiment!.experimentId;
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
    const read = (await getFunnel(tenantId, 'o', funnel.funnelId))!;
    const published = await publishFunnel(tenantId, 'o', funnel.funnelId, { requirePublishedPages: true, expectedDigest: funnelPublishDigest(read) });
    expect(published?.status).toBe('published');
    expect((await funnelRows.get(funnel.funnelId))?.status).toBe('published');
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
  });

  it('a re-delivered create returns the funnel hydrated, never the stored pointer', async () => {
    const { tenantId, page, funnel } = await funnelWithSplit();
    const id = funnel.steps[0]!.experiment!.experimentId;
    expect(await storedExp(funnel.funnelId)).toEqual({ experimentId: id });
    const again = await createFunnel({ tenantId, orgId: 'o', createdBy: 'u', funnelId: funnel.funnelId, name: funnel.name, steps: [{ stepId: 's1', kind: 'landing', pageId: page.pageId }] });
    expect(again.steps[0]?.experiment).toMatchObject({ experimentId: id, status: 'running', salt: expect.any(String) });
  });

  it("a promotion's receipt CAS stores the pointer too", async () => {
    const { tenantId, page, funnel } = await funnelWithSplit();
    const id = funnel.steps[0]!.experiment!.experimentId;
    await withStepExp(funnel.funnelId, funnel.steps[0]!.experiment!); // the full copy, as A1 stored it
    expect(await reconcileStepPromotion(tenantId, 'o', funnel.funnelId, 's1', id, null, 'finalize')).toEqual({ baselineRef: page.pageId });
    const stored = (await funnelRows.get(funnel.funnelId))!;
    expect(stored.promotionReceipts?.[id]).toMatchObject({ stepId: 's1', outcome: 'finalized' });
    expect(stored.steps[0]?.experiment).toEqual({ experimentId: id });
  });
});
