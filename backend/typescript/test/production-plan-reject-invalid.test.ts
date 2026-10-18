/**
 * PIC-2 — the durable ProductionPlan write must REJECT semantically-invalid model
 * output with a typed failure, never coerce-and-succeed (the non-negotiable
 * "invalid model output is a typed failure, never success-with-empty").
 *
 * Proved by probe P2: `cleanRecommendations` returned `[]` for a non-array
 * `recommendations` (succeed-with-empty), and coerced an unknown `executionRoute`
 * to 'internal' (P3, silent semantic corruption) — both persisted a durable row.
 *
 * The reject boundary is SEMANTIC (keyed on the SSoT enum constants + structure),
 * NOT cosmetic: length caps, currency ISO-normalisation (PROD2-R2), numeric
 * clamping and array truncation still COERCE; only structural/enum violations that
 * change a plan's MEANING become a typed `OpenwopError('validation_error')` that
 * blocks `plans.put`. A legitimately-sparse-but-well-formed plan (empty
 * recommendations, absent optionals) still persists.
 *
 * w32 (grade-tests) — each rejection now asserts the typed 422 AND which rule
 * fired (`details.errors`), so a refusal from a different guard cannot stand in
 * for the one a case names; T6 also carries the PROD2-R2 upper-casing leg that
 * used to live in `production-surface-authz.test.ts`.
 */

/** The typed PIC-2 refusal, naming the rule that fired. */
const rejected = (rule: string) => ({
  code: 'validation_error',
  httpStatus: 422,
  details: { errors: [expect.stringContaining(rule)] },
});
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { savePlan, listPlans, __resetProduction } from '../src/features/production/productionService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

const TENANT = 'user:pic2-tenant';
const ORG = 'org-pic2';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(async () => {
  await __resetProduction();
});
afterEach(async () => {
  await __resetProduction();
});

/** Count plan rows visible to the tenant/org (proves nothing was persisted). */
async function planCount(): Promise<number> {
  return (await listPlans(TENANT, ORG)).length;
}

describe('PIC-2 — savePlan rejects semantically-invalid model output (typed failure, no durable write)', () => {
  it('T1 — non-array `recommendations` is a typed failure, NOT succeed-with-empty (P2)', async () => {
    await expect(
      savePlan({ tenantId: TENANT, orgId: ORG, strategySummary: 'a strategy', recommendations: 'not-an-array' }),
    ).rejects.toMatchObject(rejected('recommendations must be an array'));
    expect(await planCount(), 'a rejected plan must leave NO durable row').toBe(0);
  });

  it('T2 — an unknown `executionRoute` is rejected, NOT silently coerced to internal (P3)', async () => {
    await expect(
      savePlan({
        tenantId: TENANT,
        orgId: ORG,
        strategySummary: 'a strategy',
        recommendations: [{ assetType: 'video', executionRoute: 'martian', rationale: 'because' }],
      }),
    ).rejects.toMatchObject(rejected("executionRoute 'martian'"));
    expect(await planCount()).toBe(0);
  });

  it('T3 — a non-object recommendation entry is rejected, NOT fabricated into a placeholder rec', async () => {
    // `[42]` / `[null]` would otherwise become a full `asset / internal / $0` rec.
    await expect(
      savePlan({ tenantId: TENANT, orgId: ORG, strategySummary: 'a strategy', recommendations: [42] }),
    ).rejects.toMatchObject(rejected('recommendations[0] must be an object'));
    expect(await planCount()).toBe(0);
  });

  it('T3b — a hallucinated matchingVendor with a bad `type` is DROPPED (PIC-1), NOT a whole-plan rejection', async () => {
    // A rec is otherwise valid; its matchingVendor has an unknown type. The gate
    // does not hard-fail the plan on it (PIC-1 owns the vendor-hallucination path);
    // the plan persists (with the vendor dropped for want of a directory entry).
    const plan = await savePlan({
      tenantId: TENANT,
      orgId: ORG,
      strategySummary: 'a strategy',
      recommendations: [
        { assetType: 'video', executionRoute: 'agency', rationale: 'because', matchingVendors: [{ vendorId: 'ghost', name: 'Nope', type: 'wizard' }] },
      ],
    });
    expect(plan.recommendations).toHaveLength(1);
    expect(plan.recommendations[0]!.matchingVendors ?? [], 'the hallucinated vendor is dropped').toEqual([]);
    expect(await planCount()).toBe(1);
  });

  it('T4 — a blank strategySummary is rejected (the one required content field)', async () => {
    await expect(
      savePlan({ tenantId: TENANT, orgId: ORG, strategySummary: '   ', recommendations: [] }),
    ).rejects.toMatchObject(rejected('strategySummary is required'));
    expect(await planCount()).toBe(0);
  });

  it('T5 — a legitimately-sparse plan (valid summary, EMPTY recommendations) still PERSISTS (no over-rejection)', async () => {
    const plan = await savePlan({ tenantId: TENANT, orgId: ORG, strategySummary: 'early-stage strategy', recommendations: [] });
    expect(plan.recommendations).toEqual([]);
    expect(await planCount()).toBe(1);
  });

  it('T6 — a fully valid plan persists, and cosmetic values are still COERCED not rejected (PROD2-R2 intact)', async () => {
    const plan = await savePlan({
      tenantId: TENANT,
      orgId: ORG,
      strategySummary: 'x',
      recommendations: [
        { assetType: 'landing', executionRoute: 'agency', rationale: 'r', budget: { min: 1, max: 2, currency: 'dollars' } },
        { assetType: 'video', executionRoute: 'internal', rationale: 'r', budget: { min: 1, max: 2, currency: 'eur' } },
      ],
    });
    // currency 'dollars' is COSMETIC → normalised to USD + persisted (not rejected).
    expect(plan.recommendations[0]!.budget.currency).toBe('USD');
    // …and a real ISO code is kept, upper-cased (PROD2-R2 — `Intl.NumberFormat` needs it).
    expect(plan.recommendations[1]!.budget.currency).toBe('EUR');
    expect(await planCount()).toBe(1);
  });
});
