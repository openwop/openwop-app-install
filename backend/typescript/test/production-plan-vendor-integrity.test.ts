/**
 * PIC-1 — plan→vendor referential integrity. The production-intelligence plan
 * path (`savePlan` → `cleanRecommendations`) persisted any
 * `matchingVendors[].vendorId` verbatim, so a model-fabricated vendor
 * (`vnd:ghost-does-not-exist`, no directory row) survived the durable write and
 * rendered as a real recommendation. This pins the fix: a recommended vendorId
 * that is not in the tenant/org vendor directory is DROPPED (a dangling
 * reference is never persisted); real vendors are kept.
 *
 * w32 (grade-tests): the directory the check consults is ORG-scoped, so a vendor
 * id that exists in ANOTHER org of the same tenant (or in another tenant) must be
 * dropped too — the single ghost-id case could not tell an org-scoped check from a
 * tenant-wide one. The file no longer boots the app: `savePlan` takes the org as a
 * string, so a memory store is the whole fixture.
 *
 * PIC-7 (BLOCKED-ON-PRODUCT, pinned `it.fails`): for a REAL vendor id the persisted
 * `name`/`type` are the MODEL's, not the directory's (`productionService.ts`
 * `cleanRecommendations` returns `{ vendorId, name, type, … }` from the raw
 * input), so a fabricated name rides a valid reference. When the fix lands the
 * `it.fails` goes red — flip it to `it`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createVendor, savePlan, getPlan, __resetProduction } from '../src/features/production/productionService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

const TENANT = 'user:pic1-tenant';
const OTHER_TENANT = 'user:pic1-other-tenant';
const ORG = 'org-pic1';
const OTHER_ORG = 'org-pic1-b';

async function vendorIn(tenantId: string, orgId: string, name: string): Promise<string> {
  const v = await createVendor({ tenantId, orgId, type: 'agency', name, capabilities: [], priceRanges: [], createdBy: 'u-1' });
  return v.vendorId;
}

async function persistedVendorIds(matchingVendors: { vendorId: string; name: string; type: string; matchReason: string }[]): Promise<string[]> {
  const plan = await savePlan({
    tenantId: TENANT, orgId: ORG,
    strategySummary: 'Strategy',
    recommendations: [{ assetType: 'video', executionRoute: 'contractor', rationale: 'r', matchingVendors }],
  });
  const persisted = await getPlan(TENANT, ORG, plan.planId);
  return (persisted?.recommendations[0]?.matchingVendors ?? []).map((mv) => mv.vendorId);
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetProduction();
});

describe('PIC-1 — plan→vendor referential integrity', () => {
  it('drops a fabricated matchingVendor (no directory row) but keeps the real one', async () => {
    const realVendorId = await vendorIn(TENANT, ORG, 'Real Vendor');
    const ids = await persistedVendorIds([
      { vendorId: realVendorId, name: 'Real Vendor', type: 'agency', matchReason: 'in the directory' },
      { vendorId: 'vnd:ghost-does-not-exist', name: 'Ghost Co', type: 'agency', matchReason: 'hallucinated' },
    ]);
    expect(ids, 'exactly the real vendor survives — no dangling reference, no over-drop').toEqual([realVendorId]);
  });

  it('drops a vendor that exists only in ANOTHER org of the same tenant', async () => {
    const realVendorId = await vendorIn(TENANT, ORG, 'Real Vendor');
    const otherOrgVendorId = await vendorIn(TENANT, OTHER_ORG, 'Other Org Vendor');
    const ids = await persistedVendorIds([
      { vendorId: realVendorId, name: 'Real Vendor', type: 'agency', matchReason: 'same org' },
      { vendorId: otherOrgVendorId, name: 'Other Org Vendor', type: 'agency', matchReason: 'another org' },
    ]);
    expect(ids, 'the directory is org-scoped: another org\'s vendor is not this plan\'s reference').toEqual([realVendorId]);
  });

  it('drops a vendor that exists only in ANOTHER tenant', async () => {
    const realVendorId = await vendorIn(TENANT, ORG, 'Real Vendor');
    const otherTenantVendorId = await vendorIn(OTHER_TENANT, ORG, 'Other Tenant Vendor');
    const ids = await persistedVendorIds([
      { vendorId: realVendorId, name: 'Real Vendor', type: 'agency', matchReason: 'same tenant' },
      { vendorId: otherTenantVendorId, name: 'Other Tenant Vendor', type: 'agency', matchReason: 'another tenant' },
    ]);
    expect(ids).toEqual([realVendorId]);
  });

  it.fails('PIC-7: a real vendor id persists the DIRECTORY name and type, not the model\'s', async () => {
    const realVendorId = await vendorIn(TENANT, ORG, 'Real Vendor');
    const plan = await savePlan({
      tenantId: TENANT, orgId: ORG,
      strategySummary: 'Strategy',
      recommendations: [{
        assetType: 'video', executionRoute: 'contractor', rationale: 'r',
        matchingVendors: [{ vendorId: realVendorId, name: 'Acme Premium Partners', type: 'contractor', matchReason: 'model-labelled' }],
      }],
    });
    const mv = (await getPlan(TENANT, ORG, plan.planId))?.recommendations[0]?.matchingVendors?.[0];
    expect(mv?.vendorId).toBe(realVendorId);
    expect({ name: mv?.name, type: mv?.type }).toEqual({ name: 'Real Vendor', type: 'agency' });
  });
});
