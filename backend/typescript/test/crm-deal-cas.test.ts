/**
 * ADR 0627 D6 — `updateDeal` / `moveDealStage` are CAS-guarded, with the
 * stage-history append inside the WON attempt only.
 *
 * The witness is the HISTORY CHAIN, not the final stage: two concurrent moves
 * under the old get→put both read the initial stage and both appended
 * `initial → X` rows while only one stage landed — history claiming a
 * transition the row never made. With the CAS the loser re-reads and its row
 * says `winner's stage → X`, so the chain links `from` to the previous `to`.
 * SABOTAGE: replace `deals.cas(raw, next)` with `deals.put(next)` + `true` and
 * the chain assertion goes red (two rows with the same `fromStageId`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createDeal, updateDeal, getDeal, getStageHistory } from '../src/features/crm/entities/deals.js';
import { createPipeline } from '../src/features/crm/entities/pipelines.js';

const T = 'tenant-deal-cas';
const ORG = 'org-1';
const ok = { validateCompany: async () => true, validateContact: async () => true };

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0627 D6 — concurrent stage moves', () => {
  it('two concurrent moveDealStage calls → one history row EACH, chained, and the final stage is one of the two', async () => {
    const p = await createPipeline(T, ORG, 'Sales', [{ name: 'New' }, { name: 'Qualified' }, { name: 'Proposal' }]);
    const [s0, s1, s2] = p.stages.map((s) => s.stageId) as [string, string, string];
    const deal = await createDeal({ tenantId: T, orgId: ORG, title: 'Race', pipelineId: p.pipelineId, stageId: s0, createdBy: 'u1', ...ok });

    const [a, b] = await Promise.all([
      updateDeal(T, ORG, deal.dealId, { stageId: s1 }, ok, 'agent-a'),
      updateDeal(T, ORG, deal.dealId, { stageId: s2 }, ok, 'agent-b'),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const final = (await getDeal(T, ORG, deal.dealId))!;
    expect([s1, s2]).toContain(final.stageId);

    // The creation row + exactly one row per move. Two rows can land in the
    // same millisecond, so the chain is asserted ORDER-INDEPENDENTLY rather than
    // through the `at` sort.
    const history = await getStageHistory(T, ORG, deal.dealId);
    expect(history).toHaveLength(3);
    const moves = history.filter((r) => r.fromStageId !== null);
    expect(moves).toHaveLength(2);
    expect(new Set(moves.map((r) => r.toStageId))).toEqual(new Set([s1, s2]));
    // The CHAIN: exactly ONE move started from the initial stage (the winner),
    // and the other started from where the winner landed (the loser re-read
    // before writing) and ended on the deal's final stage. Under a plain put
    // BOTH rows would claim `s0 →`, and the deal would show a stage one of
    // them never moved it from.
    const first = moves.filter((r) => r.fromStageId === s0);
    expect(first, 'exactly one move started from the initial stage').toHaveLength(1);
    const second = moves.find((r) => r.fromStageId !== s0)!;
    expect(second.fromStageId).toBe(first[0]!.toStageId);
    expect(second.toStageId).toBe(final.stageId);
  });

  it('a lost-then-won attempt still applies ITS patch on top of the winner\'s (no lost update)', async () => {
    const deal = await createDeal({ tenantId: T, orgId: ORG, title: 'Fields', createdBy: 'u1', ...ok });
    await Promise.all([
      updateDeal(T, ORG, deal.dealId, { amount: 500 }, ok, 'a'),
      updateDeal(T, ORG, deal.dealId, { owner: 'owner-b' }, ok, 'b'),
    ]);
    const final = (await getDeal(T, ORG, deal.dealId))!;
    expect(final.amount, 'the amount patch survived the owner patch').toBe(500);
    expect(final.owner, 'the owner patch survived the amount patch').toBe('owner-b');
  });

  it('a same-stage re-PATCH appends nothing (the transition guard still holds under CAS)', async () => {
    const deal = await createDeal({ tenantId: T, orgId: ORG, title: 'Idle', createdBy: 'u1', ...ok });
    await updateDeal(T, ORG, deal.dealId, { stageId: deal.stageId }, ok, 'u1');
    expect(await getStageHistory(T, ORG, deal.dealId)).toHaveLength(1);
  });

  it('a missing / cross-org deal is null, never a conflict', async () => {
    const deal = await createDeal({ tenantId: T, orgId: ORG, title: 'X', createdBy: 'u1', ...ok });
    expect(await updateDeal(T, 'other-org', deal.dealId, { title: 'nope' }, ok, 'u1')).toBeNull();
    expect(await updateDeal(T, ORG, 'deal:missing', { title: 'nope' }, ok, 'u1')).toBeNull();
  });
});
