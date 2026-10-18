/**
 * ADR 0728 — a production plan's APPROVAL attests to the CONTENT that was approved.
 *
 * `savePlan` preserved `existing.status` across a full content replacement, so a
 * re-generate into an approved plan left the row reading "approved by Alice" over
 * content Alice never saw — and `recommendations` is what routes real work to real
 * vendors with real budgets. D1 refuses that write, typed.
 *
 * Three cases, deliberately apart: a test asserting only "the refusal throws" would
 * pass with idempotency broken, and a test asserting only idempotency would pass with
 * the guard absent.
 *
 *   1. a DRAFT plan is replaced normally (the guard does not over-fire);
 *   2. an approved plan with CHANGED content is refused AND NOTHING IS WRITTEN
 *      (re-read proves the stored content is intact — a refusal that threw after
 *      the put would satisfy a throw-only assertion);
 *   3. an approved plan re-written with IDENTICAL content still succeeds — the
 *      comparison is on the CLEANED candidate, so an honest idempotent retry of a
 *      node re-sending the same raw model output is NOT refused.
 *
 * w32 (grade-tests) — case 2 alone changed only `strategySummary`, so dropping
 * `recommendations` from the comparison (the field that routes work and budget to
 * vendors) stayed green, and only `approved` was tried although the guard covers
 * every non-draft status. Cases 2c/2d close both; case 4 pins the documented escape.
 *
 * Born red on the pre-ADR service: case 2 writes and returns happily.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { savePlan, transitionPlan, getPlan, __resetProduction } from '../src/features/production/productionService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { OpenwopError } from '../src/types.js';

const TENANT = 'user:adr0728-tenant';
const ORG = 'org-adr0728';
const PLAN = 'pln:adr0728';

const base = {
  tenantId: TENANT,
  orgId: ORG,
  planId: PLAN,
  strategySummary: 'Ship the spring launch with two contractors.',
  recommendations: [
    { assetType: 'video', assetDescription: 'Launch film', executionRoute: 'contractor', rationale: 'no in-house editor', timelineEstimate: '3 weeks' },
  ],
  totalBudget: { min: 1000, max: 5000, currency: 'USD' },
};

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetProduction();
});

describe('ADR 0728 — an approval attests to content', () => {
  it('case 1: a DRAFT plan is replaced normally (the guard does not over-fire)', async () => {
    await savePlan(base);
    const revised = await savePlan({ ...base, strategySummary: 'Revised while still a draft.' });
    expect(revised.status).toBe('draft');
    expect(revised.strategySummary).toBe('Revised while still a draft.');
    expect((await getPlan(TENANT, ORG, PLAN))?.strategySummary, 'the revision is stored').toBe('Revised while still a draft.');
  });

  it('case 2 (BORN RED): an APPROVED plan with changed content is refused, and NOTHING is written', async () => {
    await savePlan(base);
    const approved = await transitionPlan(TENANT, ORG, PLAN, 'approved', 'u-alice');
    expect(approved?.status).toBe('approved');

    await expect(savePlan({ ...base, strategySummary: 'Something nobody approved.' }))
      .rejects.toMatchObject({ code: 'conflict' });

    // The refusal must happen BEFORE the write: a guard that threw after `plans.put`
    // would satisfy a throw-only assertion while the damage was already done.
    const stored = await getPlan(TENANT, ORG, PLAN);
    expect(stored?.strategySummary, 'the approved content is intact').toBe(base.strategySummary);
    expect(stored?.status).toBe('approved');
    expect(stored?.updatedBy, 'and still attributed to the approver').toBe('u-alice');
  });

  it('case 2b: the refusal carries a machine-readable reason and a 409', async () => {
    await savePlan(base);
    await transitionPlan(TENANT, ORG, PLAN, 'approved', 'u-alice');
    const attempt = savePlan({ ...base, strategySummary: 'Different.' });
    await expect(attempt).rejects.toBeInstanceOf(OpenwopError);
    await expect(attempt).rejects.toMatchObject({
      code: 'conflict',
      httpStatus: 409,
      details: { reason: 'plan_not_draft', planId: PLAN, status: 'approved' },
    });
  });

  const rec0 = base.recommendations[0]!;
  it.each([
    ['recommendations (the execution route)', { recommendations: [{ ...rec0, executionRoute: 'agency' }] }, (p: Awaited<ReturnType<typeof getPlan>>) => p?.recommendations[0]?.executionRoute, 'contractor'],
    ['the total budget', { totalBudget: { min: 1000, max: 9000, currency: 'USD' } }, (p: Awaited<ReturnType<typeof getPlan>>) => p?.totalBudget.max, 5000],
    ['the capability assessment', { capabilityAssessment: { overallRecommendation: 'Outsource everything.' } }, (p: Awaited<ReturnType<typeof getPlan>>) => p?.capabilityAssessment.overallRecommendation, ''],
  ] as const)('case 2c: changing %s on an APPROVED plan is refused and nothing is written', async (_label, change, read, approvedValue) => {
    await savePlan(base);
    await transitionPlan(TENANT, ORG, PLAN, 'approved', 'u-alice');
    await expect(savePlan({ ...base, ...change })).rejects.toMatchObject({ code: 'conflict' });
    expect(read(await getPlan(TENANT, ORG, PLAN)), 'the approved value is intact').toBe(approvedValue);
  });

  it.each(['in_production', 'completed'] as const)('case 2d: a plan in %s is guarded too (every non-draft status)', async (status) => {
    await savePlan(base);
    await transitionPlan(TENANT, ORG, PLAN, status, 'u-alice');
    await expect(savePlan({ ...base, strategySummary: 'Something nobody approved.' })).rejects.toMatchObject({ code: 'conflict' });
    const stored = await getPlan(TENANT, ORG, PLAN);
    expect(stored?.strategySummary).toBe(base.strategySummary);
    expect(stored?.status).toBe(status);
  });

  it('case 3 (the leg the comparison layer decides): an IDENTICAL re-write of an approved plan still succeeds', async () => {
    await savePlan(base);
    await transitionPlan(TENANT, ORG, PLAN, 'approved', 'u-alice');
    const again = await savePlan(base); // an honest idempotent retry
    expect(again.status).toBe('approved');
    expect(again.strategySummary).toBe(base.strategySummary);
  });

  it('case 3b: raw input that COERCES to the stored record is still identical — a dropped unknown vendor must not read as a change', async () => {
    // `cleanRecommendations` drops a vendorId that is not in the directory, so this
    // input cleans to exactly what case 3 stored. Comparing RAW vs stored would call
    // it "changed" and refuse an honest retry; comparing CLEANED candidates does not.
    await savePlan(base);
    await transitionPlan(TENANT, ORG, PLAN, 'approved', 'u-alice');
    const withGhost = {
      ...base,
      recommendations: [
        {
          ...base.recommendations[0]!,
          matchingVendors: [{ vendorId: 'vnd:ghost-does-not-exist', name: 'Ghost Co', type: 'contractor' }],
        },
      ],
    };
    const again = await savePlan(withGhost);
    expect(again.status).toBe('approved');
    expect(again.recommendations[0]?.matchingVendors ?? [], 'the ghost vendor was dropped, so the content is unchanged').toEqual([]);
  });

  it('case 4: the documented escape — moved back to draft, a re-write is accepted', async () => {
    // The refusal message tells the caller to "move this one back to draft first";
    // the guard must not outlive that move.
    await savePlan(base);
    await transitionPlan(TENANT, ORG, PLAN, 'approved', 'u-alice');
    await transitionPlan(TENANT, ORG, PLAN, 'draft', 'u-alice');
    const again = await savePlan({ ...base, strategySummary: 'Re-planned after un-approving.' });
    expect(again.status).toBe('draft');
    expect((await getPlan(TENANT, ORG, PLAN))?.strategySummary).toBe('Re-planned after un-approving.');
  });
});
