/**
 * `demo-sales-maps` round-trip (ADR 0282) — TST-CVA-2.
 * Warms the geocode cache with manual points (no external geocoder); the visible
 * pins come from demo-dealers outlets. Idempotent; clears clean.
 *
 * Red when: the seeder makes ANY outbound fetch while warming (the fetch spy),
 * writes a point whose coordinates differ from the demo metro table (pinned as
 * literals here, not imported), stops skipping already-warmed addresses
 * (re-seed creates), or the clear stops deleting the cache rows.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

// The demo metro table (`seed-data/solsticeDemo.ts` CITY_COORDS) has 15 cities.
const DEMO_METRO_COUNT = 15;

afterEach(() => { vi.unstubAllGlobals(); });

describe('demo-sales-maps seeder', () => {
  it('warms manual geocode points (no provider call); idempotent; clears clean', async () => {
    const tenantId = 'demo-maps-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    await seedDemoDealers(tenantId); // the real map pins
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    // No provider call: any outbound fetch during the warm-up is a failure.
    const fetchSpy = vi.fn(async (): Promise<Response> => { throw new Error('unexpected outbound fetch'); });
    vi.stubGlobal('fetch', fetchSpy);
    const first = await seedDemoSalesMaps(tenantId);
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first.created).toBe(DEMO_METRO_COUNT);
    expect(await countDemoSalesMaps(tenantId)).toBe(DEMO_METRO_COUNT);

    // Manual cache entries are present and marked source:'manual' (never provider).
    const hit = await getCachedGeocode(tenantId, orgId, 'Seattle, WA');
    expect(hit?.source).toBe('manual');
    expect(hit?.lat).toBe(47.606);
    expect(hit?.lng).toBe(-122.332);

    // Idempotent.
    const before = await countDemoSalesMaps(tenantId);
    expect((await seedDemoSalesMaps(tenantId)).created).toBe(0);
    expect(await countDemoSalesMaps(tenantId)).toBe(before);

    // Clear → zero.
    await clearDemoSalesMaps(tenantId);
    expect(await countDemoSalesMaps(tenantId)).toBe(0);

    expect((await seedDemoSalesMaps(tenantId)).created).toBe(DEMO_METRO_COUNT);
  });
});
