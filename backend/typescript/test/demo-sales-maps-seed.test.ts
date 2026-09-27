/**
 * `demo-sales-maps` round-trip (ADR 0282).
 * Warms the geocode cache with manual points (no external geocoder); the visible
 * pins come from demo-dealers outlets. Idempotent; clears clean.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoDealers } from '../src/host/demoDealersSeed.js';
import { seedDemoSalesMaps, clearDemoSalesMaps, countDemoSalesMaps } from '../src/host/demoSalesMapsSeed.js';
import { getCachedGeocode } from '../src/features/sales-maps/entities/geocode.js';
import { listOrgs } from '../src/host/accessControlService.js';

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'crm', salt: 'crm', ...ON });
  registerToggleDefault({ id: 'dealers', salt: 'dealers', ...ON });
  registerToggleDefault({ id: 'sales-maps', salt: 'sales-maps', ...ON });
});

describe('demo-sales-maps seeder', () => {
  it('warms manual geocode points (no provider call); idempotent; clears clean', async () => {
    const tenantId = 'demo-maps-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    await seedDemoDealers(tenantId); // the real map pins
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoSalesMaps(tenantId);
    expect(first.created).toBeGreaterThan(0);

    // Manual cache entries are present and marked source:'manual' (never provider).
    const hit = await getCachedGeocode(tenantId, orgId, 'Seattle, WA');
    expect(hit?.source).toBe('manual');
    expect(typeof hit?.lat).toBe('number');

    // Idempotent.
    const before = await countDemoSalesMaps(tenantId);
    expect((await seedDemoSalesMaps(tenantId)).created).toBe(0);
    expect(await countDemoSalesMaps(tenantId)).toBe(before);

    // Clear → zero.
    await clearDemoSalesMaps(tenantId);
    expect(await countDemoSalesMaps(tenantId)).toBe(0);

    expect((await seedDemoSalesMaps(tenantId)).created).toBeGreaterThan(0);
  });
});
