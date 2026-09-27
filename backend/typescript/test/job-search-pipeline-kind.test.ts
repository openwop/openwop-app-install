/**
 * ADR 0540 P0/D3 — a job pipeline is not a revenue pipeline.
 *
 * CRM's weighted report computes `Σ(amount × stage probability)`. Over a job
 * search that is the sum of every salary you applied for — not merely useless
 * but actively misleading, which this repo treats as a defect rather than a
 * cosmetic issue.
 *
 * The discriminator is additive: `kind` is optional, so every pipeline that
 * existed before this keeps its exact meaning with no migration.
 *
 * The load-bearing choice is `null`, NOT `0`. Zero asserts "this stage holds no
 * money"; null says "summing money here is not a question with an answer". A
 * test that accepted either would not be testing the decision.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { computePipelineReport } from '../src/features/crm/reportService.js';
import { createPipeline, createDeal } from '../src/features/crm/crmEntitiesService.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';

const TENANT = 'user:t-jobkind';
const ORG = 'org-jobkind';

describe('ADR 0540 D3 — non-revenue pipelines suppress currency rollups', () => {
  beforeEach(async () => {
    __resetHostExtPersistence();
    initHostExtPersistence(openSqliteStorage(':memory:'));
  });

  async function seed(kind: 'revenue' | 'non-revenue' | undefined, amount: number) {
    const p = await createPipeline(TENANT, ORG, `p-${kind ?? 'default'}`, [{ name: 'Applied', probability: 50 }], kind);
    const stageId = p.stages[0]!.stageId;
    await createDeal({
      tenantId: TENANT, orgId: ORG, title: 'Staff Engineer',
      pipelineId: p.pipelineId, stageId, amount, currency: 'USD',
      createdBy: 'test',
      validateCompany: async () => true,
      validateContact: async () => true,
    });
    return computePipelineReport(TENANT, ORG, p.pipelineId, Date.now());
  }

  it('a REVENUE pipeline is completely unchanged — the regression this must not cause', () => {
    // The whole design claim is "a small, honest change to a shipped feature
    // rather than a fork of it". If revenue reports move, that claim is false.
    return seed('revenue', 100_000).then((r) => {
      expect(r.kind).toBe('revenue');
      expect(r.perStage[0]?.count).toBe(1);
      expect(r.perStage[0]?.sum).toBe(100_000);
      expect(r.perStage[0]?.weightedSum).toBe(50_000);
      expect(r.perStage[0]?.sums).toEqual([{ currency: 'USD', sum: 100_000, weightedSum: 50_000 }]);
      expect(r.currencies).toEqual(['USD']);
    });
  });

  it('an ABSENT kind means revenue — every pre-existing pipeline keeps its meaning', async () => {
    const r = await seed(undefined, 80_000);
    expect(r.kind).toBe('revenue');
    expect(r.perStage[0]?.sum).toBe(80_000);
  });

  it('a NON-REVENUE pipeline reports counts and NULL money — never zero', async () => {
    const r = await seed('non-revenue', 180_000);
    expect(r.kind).toBe('non-revenue');
    // The count is the honest number and must survive.
    expect(r.perStage[0]?.count).toBe(1);
    // `null`, not `0`: zero would claim the stage holds no money, which is a
    // different false statement from "this rollup is meaningless".
    expect(r.perStage[0]?.sum).toBeNull();
    expect(r.perStage[0]?.weightedSum).toBeNull();
    expect(r.perStage[0]?.sum, 'zero would be a DIFFERENT lie').not.toBe(0);
    expect(r.perStage[0]?.sums).toEqual([]);
  });

  it('suppresses the currency warning too — there are no blind totals to warn about', async () => {
    const r = await seed('non-revenue', 180_000);
    expect(r.currencies).toEqual([]);
  });

  it('suppresses the ROLLUP, never the record — the deal keeps its amount', async () => {
    // One application's salary is real and useful on the record; it is only the
    // aggregate that is nonsense. A design that dropped the amount would lose
    // information the user entered.
    const { listDeals } = await import('../src/features/crm/crmEntitiesService.js');
    await seed('non-revenue', 180_000);
    const deals = await listDeals(TENANT, ORG, {});
    expect(deals.at(-1)?.amount).toBe(180_000);
  });
});
