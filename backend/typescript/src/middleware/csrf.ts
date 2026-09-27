/**
 * CSRF Origin guard (2026-07 vuln-scan M4).
 *
 * The session cookie is `SameSite=None` in production (required so the cross-site
 * SSE stream to the direct `*.run.app` URL carries the session), which removes
 * SameSite's own CSRF protection. CORS does NOT stop a cross-site SIMPLE-request
 * POST from being PROCESSED (it only governs whether the attacker's JS can READ the
 * response) — so a cross-site form POST to a cookie-authed no-body/param-only
 * mutation (e.g. forced logout) was forgeable.
 *
 * This restores CSRF protection by validating the request Origin for COOKIE-authed
 * unsafe methods against the SAME allowlist the credentialed-CORS path uses
 * (`cors.ts originPolicy`) — one source, so the two boundaries can't drift.
 *
 * Scope (why each gate):
 *  - SAFE methods (GET/HEAD/OPTIONS) never mutate → skipped.
 *  - Bearer/apiKey callers are NOT CSRF-able (an attacker can't set the
 *    Authorization header cross-site), so only requests carrying the session
 *    COOKIE are guarded — this also naturally exempts cookieless provider webhooks.
 *  - PUBLIC paths (widget/message, public-forms/submit, public-consent,
 *    public-analytics/collect, …) are UNAUTHENTICATED and MEANT to be POSTed
 *    cross-origin from customer domains (their own per-widget `allowedDomains` is
 *    the control), so they are exempt — a stray session cookie must not 403 them.
 *  - Absent Origin → allow: browsers attach Origin to every cross-site unsafe
 *    request, so "absent" means a non-browser client (not the ambient-cookie
 *    threat). Referer's origin is a fallback only; both absent → allow (never
 *    hard-require Referer — privacy settings strip it and would false-403 users).
 *
 * In dev (no `OPENWOP_CORS_ORIGINS`, reflect-any, cookie is `SameSite=Lax`) the
 * allowlist admits every origin, so this is a no-op — matching the cookie posture.
 */
import type { RequestHandler } from 'express';
import { OpenwopError } from '../types.js';
import { originPolicy } from './cors.js';
import { isPublicPath } from './auth.js';
import { COOKIE_NAME, readCookie } from './cookieSession.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Extract the scheme://host[:port] origin from a Referer URL, or undefined. */
function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export function csrfOriginGuard(): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    // Cross-origin-by-design public surfaces (embed/forms/consent/analytics/webhooks).
    if (isPublicPath(req.path)) return next();
    // Only the ambient session COOKIE is CSRF-able; bearer/apiKey callers are not.
    const hasSessionCookie = readCookie(req.header('cookie'), COOKIE_NAME) !== undefined;
    if (!hasSessionCookie) return next();
    const origin = req.header('origin') || refererOrigin(req.header('referer'));
    if (!origin) return next(); // same-origin / non-browser client
    if (!originPolicy().allowed(origin)) {
      next(new OpenwopError('forbidden', 'Cross-site request blocked (origin not allowed).', 403, { code: 'csrf_origin_rejected' }));
      return;
    }
    next();
  };
}
