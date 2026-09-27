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
import { ACT_AS_HEADER } from '../host/accessControlService.js';
import { VERSION_RESPONSE_HEADER } from './protocolVersion.js';

/** Returns the origin matcher + whether it is an EXPLICIT allowlist
 *  (explicit ⇒ credentialed CORS is allowed; reflect-any ⇒ it is not). */
function loadAllowedOrigins(): { match: (origin: string) => boolean; explicit: boolean } {
  const raw = process.env.OPENWOP_CORS_ORIGINS;
  if (!raw || raw === '*') return { match: () => true, explicit: false };
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return { match: (origin) => list.includes(origin), explicit: true };
}

/**
 * The ONE origin policy, reused by the collaboration WebSocket upgrade (ADR 0335)
 * so its CSWSH defense can't drift from the HTTP CORS allowlist. Returns true when
 * the origin is permitted: an explicit `OPENWOP_CORS_ORIGINS` allowlist match, or
 * reflect-any when no allowlist is set (dev). `explicit` reports whether an
 * allowlist is in force — a WS carrying the session cookie SHOULD require an
 * explicit allowlist in production (reflect-any is a dev-only posture).
 */
export function originPolicy(): { allowed: (origin: string | undefined) => boolean; explicit: boolean } {
  const { match, explicit } = loadAllowedOrigins();
  return { allowed: (origin) => (origin ? match(origin) : !explicit), explicit };
}

/** PUB-1: the public embeddable-widget endpoints are NON-credentialed (the `wgt_` token is
 *  the capability; no cookie) and are MEANT to be embedded on any allowlisted customer
 *  domain. Their real gate is the per-widget server-side Origin allowlist + the token, NOT
 *  CORS — so they must reflect ANY origin for non-credentialed CORS even when the global
 *  OPENWOP_CORS_ORIGINS allowlist is set (which exists only to gate the CREDENTIALED cookie/
 *  SSE path these endpoints never use). Reflect-any WITHOUT `Allow-Credentials` grants a
 *  browser nothing it couldn't already fetch server-to-server. Scoped tightly to `/public/`.
 *
 *  Exported so a route under this prefix DERIVES its path instead of re-declaring the
 *  literal (the public challenge catalog does): a derived caller moves with the constant
 *  when the vendor path namespace changes (ADR 0652); a re-declared one does not. */
export const PUBLIC_EMBED_PREFIX = '/v1/host/openwop-app/public/';

/**
 * Request headers admitted through a CORS preflight.
 *
 * The `X-OpenWOP-*` entries are CUSTOM headers this app's SPA sends; each one
 * makes its request preflighted, so an omission here blocks the request in the
 * browser with no server-side trace. Adding a custom header to the SPA without
 * adding it here is the defect `cors-field-contract-header.test.ts` guards.
 */
export const ALLOWED_REQUEST_HEADERS: readonly string[] = [
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Idempotency-Key',
  'Last-Event-ID',
  'Traceparent',
  'Tracestate',
  'X-OpenWOP-Field-Contract',
  // Derived, not retyped: if `ACT_AS_HEADER` is ever renamed, the allow-list
  // follows automatically. A literal here would silently stop admitting the
  // header the readers actually check — the same drift, one layer over.
  ACT_AS_HEADER,
  // `OpenWOP-Version` — THE PROTOCOL NEGOTIATION HEADER, and its omission was a
  // live cross-origin outage, not a theoretical one.
  //
  // MEASURED 2026-09-18: with the SPA's discovery read moved to major 2
  // (ADR 0730 C.3), the preflight refused `openwop-version`, the browser
  // blocked the request, `getCapabilities()` threw, and
  // `InMemoryHostBanner`'s `catch` — which exists to keep network noise off
  // the screen — swallowed it. The banner silently stopped rendering, which
  // reddened nine e2e tests across three specs with no server-side trace.
  // Every cross-origin v2 request was affected, not just discovery.
  //
  // The parity test this list advertises could not catch it: it walks the SPA
  // for `x-openwop-*` sends, and this header matches no such pattern. A guard
  // shaped around one prefix is blind to the one header that is not prefixed.
  VERSION_RESPONSE_HEADER,
];

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
        // EVERY custom request header the SPA sends must be listed here. A
        // custom header makes the request PREFLIGHTED, and a header missing from
        // this list is blocked by the browser BEFORE it reaches the server:
        // `net::ERR_FAILED`, no 4xx, no log, nothing to debug from.
        //
        // That happened: `X-OpenWOP-Field-Contract` (ADR 0524 Phase E0) was
        // omitted and EVERY cross-origin builder save was silently lost.
        // Auditing for a repeat found a SECOND one already shipped —
        // `X-OpenWOP-Act-As` (`client/accessClient.ts:107`, org "view as"), read
        // by five backend routes and never admitted here.
        //
        // The list is derived from a NAMED constant so the set is greppable and
        // testable rather than a literal nobody can enumerate; a parity test
        // walks the SPA source for `x-openwop-*` sends and fails when one is not
        // covered. Same-origin deploys (the Firebase `/api` rewrite) never
        // preflight, which is exactly why this class hides.
        res.set('Access-Control-Allow-Headers', ALLOWED_REQUEST_HEADERS.join(', '));
        res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.set('Access-Control-Expose-Headers', 'Capabilities-Etag, ETag');
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
