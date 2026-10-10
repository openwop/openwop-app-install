/**
 * ADR 0860 D1/D2 — where a public visitor is, and whether that place requires an
 * opt-in before non-essential analytics.
 *
 * THE SIGNAL. Neither Cloud Run nor Firebase Hosting adds a country header, so the
 * region comes from a header the OPERATOR's edge sets (a Google load balancer's
 * `{client_region}` / `{client_region_subdivision}` custom headers, Cloudflare's
 * `CF-IPCountry`). Clients can send any of those names themselves, so the value is
 * only trustworthy when every ingress path OVERWRITES it — which only the operator
 * can know, so only the operator names it (`OPENWOP_GEO_COUNTRY_HEADER`,
 * `OPENWOP_GEO_SUBDIVISION_HEADER`; both unset by default). A forged region moves
 * the default only for the forger's own data, never anyone else's.
 *
 * UNKNOWN IS REGULATED. Unset env, an absent header or a malformed value all
 * resolve to `null`, and `null` asks (opt-in). The default deployment therefore
 * asks every visitor.
 */

import type { Request } from 'express';

/** A visitor's region: ISO 3166-1 alpha-2 country plus an optional
 *  `CC-SUB` subdivision. `null` = unknown. */
export interface VisitorRegion { country: string; subdivision?: string }

/** The code-level floor (the owner's three, 2026-10-07). A tenant policy can ADD
 *  regions; it can never remove one of these. */
export const REGULATED_REGION_FLOOR: readonly string[] = ['EEA', 'UK', 'US-CA'];

const EU27: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];
const EEA: readonly string[] = [...EU27, 'IS', 'LI', 'NO'];

function headerValue(req: Request, envName: string): string | undefined {
  const name = process.env[envName]?.trim();
  if (!name) return undefined;
  const raw = req.headers[name.toLowerCase()];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.trim().toUpperCase() : undefined;
}

/** Two-letter values geo databases emit that are NOT a country: Cloudflare's `XX`
 *  (unknown) and `T1` (Tor), MaxMind's `A1`/`A2`/`O1`/`AP`/`EU`, and ISO's
 *  user-assigned `ZZ`. Each means "we do not know", so each is unknown. */
const NOT_A_COUNTRY: ReadonlySet<string> = new Set(['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'AP', 'EU']);

/** The request's region, or `null` when it cannot be known. */
export function visitorRegionOf(req: Request): VisitorRegion | null {
  const country = headerValue(req, 'OPENWOP_GEO_COUNTRY_HEADER');
  if (!country || !/^[A-Z]{2}$/.test(country) || NOT_A_COUNTRY.has(country)) return null;
  const sub = headerValue(req, 'OPENWOP_GEO_SUBDIVISION_HEADER');
  // Accepted: `USCA` (the load balancer's spelling), `US-CA`, or a bare `CA`.
  let subdivision: string | undefined;
  if (sub) {
    const m = /^(?:([A-Z]{2})-?)?([A-Z0-9]{1,3})$/.exec(sub);
    if (m && (!m[1] || m[1] === country)) subdivision = `${country}-${m[2]}`;
  }
  return { country, ...(subdivision ? { subdivision } : {}) };
}

/** Expand one policy token into the countries and subdivisions it names.
 *  `CA` is ambiguous (ISO says Canada; the shipped policy means California), so it
 *  names BOTH — the ambiguity errs toward asking. */
function expandToken(token: string): { countries: string[]; subdivisions: string[] } {
  const t = token.trim().toUpperCase();
  if (t === 'EU') return { countries: [...EU27], subdivisions: [] };
  if (t === 'EEA') return { countries: [...EEA], subdivisions: [] };
  if (t === 'UK' || t === 'GB') return { countries: ['GB'], subdivisions: [] };
  if (t === 'CA') return { countries: ['CA'], subdivisions: ['US-CA'] };
  if (/^[A-Z]{2}$/.test(t)) return { countries: [t], subdivisions: [] };
  if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(t)) return { countries: [], subdivisions: [t] };
  return { countries: [], subdivisions: [] };
}

/** Whether a visitor in `region` must opt in, given the tenant's extra regions.
 *  Unknown region ⇒ regulated. A known country with a regulated subdivision and NO
 *  subdivision signal ⇒ regulated (the visitor might be in it). */
export function regionIsRegulated(region: VisitorRegion | null, tenantRegions: readonly string[] = []): boolean {
  if (!region) return true;
  const countries = new Set<string>();
  const subdivisions = new Set<string>();
  for (const token of [...REGULATED_REGION_FLOOR, ...tenantRegions]) {
    const e = expandToken(token);
    e.countries.forEach((c) => countries.add(c));
    e.subdivisions.forEach((s) => subdivisions.add(s));
  }
  if (countries.has(region.country)) return true;
  if (region.subdivision) return subdivisions.has(region.subdivision);
  return [...subdivisions].some((s) => s.startsWith(`${region.country}-`));
}
