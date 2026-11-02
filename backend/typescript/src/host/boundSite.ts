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

export interface BoundSite { tenantId: string; orgId: string }
const BOUND = Symbol.for('openwop.boundCustomDomain');

export function markBoundSite(res: Response, site: BoundSite): void {
  (res.locals as Record<symbol, unknown>)[BOUND] = site;
}

export function boundSiteOf(res: Response): BoundSite | null {
  const v = (res.locals as Record<symbol, unknown>)[BOUND];
  return v && typeof v === 'object' ? (v as BoundSite) : null;
}
