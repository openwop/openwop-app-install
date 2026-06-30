/**
 * CORS middleware for cross-origin browser access.
 *
 * Default: reflect any Origin for NON-credentialed CORS (public reads).
 * Credentialed cross-origin access (the session cookie — required by the
 * cross-site SSE stream against the Cloud Run URL) is granted ONLY to
 * origins explicitly listed in OPENWOP_CORS_ORIGINS (comma-separated).
 * Reflect-any + `Allow-Credentials: true` is a credential-theft / CSRF hole
 * (any site could make credentialed requests with the user's cookie), so
 * `Allow-Credentials` is never emitted for the reflect-any default.
 *
 * Deployers running the SPA on a different origin than the backend (e.g.
 * app.openwop.dev → *.run.app for SSE) MUST set OPENWOP_CORS_ORIGINS to the
 * SPA origin(s), or the cross-site SSE stream gets no session.
 *
 * Preflight OPTIONS requests are handled before the auth middleware so
 * the browser's preflight succeeds even without credentials (per the
 * CORS spec — credentials only matter on the actual request).
 */

import type { RequestHandler } from 'express';

/** Returns the origin matcher + whether it is an EXPLICIT allowlist
 *  (explicit ⇒ credentialed CORS is allowed; reflect-any ⇒ it is not). */
function loadAllowedOrigins(): { match: (origin: string) => boolean; explicit: boolean } {
  const raw = process.env.OPENWOP_CORS_ORIGINS;
  if (!raw || raw === '*') return { match: () => true, explicit: false };
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return { match: (origin) => list.includes(origin), explicit: true };
}

/** PUB-1: the public embeddable-widget endpoints are NON-credentialed (the `wgt_` token is
 *  the capability; no cookie) and are MEANT to be embedded on any allowlisted customer
 *  domain. Their real gate is the per-widget server-side Origin allowlist + the token, NOT
 *  CORS — so they must reflect ANY origin for non-credentialed CORS even when the global
 *  OPENWOP_CORS_ORIGINS allowlist is set (which exists only to gate the CREDENTIALED cookie/
 *  SSE path these endpoints never use). Reflect-any WITHOUT `Allow-Credentials` grants a
 *  browser nothing it couldn't already fetch server-to-server. Scoped tightly to `/public/`. */
const PUBLIC_EMBED_PREFIX = '/v1/host/openwop-app/public/';

export function corsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const origin = req.header('origin');
    if (origin) {
      const { match, explicit } = loadAllowedOrigins();
      const isPublicEmbed = req.path.startsWith(PUBLIC_EMBED_PREFIX);
      // A public-embed path reflects any origin non-credentialed; otherwise the allowlist
      // (or the reflect-any default) decides, and credentials ride only an explicit allowlist.
      if (isPublicEmbed || match(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        // Credentials (the session cookie) cross-origin ONLY for an explicit allowlist AND
        // never on a public-embed path — reflect-any + credentials would let any site ride
        // the user's cookie. The cross-site SSE-with-cookie path needs OPENWOP_CORS_ORIGINS.
        if (explicit && !isPublicEmbed) res.set('Access-Control-Allow-Credentials', 'true');
        res.set(
          'Access-Control-Allow-Headers',
          'Authorization, Cache-Control, Content-Type, Idempotency-Key, Last-Event-ID, Traceparent, Tracestate',
        );
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.set('Access-Control-Expose-Headers', 'Capabilities-Etag');
        res.set('Access-Control-Max-Age', '600');
      }
    }
    if (req.method === 'OPTIONS') {
      res.status(204).send();
      return;
    }
    next();
  };
}
