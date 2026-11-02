/**
 * `demo-dealers` round-trip (ADR 0281 — dealer-network PRM).
 * Dealers over demo-crm companies + outlets (with lat/lng for the sales map) +
 * registrations; idempotent; clears clean via the real cascade.
 *
 * TST-CUE-3. Counts are pinned to the seed's `DEALERS` table (not exported, so the
 * arithmetic is spelled out beside each number): 8 dealers + 14 outlets + 4
 * registrations. Red when the skip ignores the toggle, when a re-seed re-creates
 * outlets, when outlets lose their coordinates, or when clear leaves the
 * dealers' registrations behind.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoDealers, clearDemoDealers, countDemoDealers } from '../src/host/demoDealersSeed.js';
import { listDealers, listOutlets } from '../src/features/dealers/entities/dealer.js';
import { listRegistrations } from '../src/features/dealers/entities/registration.js';
import { listOrgs } from '../src/host/accessControlService.js';

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };
/** Outlets with lat/lng after a first seed — MEASURED 2026-10-29 (`outletCoords` covers every seeded outlet). */
const MEASURED_COORDS = 14;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'crm', salt: 'crm', ...ON });
  registerToggleDefault({ id: 'dealers', salt: 'dealers', ...ON });
});

describe('demo-dealers seeder', () => {
  it('seeds dealers + outlets (with coords) + registrations; idempotent; clears clean', async () => {
    const tenantId = 'demo-dealers-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoDealers(tenantId);
    // DEALERS: 8 dealers; outlets 3+3+2+2+1+1+1+1 = 14; registrations 4.
    expect(first.created).toBe(8 + 14 + 4);
    expect(first.details).toEqual({ dealers: 8, outlets: 14, registrations: 4 });

    const dealers = await listDealers(tenantId, orgId);
    expect(dealers.length).toBe(8);
    expect(dealers.some((d) => d.status === 'suspended')).toBe(true); // one suspended partner
    expect(dealers.every((d) => d.companyId.includes('demo-crm'))).toBe(true);

    // Outlets carry lat/lng (the sales-map pins).
    let withCoords = 0;
    for (const d of dealers) withCoords += (await listOutlets(tenantId, orgId, { dealerId: d.dealerId })).filter((o) => typeof o.lat === 'number' && typeof o.lng === 'number').length;
    expect(withCoords).toBe(MEASURED_COORDS);
    expect((await listRegistrations(tenantId, orgId)).length).toBe(4);

    // Idempotent.
    const before = await countDemoDealers(tenantId);
    const second = await seedDemoDealers(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoDealers(tenantId)).toBe(before);

    // Clear → zero, no dealers left.
    await clearDemoDealers(tenantId);
    expect(await countDemoDealers(tenantId)).toBe(0);
    expect((await listDealers(tenantId, orgId)).length).toBe(0);
    expect(await listRegistrations(tenantId, orgId)).toEqual([]); // the PRM rows go with them

    // Round-trips.
    expect((await seedDemoDealers(tenantId)).created).toBe(8 + 14 + 4);
  });

  it('skips honestly when the dealers feature is off', async () => {
    const tenantId = 'demo-dealers-off';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    // 'dealers' default is ON in this suite; resolve OFF via a per-tenant override.
    const { saveConfig, getEffectiveConfig } = await import('../src/host/featureToggles/service.js');
    const cfg = (await getEffectiveConfig('dealers'))!;
    await saveConfig({ ...cfg, tenantOverrides: { [tenantId]: { status: 'off' } } }, 'test');
    const r = await seedDemoDealers(tenantId);
    expect(r.created).toBe(0);
    expect(r.details?.skipped).toBe('dealers feature is off');
    const orgId = (await listOrgs(tenantId))[0]!.orgId;
    expect(await listDealers(tenantId, orgId)).toEqual([]);
  });
});
