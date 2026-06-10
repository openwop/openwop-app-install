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

export function corsMiddleware(): RequestHandler {
  return (req, res, next) => {
    const origin = req.header('origin');
    if (origin) {
      const { match, explicit } = loadAllowedOrigins();
      if (match(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        // Credentials (the session cookie) cross-origin ONLY for an explicit
        // allowlist — reflect-any + credentials would let any site ride the
        // user's cookie. The cross-site SSE-with-cookie path therefore needs
        // OPENWOP_CORS_ORIGINS to name the SPA origin.
        if (explicit) res.set('Access-Control-Allow-Credentials', 'true');
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
