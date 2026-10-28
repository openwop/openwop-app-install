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
import { SPEC_REQUEST_HEADERS } from './corsRequestHeaders.generated.js';
import { sessionCookieIsCrossSite } from './cookieSession.js';

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

/** The request view `credentialedOriginAllowed` needs: an Express `req` and a
 *  raw WebSocket upgrade's `IncomingMessage` both fit. */
interface OriginRequest {
  headers: HeaderBag;
  /** A `TLSSocket` carries `encrypted: true`; a plain socket has no such field. */
  socket?: object | null;
}
type HeaderBag = Readonly<Record<string, string | string[] | undefined>>;

function firstHeader(headers: HeaderBag, name: string): string | undefined {
  const v = headers[name];
  const raw = Array.isArray(v) ? v[0] : v;
  const first = raw?.split(',')[0]?.trim();
  return first ? first : undefined;
}

/** The origins this request was addressed to: each host it names (the first
 *  `X-Forwarded-Host`, then `Host`) under the forwarded scheme (else the
 *  connection's own), plus `PUBLIC_BASE_URL`'s origin. */
function selfOrigins(req: OriginRequest): Set<string> {
  const out = new Set<string>();
  const tls = req.socket != null && 'encrypted' in req.socket && req.socket.encrypted === true;
  const scheme = (firstHeader(req.headers, 'x-forwarded-proto') ?? (tls ? 'https' : 'http')).toLowerCase();
  for (const host of [firstHeader(req.headers, 'x-forwarded-host'), firstHeader(req.headers, 'host')]) {
    if (!host) continue;
    try { out.add(new URL(`${scheme}://${host}`).origin); } catch { /* malformed host — not an origin */ }
  }
  const base = process.env.PUBLIC_BASE_URL;
  if (base) {
    try { out.add(new URL(base).origin); } catch { /* unset or malformed — nothing to add */ }
  }
  return out;
}

/**
 * ADR 0833 D4 — may a request from `origin` ride the session COOKIE? The ONE
 * answer for the CSRF guard and the collab socket's COOKIE lane (ticket lanes
 * carry their own credential), so they cannot drift apart.
 *
 *  - An explicit `OPENWOP_CORS_ORIGINS` allowlist decides (unchanged).
 *  - No allowlist and a cross-site cookie (`SameSite=None`, i.e. production):
 *    SAME-ORIGIN ONLY — the full origin (scheme + host + port) must be one this
 *    request was addressed to. This used to be reflect-any, because the guard
 *    assumed "no allowlist ⇒ dev ⇒ Lax"; the cookie's posture is read from a
 *    different env var, so a production install that never set the allowlist
 *    accepted cross-site form POSTs carrying the victim's cookie (S4). A
 *    browser cannot set the forwarded headers cross-site, and a non-browser
 *    client that can is not the ambient-cookie threat.
 *  - No allowlist and a `Lax` cookie (dev): any origin, as before — the
 *    browser itself withholds the cookie cross-site.
 *
 * `Origin: null` (sandboxed frames, some redirects) never matches. An ABSENT
 * Origin is the caller's decision: the CSRF guard treats it as same-origin,
 * the WebSocket lanes keep `originPolicy`'s answer.
 */
export function credentialedOriginAllowed(origin: string, req: OriginRequest): boolean {
  const { match, explicit } = loadAllowedOrigins();
  if (explicit) return match(origin);
  if (!sessionCookieIsCrossSite()) return true;
  if (origin === 'null') return false;
  let normalized: string;
  try { normalized = new URL(origin).origin; } catch { return false; }
  return selfOrigins(req).has(normalized);
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
export const PUBLIC_EMBED_PREFIX = '/host/openwop-app/public/';

/**
 * The HOST half of the preflight allow-list: headers no served OpenAPI declares
 * (the spec half is generated — see `ALLOWED_REQUEST_HEADERS` below).
 *
 * The `X-OpenWOP-*` entries are CUSTOM headers this app's SPA sends; each one
 * makes its request preflighted, so an omission here blocks the request in the
 * browser with no server-side trace. Adding a custom header to the SPA without
 * adding it here is the defect `cors-field-contract-header.test.ts` guards.
 */
export const HOST_REQUEST_HEADERS: readonly string[] = [
  // Named by `cors-preflight-admits` itself, beside the operation's declared headers.
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Idempotency-Key',
  // ADR 0770 D5 — the builder's save precondition. Not CORS-safelisted, so
  // without this every cross-origin builder autosave fails its preflight (the
  // 2026-08-06 field-contract outage, one header over).
  'If-Match',
  'Last-Event-ID',
  'Traceparent',
  'Tracestate',
  'X-OpenWOP-Field-Contract',
  // ADR 0789 — the builder's "this canvas is unchanged since load" marker, so a
  // Run of an untouched SEEDED workflow does not fork it.
  'X-OpenWOP-Canvas-Pristine',
  // ADR 0860 D3 — a public visitor's consent-lane token on the page read and the
  // funnel routes (a GET cannot carry it in a body, and a query lands in logs).
  'X-OpenWOP-Consent-Token',
  // ADR 0948 P2c — a funnel buyer's post-purchase offer capability (order + token)
  // on the public `next` route: same reason, a GET with no body and no URL leak.
  'X-OpenWOP-Funnel-Order',
  'X-OpenWOP-Funnel-Offer',
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
  // `OpenWOP-Client-Version` (RFC 0219): SDK ≥ 2.5.0 sends the corpus version it
  // was built against on EVERY request, SSE subscribes included. Added BEFORE the
  // SPA takes 2.5.0, because the day it did, every cross-origin v2 request (the
  // *.run.app SSE bypass especially) would have failed preflight. That is the
  // 2026-09-18 outage above, a third time. (Corpus steward's warning, 2026-09-28.)
  'OpenWOP-Client-Version',
  // `OpenWOP-Dedup`: the SDK sets it whenever a caller passes `dedup` to a
  // mutation (client.js). The SPA passes none today, so this was latent. The
  // SDK-dist generator in the test found it on its first run.
  'OpenWOP-Dedup',
];

/**
 * Request headers admitted through a CORS preflight: the host half above plus
 * EVERY header the served OpenAPI documents declare on any operation
 * (`corsRequestHeaders.generated.ts`, from the pinned `@openwop/spec-artifacts`).
 *
 * `openwop.requirement.headers.cors-preflight-admits` (openwop#1763): a granted
 * preflight MUST admit each operation's declared request headers. The hand list
 * missed two the spec declares — `If-None-Match` (getCapabilities) and
 * `OpenWOP-Force-Engine-Version` (createRun) — because it tracked what the SDK
 * sends, not what the spec declares. A generated half cannot lag the pin.
 *
 * Never reflect `Access-Control-Request-Headers` instead: that admits any header
 * a hostile origin asks for, and this list is the point.
 */
export const ALLOWED_REQUEST_HEADERS: readonly string[] = (() => {
  const seen = new Set<string>();
  return [...HOST_REQUEST_HEADERS, ...SPEC_REQUEST_HEADERS].filter((h) => {
    const k = h.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
})();

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
        res.vary('Origin');
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
        res.set('Access-Control-Expose-Headers', 'ETag, Content-Disposition'); // ADR 0992 D9 — the export download's name
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
