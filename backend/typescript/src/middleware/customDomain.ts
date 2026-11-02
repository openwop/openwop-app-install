/**
 * Custom-domain host guard (ADR 0295 / Funnel B, Phase 2) — requests arriving
 * on a LIVE custom hostname are pinned to that domain's org and constrained to
 * the PUBLIC surface, fail-closed:
 *
 *   - only org-bound public prefixes are reachable (published pages/funnels +
 *     the public storefront); the authed app, admin routes, and the protocol
 *     surface NEVER serve on a customer domain (cookie/session scope and OAuth
 *     origins stay on the platform origin — the PUBLIC_BASE_URL doctrine);
 *   - the `:orgId` in the path MUST equal the domain's bound org — a customer
 *     domain can never read another org's content (uniform 404);
 *   - hosts that match no live domain pass through untouched (the platform
 *     origin behaves byte-identically);
 *   - when the lookup itself FAILS, only a host that can never be a custom
 *     domain passes through; any other host gets 503 (ADR 0906 D8).
 *
 * Mounted before auth: the surface it admits is anonymous-public by design.
 */
import type { NextFunction, Request, Response } from 'express';
import { canonicalHost, isPlatformHost, resolveCustomHost } from '../host/customDomains.js';
import { ownerPublicRuntimeLapsed } from '../host/publicLapse.js';
import { sendError } from './errorEnvelope.js';
import { markBoundSite } from '../host/boundSite.js';
import { clientIp } from '../host/clientIp.js';
import { VERSION_RESPONSE_HEADER, vendorPath } from './protocolVersion.js';

/** ADR 1015 D5 — visitor-runtime write lanes, counted in their own per-domain
 *  bucket so a busy recorder cannot use up the page-load budget. */
const BEACON_PREFIXES = [
  `${vendorPath('/public-consent')}/`,
  `${vendorPath('/public-analytics')}/`,
];

/** Org-bound public prefixes servable on a custom domain. `public-forms` is
 *  deliberately absent in v1: its path carries no orgId to pin (recorded in
 *  ADR 0295).
 *
 *  Derived through `vendorPath` (the canonical RFC 0181 root), never written as
 *  literals (ADR 0654 / ADR 0812). */
const PUBLIC_ORG_PREFIXES = [
  `${vendorPath('/public')}/`,
  `${vendorPath('/public-store')}/`,
  // ADR 1015 D5 — the visitor runtime's same-origin calls: the consent lane and
  // the analytics beacons/capture. Both carry the org as the next segment, so the
  // org-equality check below pins them like the rest. Owner reads live under
  // `/analytics/orgs/…`, which stays unreachable here.
  ...BEACON_PREFIXES,
];

/** Decode one URL path segment; null on a malformed escape (→ not a document). */
function seg(raw: string | undefined): string | null {
  try { return decodeURIComponent(raw ?? ''); } catch { return null; }
}

/**
 * A custom-domain DOCUMENT path → the org-pinned prerender route it rewrites to
 * (ADR 0384 + 0390 + 0391). All targets live under the org's public prefix, so
 * the org-equality invariant holds by construction. Returns null when the path
 * is not a document request (falls through to the org-pin check → 404).
 *
 *   /                       → home page prerender
 *   /pricing                → the `pricing` page prerender
 *   /blog                   → the blog-INDEX prerender (a semantic post list)
 *   /blog/:slug             → the page prerender (blog posts ARE CMS pages)
 *   /p/:slug                → the page prerender
 *   /pod/:show              → the podcast SHOW prerender
 *   /pod/:show/:episode     → the podcast EPISODE prerender
 */
function documentRewrite(path: string, orgId: string): string | null {
  const base = `${vendorPath('/public')}/${encodeURIComponent(orgId)}`;
  const page = (slug: string): string => `${base}/prerender/${encodeURIComponent(slug)}`;

  if (path === '/') return page('home');
  if (path === '/pricing') return page('pricing');
  if (path === '/blog') return `${base}/blog/prerender`;

  let m = /^\/blog\/([^/]+)$/.exec(path);
  if (m) { const s = seg(m[1]); return s === null ? null : page(s); }

  m = /^\/p\/([^/]+)$/.exec(path);
  if (m) { const s = seg(m[1]); return s === null ? null : page(s); }

  m = /^\/pod\/([^/]+)$/.exec(path);
  if (m) { const s = seg(m[1]); return s === null ? null : `${base}/podcasts/${encodeURIComponent(s)}/prerender`; }

  m = /^\/pod\/([^/]+)\/([^/]+)$/.exec(path);
  if (m) {
    const show = seg(m[1]); const ep = seg(m[2]);
    return show === null || ep === null ? null : `${base}/podcasts/${encodeURIComponent(show)}/prerender/${encodeURIComponent(ep)}`;
  }
  return null;
}

/** Extract the `:orgId` segment right after a matched prefix. */
function orgFromPath(rawPath: string): string | null {
  // A missed prefix fails CLOSED (the custom domain 404s), never open.
  const path = rawPath;
  for (const prefix of PUBLIC_ORG_PREFIXES) {
    if (path.startsWith(prefix)) {
      const seg = path.slice(prefix.length).split('/', 1)[0] ?? '';
      try { return decodeURIComponent(seg); } catch { return seg; }
    }
  }
  return null;
}

// ── ADR 0295 P3 — per-domain fixed-window rate limits (a tenant's viral page
// must not starve the platform origin; the global per-IP limiter still applies).
//
// CORRECTED 2026-11-01 (ADR 1015 pilot): this used to be ONE bucket per host,
// charged by EVERY request, 404s included. One scanner (93.123.109.247, ~1,240
// probes for `.env`, `.git-credentials`, … in one minute right after a cert was
// issued) spent it, and real visitors got 429 on `/` for that minute: any
// customer domain could be taken offline by a single prober. Now:
//   - a request for a path the host does not serve (the guard's own 404) is
//     charged ONLY to a cheap per-IP "miss" bucket, so a prober throttles itself;
//   - a served request is charged to a per-(host, client IP) share first, and
//     only then to the host-wide ceiling, so one IP cannot spend the host's
//     budget and a distributed flood is still capped.
// The client IP is `host/clientIp.ts` (the trusted-proxy walk), never a raw
// X-Forwarded-For.
const WINDOW_MS = 60_000;
type Windows = Map<string, { windowStart: number; count: number }>;
/** Host-wide ceilings: bounded by the number of bound hosts. */
const hostWindows: Windows = new Map();
/** Per-IP shares and misses: clearing this map (a flood of distinct IPs) only
 *  resets the shares; the host ceilings above survive it. */
const ipWindows: Windows = new Map();

const envLimit = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
/** Host-wide ceiling for page/asset/store requests (unchanged default). */
const domainLimit = (): number => envLimit('OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN', 600);
/** One client IP's share of a host's page budget. */
const domainIpLimit = (): number => envLimit('OPENWOP_CUSTOM_DOMAIN_IP_REQS_PER_MIN', 120);
/** Host-wide ceiling for the visitor-runtime lanes (ADR 1015 D5). */
const beaconLimit = (): number => envLimit('OPENWOP_CUSTOM_DOMAIN_BEACON_REQS_PER_MIN', 1200);
/** One client IP's share of a host's beacon budget. */
const beaconIpLimit = (): number => envLimit('OPENWOP_CUSTOM_DOMAIN_BEACON_IP_REQS_PER_MIN', 240);
/** Paths no bound host serves, per client IP across all hosts. */
const missIpLimit = (): number => envLimit('OPENWOP_CUSTOM_DOMAIN_MISS_IP_REQS_PER_MIN', 60);

function over(windows: Windows, key: string, now: number, limit: number, bound: number): boolean {
  const w = windows.get(key);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    if (windows.size >= bound) windows.clear(); // bound the map
    windows.set(key, { windowStart: now, count: 1 });
    return 1 > limit;
  }
  w.count += 1;
  return w.count > limit;
}

/** Charge a served request: the IP's share first (a spent share is refused
 *  WITHOUT touching the host budget), then the host ceiling. */
function overServed(host: string, ip: string, beacon: boolean, now: number): boolean {
  const cls = beacon ? 'beacon' : 'page';
  if (over(ipWindows, `${cls}|${host}|${ip}`, now, beacon ? beaconIpLimit() : domainIpLimit(), 50_000)) return true;
  return over(hostWindows, `${cls}|${host}`, now, beacon ? beaconLimit() : domainLimit(), 10_000);
}

/** Test-only: forget every window. */
export function __resetCustomDomainRateLimitsForTests(): void { hostWindows.clear(); ipWindows.clear(); }

const isBeaconPath = (path: string): boolean => BEACON_PREFIXES.some((p) => path.startsWith(p));

/**
 * ADR 0940 F2 — white-label a response served on a bound customer hostname.
 *
 * The negotiator stamps `OpenWOP-Version` (and `Vary: OpenWOP-Version`) BEFORE
 * this guard runs. Nothing a customer host serves is a protocol response: it
 * serves published pages and the storefront only, and versioning §1.4 says a
 * non-protocol response MUST NOT carry the version. So remove both now, and
 * refuse any later attempt (the v2 hygiene wrapper, an error envelope,
 * `res.vary`) to set them again. `X-Powered-By` is disabled app-wide (F1).
 */
function whiteLabel(res: Response): void {
  const versionName = VERSION_RESPONSE_HEADER.toLowerCase();
  const withoutVersion = (value: number | string | readonly string[]): number | string | readonly string[] => {
    if (typeof value === 'number') return value;
    const tokens = (Array.isArray(value) ? value.join(',') : String(value)).split(',').map((t) => t.trim()).filter(Boolean);
    return tokens.filter((t) => t.toLowerCase() !== versionName).join(', ');
  };
  res.removeHeader(VERSION_RESPONSE_HEADER);
  // Vary is append-only in this host (test/vary-append-only.test.ts): rebuild it
  // through `res.vary()` from the tokens already declared, minus the version.
  const vary = res.getHeader('Vary');
  if (vary !== undefined) {
    const kept = String(withoutVersion(vary as string | readonly string[]));
    res.removeHeader('Vary');
    for (const token of kept.split(',').map((t) => t.trim()).filter(Boolean)) res.vary(token);
  }
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    const lower = name.toLowerCase();
    if (lower === versionName) return res;
    if (lower === 'vary') {
      const next = withoutVersion(value);
      return next === '' ? res : setHeader(name, next);
    }
    return setHeader(name, value);
  }) as Response['setHeader'];
}

export function customDomainMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const host = canonicalHost(req.headers.host ?? '');
    if (!host) { next(); return; }
    let bound: Awaited<ReturnType<typeof resolveCustomHost>>;
    try {
      bound = await resolveCustomHost(host);
    } catch {
      // ADR 0906 D8 — FAIL CLOSED. This used to pass every host through, so
      // during a store fault a customer hostname reached the full app surface
      // (sign-in, the authed API, the protocol). Only a host that can never be
      // a custom domain (the platform's own origins, `*.run.app`, localhost,
      // IP literals) keeps serving; anything else is told to retry.
      if (isPlatformHost(host)) { next(); return; }
      res.setHeader('Retry-After', '30');
      sendError(res, 503, 'service_unavailable', 'This site is temporarily unavailable. Try again shortly.');
      return;
    }
    try {
      if (!bound) { next(); return; } // not a custom domain — untouched
      whiteLabel(res);
      // ADR 1015 — record the bound site for the prerender (runtime injection).
      markBoundSite(res, { tenantId: bound.tenantId, orgId: bound.orgId });
      // Classify BEFORE charging: a path this host does not serve is the guard's
      // own 404 and is charged only to the client's miss bucket.
      const now = Date.now();
      const ip = clientIp(req);
      const isDocument = (req.method === 'GET' || req.method === 'HEAD') && documentRewrite(req.path, bound.orgId) !== null;
      const pathOrg = isDocument ? null : orgFromPath(req.path);
      if (!isDocument && (pathOrg === null || pathOrg !== bound.orgId)) {
        if (over(ipWindows, `miss|${ip}`, now, missIpLimit(), 50_000)) {
          sendError(res, 429, 'rate_limited', 'Too many requests. Try again shortly.');
          return;
        }
        sendError(res, 404, 'not_found', 'Not found.');
        return;
      }
      if (overServed(host, ip, !isDocument && isBeaconPath(req.path), now)) {
        // H27-b — `detail` was a NEW TOP-LEVEL key (`additionalProperties: false`
        // forbids it) carrying what is simply the envelope's `message`.
        sendError(res, 429, 'rate_limited', 'This site is receiving too many requests. Try again shortly.');
        return;
      }
      // ADR 0820 §7 (G9) — hosting a customer domain IS the custom-domains product, so the
      // OWNER's lapse past the public grace window stops serving on the bound host with the
      // same uniform 404 a wrong-org path gets. Off unless OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS
      // is set (then a synchronous env read only); when set, the verdict is cached per
      // (feature, tenant) for a minute, i.e. per bound host. A billing fault SERVES. The
      // `custom-domains` TOGGLE is deliberately not read here: serving never consulted it, and
      // adding it is a separate behaviour change.
      if (await ownerPublicRuntimeLapsed('custom-domains', bound.tenantId)) {
        sendError(res, 404, 'not_found', 'Not found.');
        return;
      }
      // ADR 0384/0390/0391 — DOCUMENT paths on a bound host (`/`, `/p/:slug`,
      // `/pricing`, `/blog[/:slug]`, `/pod/:show[/:episode]`, GET/HEAD only)
      // rewrite to the org's prerender routes: there is no SPA shell on a
      // customer hostname, so ALL clients (bots and humans) get the semantic
      // prerendered page — strictly better than the pre-0384 uniform 404. Every
      // rewrite target is inside the org-pinned public prefix, so the org
      // equality invariant below holds by construction.
      if (req.method === 'GET' || req.method === 'HEAD') {
        const target = documentRewrite(req.path, bound.orgId);
        if (target !== null) {
          req.url = target;
          next();
          return;
        }
      }
      const orgId = orgFromPath(req.path);
      if (orgId === null || orgId !== bound.orgId) {
        // fail-closed: wrong org, or any non-public path — uniform 404
        sendError(res, 404, 'not_found', 'Not found.');
        return;
      }
      next();
    } catch (err) {
      // The host IS a bound custom domain; a fault past the lookup (the lapse
      // read) must not open the app surface on it either.
      next(err);
    }
  };
}
