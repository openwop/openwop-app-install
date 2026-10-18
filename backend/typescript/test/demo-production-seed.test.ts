/**
 * `demo-production` round-trip (ADR 0172 — Production Intelligence).
 * Creative vendors + asset-production plans; idempotent; clears clean; and the
 * global-keyed plan ids DON'T collide across tenants (the cross-tenant guard).
 *
 * w32 (grade-tests): pins each demo plan's status by slug (the old `.some(approved)`
 * passed either plan being approved) and that the seeded plan CONTENT landed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoProduction, clearDemoProduction, countDemoProduction } from '../src/host/demoProductionSeed.js';
import { listVendors, listPlans } from '../src/features/production/productionService.js';
import { listOrgs } from '../src/host/accessControlService.js';

async function demoPlansOf(tenantId: string): Promise<{ planId: string; status: string; recommendations: unknown[] }[]> {
  const orgId = (await listOrgs(tenantId))[0]!.orgId;
  return (await listPlans(tenantId, orgId)).filter((p) => p.planId.startsWith('pln:demo-production:'));
}

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'production', salt: 'production', ...ON });
});

describe('demo-production seeder', () => {
  it('seeds vendors + plans; idempotent; clears clean', async () => {
    const tenantId = 'demo-prod-t1';
    await seedDemoPeople(tenantId);
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoProduction(tenantId);
    expect(first.created).toBe(7); // 5 vendors + 2 plans

    expect((await listVendors(tenantId, orgId)).filter((v) => v.createdBy === 'demo:production')).toHaveLength(5);
    const plans = await demoPlansOf(tenantId);
    expect(plans).toHaveLength(2);
    expect(Object.fromEntries(plans.map((p) => [p.planId.split(':').pop(), p.status])))
      .toEqual({ 'spring-launch': 'approved', 'holiday-gift': 'draft' });
    expect(plans.find((p) => p.planId.endsWith(':spring-launch'))?.recommendations, 'the seeded plan content landed').toHaveLength(4);

    // Idempotent.
    expect((await seedDemoProduction(tenantId)).created).toBe(0);
    expect(await countDemoProduction(tenantId)).toBe(7);

    // Clear → zero.
    await clearDemoProduction(tenantId);
    expect(await countDemoProduction(tenantId)).toBe(0);
    expect(await demoPlansOf(tenantId)).toHaveLength(0);

    expect((await seedDemoProduction(tenantId)).created).toBe(7);
  });

  it('does not collide across tenants (global-keyed plan ids fold a tenant hash)', async () => {
    const a = 'demo-prod-A';
    const b = 'demo-prod-B';
    await seedDemoPeople(a);
    await seedDemoPeople(b);
    await seedDemoProduction(a);
    await seedDemoProduction(b);
    // Each tenant has its OWN plans (no clobber via the shared plan store).
    expect(await countDemoProduction(a)).toBe(7);
    expect(await countDemoProduction(b)).toBe(7);
    // Clearing A leaves B intact.
    await clearDemoProduction(a);
    expect(await countDemoProduction(a)).toBe(0);
    expect(await countDemoProduction(b)).toBe(7);
  });
});
