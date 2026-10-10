/**
 * ADR 0860 D3 — the ONE decision for every public-visitor analytics lane: the
 * beacon, the page read's experiment assignment, the funnel view/step/next routes,
 * the funnel attribution sink and the form submit's identity-link gate. It moved
 * here from `analytics/consentGate.ts` (which now delegates) so `publishing` and
 * `funnels` reach it over their existing `consent` edge.
 *
 * The rule (ADR 0857 D3, unchanged): with no token, the decision is for the
 * `sessionKey`; with a token, it is for the `visitor:` subject the token names, and
 * an erasure-tombstoned `sessionKey` stays refused (a token must not resurrect a key
 * the operator erased). New in ADR 0860: the request's region rides along, so a
 * visitor with no record falls to the region-aware default instead of the
 * unset-policy deny.
 *
 * A supplied token is validated even when the `consent` toggle is off: the same
 * request must not mean two things depending on a toggle the caller cannot see.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { isAllowed, isErasureTombstoned } from './consentService.js';
import { verifyPublicSubjectToken } from './publicSubjectToken.js';
import { visitorRegionOf, type VisitorRegion } from './visitorRegion.js';

/** The request header a GET lane reads the token from (a query parameter would
 *  land the bearer in request logs). Listed in `middleware/cors.ts`. */
export const CONSENT_TOKEN_HEADER = 'X-OpenWOP-Consent-Token';

/** Resolve the consent subject a request carries. Throws the typed 400 for a
 *  supplied-but-invalid token; returns `undefined` when none was supplied. */
export function resolveConsentTokenSubject(tenantId: string, consentToken: unknown): string | undefined {
  if (consentToken === undefined) return undefined;
  const invalid = (): never => {
    throw new OpenwopError(
      'validation_error',
      'Invalid `consentToken`. Omit the field, or mint a fresh token through the public consent lane and send that instead.',
      400,
      { field: 'consentToken' },
    );
  };
  // PRESENCE, not truthiness (the CONS-2 review F1 lesson): `""`, `null`, `0`
  // are supplied-and-invalid, never "absent".
  if (typeof consentToken !== 'string' || consentToken.trim().length === 0) return invalid();
  return verifyPublicSubjectToken(tenantId, consentToken.trim()) ?? invalid();
}

/** The token a GET request carries in `CONSENT_TOKEN_HEADER`, or `undefined`. */
export function consentTokenHeaderOf(req: Request): string | undefined {
  const raw = req.headers[CONSENT_TOKEN_HEADER.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** What a visitor decision needs from its request, resolved ONCE (the token is
 *  validated before any store read, so its 400 is never masked as an outage). */
export interface VisitorConsentContext { tokenSubject: string | undefined; region: VisitorRegion | null }

export function visitorConsentContextOf(req: Request, tenantId: string, consentToken: unknown): VisitorConsentContext {
  return { tokenSubject: resolveConsentTokenSubject(tenantId, consentToken), region: visitorRegionOf(req) };
}

/** Whether analytics may record for this visitor. */
export async function visitorAnalyticsAllowed(tenantId: string, sessionKey: string, ctx: VisitorConsentContext): Promise<boolean> {
  const visitor = { region: ctx.region };
  if (ctx.tokenSubject === undefined) return isAllowed(tenantId, sessionKey, 'analytics', { visitor });
  if (sessionKey && await isErasureTombstoned(tenantId, sessionKey)) return false;
  return isAllowed(tenantId, ctx.tokenSubject, 'analytics', { visitor });
}
