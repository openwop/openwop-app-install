/**
 * ADR 1015 — the bound custom domain a request arrived on, recorded by the host
 * guard (`middleware/customDomain.ts`) for handlers that serve that site
 * differently from the platform origin (the prerender's visitor runtime). Absent
 * on the platform origin. Core-owned so the guard never imports a feature.
 */
import type { Response } from 'express';

/** ADR 1015 D4 — the per-workspace switch for the visitor runtime on its custom
 *  domain. Declared by the custom-domains feature, read by publishing; core-owned
 *  so neither feature imports the other. */
export const SITE_RUNTIME_TOGGLE = 'custom-domains.visitor-runtime';
/** ADR 1030 D4 — the designed-pages stylesheet on a bound domain (tenant, off). */
export const DESIGNED_PAGES_TOGGLE = 'custom-domains.designed-pages';

/** `hostname` is the verified custom domain the request arrived on (canonical,
 *  lower-case, no port); it is never taken from an unverified header. */
export interface BoundSite { tenantId: string; orgId: string; hostname?: string }
const BOUND = Symbol.for('openwop.boundCustomDomain');

export function markBoundSite(res: Response, site: BoundSite): void {
  (res.locals as Record<symbol, unknown>)[BOUND] = site;
}

export function boundSiteOf(res: Response): BoundSite | null {
  const v = (res.locals as Record<symbol, unknown>)[BOUND];
  return v && typeof v === 'object' ? (v as BoundSite) : null;
}

/** The public origin of the custom domain this response is served on
 *  (`https://<host>`), or null on the platform origin. A served page's canonical,
 *  `og:url` and JSON-LD site URL must name THIS origin, or search engines file
 *  the tenant's site as a copy of an internal app URL. Custom domains are served
 *  over HTTPS only (ADR 0906), so the scheme is fixed. */
export function boundSiteOrigin(res: Response): string | null {
  const host = boundSiteOf(res)?.hostname;
  return host ? `https://${host}` : null;
}
