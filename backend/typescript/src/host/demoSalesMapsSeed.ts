/**
 * `demo-sales-maps` seeder (ADR 0282 — dynamic sales maps).
 *
 * The `/sales-map` surface owns no map/pin entity of its own: its **pins are the
 * demo-dealers outlets** (their `lat`/`lng`) and its choropleth is demo-territories
 * attainment. This seeder therefore `dependsOn: ['demo-dealers','demo-territories']`
 * (which transitively seed the visible map) and additionally warms the feature's
 * ONE own entity — the geocode CACHE — with `source:'manual'` entries for the
 * demo metros, via the real `geocode()` service (caller-supplied lat/lng, so it
 * NEVER calls an external geocoder or mints a credential).
 *
 * Toggle-gated on `sales-maps`; skips honestly (never flips). Geocode rows have
 * no `createdBy` → demo rows are anchored on `source:'manual'` + the demo metro
 * address set (count/clear select exactly those).
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { geocode } from '../features/sales-maps/entities/geocode.js';
import { CITY_COORDS } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoSalesMaps');

const DEMO_ADDRESSES = new Set(Object.keys(CITY_COORDS).map((a) => a.trim().toLowerCase().replace(/\s+/g, ' ')));

const geocodeStore = new DurableCollection<{ cacheKey: string; tenantId: string; address: string; source: string }>(
  'sales-maps:geocode', (g) => g.cacheKey, undefined, (g) => g.tenantId,
);

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

function isDemoGeocode(row: { address: string; source: string }): boolean {
  return row.source === 'manual' && DEMO_ADDRESSES.has(row.address.trim().toLowerCase().replace(/\s+/g, ' '));
}

export async function countDemoSalesMaps(tenantId: string): Promise<number> {
  return (await geocodeStore.listForTenantIndexed(tenantId)).filter(isDemoGeocode).length;
}

export async function seedDemoSalesMaps(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await resolveOne('sales-maps', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'sales-maps feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  const have = new Set((await geocodeStore.listForTenantIndexed(tenantId)).filter(isDemoGeocode).map((r) => r.address.trim().toLowerCase().replace(/\s+/g, ' ')));
  let created = 0;
  for (const [address, { lat, lng }] of Object.entries(CITY_COORDS)) {
    if (have.has(address.trim().toLowerCase().replace(/\s+/g, ' '))) continue;
    // Manual point — lat/lng supplied, so no provider call / no BYOK credential.
    await geocode(tenantId, orgId, { address, lat, lng });
    created += 1;
  }
  const details = { geocodePoints: created };
  log.info('demo_sales_maps_seeded', { tenantId, created, ...details });
  return { created, details };
}

export async function clearDemoSalesMaps(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  let cleared = 0;
  for (const row of (await geocodeStore.listForTenantIndexed(tenantId)).filter(isDemoGeocode)) {
    await geocodeStore.delete(row.cacheKey); cleared += 1;
  }
  log.info('demo_sales_maps_cleared', { tenantId, cleared });
  return { cleared };
}
