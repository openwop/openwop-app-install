/**
 * Read-side row validator (ADR 0282) for the geocode cache — parity with the
 * dealers/commissions collections. A type predicate (no cast); LENIENT (only core
 * identity + the load-bearing numeric coordinates), so a corrupt row is skipped
 * rather than surfacing NaN coordinates to the map layer.
 */
import type { GeocodeResult } from './geocode.js';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNeStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isGeocode(v: unknown): v is GeocodeResult {
  return isObj(v) && isNeStr(v.cacheKey) && isNeStr(v.tenantId) && isNeStr(v.orgId) && isNeStr(v.address) && isNum(v.lat) && isNum(v.lng);
}

export const validateGeocode = (v: unknown): GeocodeResult | null => (isGeocode(v) ? v : null);
