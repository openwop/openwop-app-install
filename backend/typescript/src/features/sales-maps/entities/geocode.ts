/**
 * Sales Maps — geocoding cache (ADR 0282 Phase 2).
 *
 * Address → {lat,lng} resolution, CACHED in a tenant-scoped collection so a repeat
 * lookup never re-spends a provider call. Three resolution paths:
 *   1. explicit lat/lng in the request → cache + return (manual geocode / seed),
 *   2. a cache hit → return the cached point,
 *   3. a miss → the BYOK geocoding Connection (ADR 0024, SSRF-guarded server-side
 *      egress). Until a geocoding Connection is configured, (3) is a clear
 *      `provider_unconfigured` error — never a fabricated coordinate. Paths (1)+(2)
 *      work with no provider (manual entry + cache), which is what the tests cover.
 *
 * @see docs/adr/0282-dynamic-sales-maps.md §3
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString } from '../../../host/boundedStrings.js';
import { validateGeocode } from './rowGuards.js';

export interface GeocodeResult {
  cacheKey: string; // `${tenantId}:${orgId}:${normalizedAddress}`
  tenantId: string;
  orgId: string;
  address: string;
  lat: number;
  lng: number;
  source: 'manual' | 'provider';
  at: string;
}

const MAX_ADDRESS = 300;
const MAX_PER_ORG = 50000; // hard cap; LRU eviction keeps the org under it
const EVICT_BATCH = 500; // when at the cap, drop this many oldest entries to make room
const PROVIDER_TTL_MS = 365 * 24 * 60 * 60 * 1000; // provider results re-verify yearly; MANUAL coords never expire (MAP-DATA-4)
const geocodes = new DurableCollection<GeocodeResult>('sales-maps:geocode', (g) => g.cacheKey, validateGeocode, (g) => g.tenantId);

const nowIso = (): string => new Date().toISOString();
const isStale = (g: GeocodeResult): boolean => g.source === 'provider' && Date.now() - Date.parse(g.at) > PROVIDER_TTL_MS;
const normalize = (address: string): string => address.trim().toLowerCase().replace(/\s+/g, ' ');
// tenantId folded into the key (DEAL-DATA — defense-in-depth) so a cross-tenant
// orgId collision can never clobber another tenant's cached point.
const cacheKey = (tenantId: string, orgId: string, address: string): string => `${tenantId}:${orgId}:${normalize(address)}`;

function assertLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) throw new OpenwopError('validation_error', '`lat` must be a number within ±90.', 400, { field: 'lat' });
  if (typeof lng !== 'number' || !Number.isFinite(lng) || Math.abs(lng) > 180) throw new OpenwopError('validation_error', '`lng` must be a number within ±180.', 400, { field: 'lng' });
  return { lat, lng };
}

/** LRU-ish eviction (MAP-DATA-4): when the org is at the cache cap, drop the oldest
 *  EVICT_BATCH entries by `at` to make room. Addresses churn slowly, so the oldest
 *  cached point is the cheapest to re-resolve later. */
async function evictIfAtCap(tenantId: string, orgId: string): Promise<void> {
  const orgRows = (await geocodes.listForTenantIndexed(tenantId)).filter((g) => g.orgId === orgId);
  if (orgRows.length < MAX_PER_ORG) return;
  const victims = orgRows.sort((a, b) => a.at.localeCompare(b.at)).slice(0, EVICT_BATCH);
  for (const v of victims) await geocodes.delete(v.cacheKey);
}

/** Resolve (and cache) an address to a point. Manual lat/lng and cache hits need no
 *  provider; a genuine miss requires a configured BYOK geocoding Connection. */
export async function geocode(tenantId: string, orgId: string, input: { address?: unknown; lat?: unknown; lng?: unknown }): Promise<GeocodeResult> {
  const address = cleanString(input.address, MAX_ADDRESS, '');
  if (!address) throw new OpenwopError('validation_error', '`address` is required.', 400, { field: 'address' });
  const key = cacheKey(tenantId, orgId, address);

  // (1) explicit coordinates — manual geocode / seed
  if (input.lat !== undefined || input.lng !== undefined) {
    const { lat, lng } = assertLatLng(input.lat, input.lng);
    if (!(await geocodes.get(key))) await evictIfAtCap(tenantId, orgId); // a NEW key grows the cache
    const result: GeocodeResult = { cacheKey: key, tenantId, orgId, address, lat, lng, source: 'manual', at: nowIso() };
    await geocodes.put(result);
    return result;
  }

  // (2) cache hit — a STALE provider entry (past its TTL) is dropped + re-resolved.
  const cached = await geocodes.get(key);
  if (cached && cached.tenantId === tenantId && cached.orgId === orgId) {
    if (!isStale(cached)) return cached;
    await geocodes.delete(key); // expired provider result → fall through to (3)
  }

  // (3) miss → BYOK geocoding Connection (ADR 0024). Not fabricated: absent a
  // configured provider this fails LOUD, honoring the capability-honesty rule.
  throw new OpenwopError('capability_not_provided', 'No geocoding provider is configured. Add a geocoding Connection, or supply explicit lat/lng.', 503, { address });
}

export async function getCachedGeocode(tenantId: string, orgId: string, address: string): Promise<GeocodeResult | null> {
  const g = await geocodes.get(cacheKey(tenantId, orgId, address));
  return g && g.tenantId === tenantId && g.orgId === orgId ? g : null;
}

