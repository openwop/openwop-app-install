/** ADR 0210 correction / ADR 0627 D6: history follows landed CAS order, not
 * wall-clock precision, async append completion, or UUID/index enumeration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createDeal, getDeal, getStageHistory, updateDeal, type StageHistoryRow } from '../src/features/crm/entities/deals.js';
import { createPipeline } from '../src/features/crm/entities/pipelines.js';
import { getSystemEntity, putSystemEntity } from '../src/features/entities/entitiesService.js';

const T = 'tenant-stage-history-order';
const ORG = 'org-stage-order';
const AT = '2026-10-08T12:00:00.123Z';
const ok = { validateCompany: async () => true, validateContact: async () => true };
beforeEach(async () => { initHostExtPersistence(await openStorage('memory://')); });
afterEach(() => { vi.useRealTimers(); });
function freezeDate(): void { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(AT); }
async function fixture() {
  const p = await createPipeline(T, ORG, 'Sales', [{ name: 'New' }, { name: 'Qualified' }, { name: 'Proposal' }]);
  const [s0, s1, s2] = p.stages.map((s) => s.stageId) as [string, string, string];
  const deal = await createDeal({ tenantId: T, orgId: ORG, title: 'Rank', pipelineId: p.pipelineId, stageId: s0, createdBy: 'u1', ...ok });
  return { deal, s0, s1, s2 };
}

describe('stage history authoritative order', () => {
  it('orders two moves in one millisecond newest-first without changing any timestamp', async () => {
    freezeDate();
    const { deal, s0, s1, s2 } = await fixture();
    await updateDeal(T, ORG, deal.dealId, { stageId: s1 }, ok, 'a');
    await updateDeal(T, ORG, deal.dealId, { stageId: s2 }, ok, 'b');
    const history = await getStageHistory(T, ORG, deal.dealId);
    expect(history.map((r) => r.sequence)).toEqual([3, 2, 1]);
    expect(history.map((r) => [r.fromStageId, r.toStageId])).toEqual([[s1, s2], [s0, s1], [null, s0]]);
    expect(history.map((r) => r.at)).toEqual([AT, AT, AT]);
    expect((await getDeal(T, ORG, deal.dealId))?.updatedAt).toBe(AT);
  });

  it('does not consume a stage rank for metadata or same-stage updates', async () => {
    freezeDate();
    const { deal } = await fixture();
    await updateDeal(T, ORG, deal.dealId, { amount: 10 }, ok, 'a');
    await updateDeal(T, ORG, deal.dealId, { stageId: deal.stageId }, ok, 'b');
    expect((await getDeal(T, ORG, deal.dealId))?.stageHistorySequence).toBe(1);
    expect((await getStageHistory(T, ORG, deal.dealId)).map((r) => r.sequence)).toEqual([1]);
  });

  it('uses landed order when the wall clock moves backward, preserving the recorded times', async () => {
    freezeDate();
    const { deal, s1, s2 } = await fixture();
    await updateDeal(T, ORG, deal.dealId, { stageId: s1 }, ok, 'a');
    vi.setSystemTime('2026-10-08T11:59:59.123Z');
    await updateDeal(T, ORG, deal.dealId, { stageId: s2 }, ok, 'b');
    const history = await getStageHistory(T, ORG, deal.dealId);
    expect(history.map((r) => r.sequence)).toEqual([3, 2, 1]);
    expect(history[0]?.toStageId).toBe(s2);
    expect(history.map((r) => r.at)).toEqual(['2026-10-08T11:59:59.123Z', AT, AT]);
  });

  it('reserves unique ranks in a concurrent CAS race', async () => {
    freezeDate();
    const { deal, s0, s1, s2 } = await fixture();
    await Promise.all([
      updateDeal(T, ORG, deal.dealId, { stageId: s1 }, ok, 'a'),
      updateDeal(T, ORG, deal.dealId, { stageId: s2 }, ok, 'b'),
    ]);
    const history = await getStageHistory(T, ORG, deal.dealId);
    expect(history.map((r) => r.sequence)).toEqual([3, 2, 1]);
    expect(history[0]?.fromStageId).toBe(history[1]?.toStageId);
    expect(history[1]?.fromStageId).toBe(s0);
    expect(history[0]?.toStageId).toBe((await getDeal(T, ORG, deal.dealId))?.stageId);
    expect(history.map((r) => r.at)).toEqual([AT, AT, AT]);
  });

  it('a later landed move gets the next rank while the first append is delayed', async () => {
    freezeDate();
    const real = await openStorage('memory://');
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const firstAppending = new Promise<void>((resolve) => { reached = resolve; });
    const storage = new Proxy(real, {
      get(target, key, receiver) {
        if (key === 'kvSet') return async (k: string, value: string): Promise<void> => {
          if (k.startsWith('hostext:crm:stagehistory:')) {
            const row = JSON.parse(value) as StageHistoryRow;
            if (row.actor === 'slow-first' && row.fromStageId !== null) { reached(); await blocked; }
          }
          await target.kvSet(k, value);
        };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    initHostExtPersistence(storage);
    const { deal, s0, s1, s2 } = await fixture();
    const first = updateDeal(T, ORG, deal.dealId, { stageId: s1 }, ok, 'slow-first');
    try {
      await Promise.race([firstAppending, first.then(() => { throw new Error('first move did not reach the append barrier'); })]);
      const second = await updateDeal(T, ORG, deal.dealId, { stageId: s2 }, ok, 'fast-second');
      expect(second?.stageHistorySequence).toBe(3);
    } finally { release(); await first; }
    const history = await getStageHistory(T, ORG, deal.dealId);
    expect(history.map((r) => r.sequence)).toEqual([3, 2, 1]);
    expect(history.map((r) => [r.fromStageId, r.toStageId])).toEqual([[s1, s2], [s0, s1], [null, s0]]);
    expect(history.map((r) => r.at)).toEqual([AT, AT, AT]);
  });

  it('seeds a legacy deal from its old history without rewriting legacy timestamps or rows', async () => {
    freezeDate();
    const { deal, s0, s1, s2 } = await fixture();
    const rec = await getSystemEntity(T, 'crm.deal', deal.dealId);
    if (!rec) throw new Error('fixture kernel row missing');
    const { stageHistorySequence: _counter, ...legacy } = deal;
    await putSystemEntity({ tenantId: T, typeName: 'crm.deal', entityId: deal.dealId, orgId: ORG, actor: 'u1', values: { ...rec.values, stage_id: s1 }, ext: { deal: { ...legacy, stageId: s1 } } });
    const rows = new DurableCollection<StageHistoryRow>('crm:stagehistory', (r) => r.historyId, undefined, (r) => r.tenantId);
    const initial = (await getStageHistory(T, ORG, deal.dealId))[0];
    if (!initial) throw new Error('fixture initial history missing');
    const { sequence: _sequence, ...legacyInitial } = initial;
    const oldMove = { ...legacyInitial, historyId: 'dsh:legacy-second', fromStageId: s0, toStageId: s1 };
    await rows.put(legacyInitial);
    await rows.put(oldMove);
    const before = await getStageHistory(T, ORG, deal.dealId);
    expect(before.map((r) => r.historyId)).toEqual([legacyInitial.historyId, oldMove.historyId].sort().reverse());
    await updateDeal(T, ORG, deal.dealId, { stageId: s2 }, ok, 'modern');
    const after = await getStageHistory(T, ORG, deal.dealId);
    expect(after[0]).toMatchObject({ sequence: 3, fromStageId: s1, toStageId: s2, at: AT });
    expect(after.slice(1)).toEqual(before);
    expect((await getDeal(T, ORG, deal.dealId))?.stageHistorySequence).toBe(3);
    expect(await getStageHistory('foreign', ORG, deal.dealId)).toEqual([]);
    expect(await getStageHistory(T, 'foreign', deal.dealId)).toEqual([]);
  });
});
