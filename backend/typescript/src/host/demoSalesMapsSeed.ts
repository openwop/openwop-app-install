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
 *
 * CHAN-F19 follow-up B: a row no longer holds its address (the key carries only a hash
 * of it), so a demo row is one whose `cacheKey` equals the key a demo address hashes to
 * for that row's tenant and org. A row from before that change still has `address` and
 * is matched by it, so a clear also removes the old demo rows.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { cacheKey, geocode } from '../features/sales-maps/entities/geocode.js';
import { CITY_COORDS } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoSalesMaps');

const normalizeAddress = (a: string): string => a.trim().toLowerCase().replace(/\s+/g, ' ');
const DEMO_ADDRESSES = new Set(Object.keys(CITY_COORDS).map(normalizeAddress));

const geocodeStore = new DurableCollection<{ cacheKey: string; tenantId: string; orgId: string; address?: string; source: string }>(
  'sales-maps:geocode', (g) => g.cacheKey, undefined, (g) => g.tenantId,
);

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

type GeocodeRow = { cacheKey: string; tenantId: string; orgId: string; address?: string; source: string };

/** The demo rows of a tenant, each with the demo address it was written for. */
async function demoGeocodes(tenantId: string): Promise<Array<{ row: GeocodeRow; address: string }>> {
  const keyed = new Map<string, Map<string, string>>(); // orgId → cacheKey → demo address
  const keysFor = (row: GeocodeRow): Map<string, string> => {
    let m = keyed.get(row.orgId);
    if (!m) {
      m = new Map([...DEMO_ADDRESSES].map((a) => [cacheKey(row.tenantId, row.orgId, a), a]));
      keyed.set(row.orgId, m);
    }
    return m;
  };
  const out: Array<{ row: GeocodeRow; address: string }> = [];
  for (const row of await geocodeStore.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId || row.source !== 'manual') continue;
    const legacy = typeof row.address === 'string' ? normalizeAddress(row.address) : null;
    const address = legacy !== null ? (DEMO_ADDRESSES.has(legacy) ? legacy : null) : (keysFor(row).get(row.cacheKey) ?? null);
    if (address !== null) out.push({ row, address });
  }
  return out;
}

export async function countDemoSalesMaps(tenantId: string): Promise<number> {
  return (await demoGeocodes(tenantId)).length;
}

export async function seedDemoSalesMaps(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await resolveOne('sales-maps', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'sales-maps feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  const have = new Set((await demoGeocodes(tenantId)).map((d) => d.address));
  let created = 0;
  for (const [address, { lat, lng }] of Object.entries(CITY_COORDS)) {
    if (have.has(normalizeAddress(address))) continue;
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
  for (const { row } of await demoGeocodes(tenantId)) {
    if (await geocodeStore.delete(row.cacheKey)) cleared += 1;
  }
  log.info('demo_sales_maps_cleared', { tenantId, cleared });
  return { cleared };
}
