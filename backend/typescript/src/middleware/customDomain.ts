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
 *     origin behaves byte-identically).
 *
 * Mounted before auth: the surface it admits is anonymous-public by design.
 */
import type { NextFunction, Request, Response } from 'express';
import { resolveCustomHost } from '../host/customDomains.js';
import { sendError } from './errorEnvelope.js';
import { vendorTwin } from './protocolVersion.js';

/** Org-bound public prefixes servable on a custom domain. `public-forms` is
 *  deliberately absent in v1: its path carries no orgId to pin (recorded in
 *  ADR 0295).
 *
 *  DERIVED through `vendorTwin` (ADR 0654), not written as literals. RFC 0181
 *  makes `/host/openwop-app/…` the canonical vendor root and `/v1/host/…` the
 *  twin that *"retires atomically with `/v1`"* (`versioning.md` §5). A hardcoded
 *  `/v1/…` here would pin custom-domain routing to a prefix scheduled for
 *  removal, and the December flip inverts the rewrite — so the literal would
 *  survive the flip pointing at a path that no longer resolves.
 *
 *  It also keeps the v1-reliance ratchet honest in the right direction: that
 *  check counts versioned-vendor-prefix LITERALS, so deriving removes counts
 *  rather than freezing them at a baseline. (Deliberately not spelling the
 *  prefix out here — a comment that quotes it is itself counted, which would
 *  make this file report reliance it does not have.) */
const PUBLIC_ORG_PREFIXES = [
  `${vendorTwin('/public')}/`,
  `${vendorTwin('/public-store')}/`,
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
  const base = `${vendorTwin('/public')}/${encodeURIComponent(orgId)}`;
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
function orgFromPath(path: string): string | null {
  for (const prefix of PUBLIC_ORG_PREFIXES) {
    if (path.startsWith(prefix)) {
      const seg = path.slice(prefix.length).split('/', 1)[0] ?? '';
      try { return decodeURIComponent(seg); } catch { return seg; }
    }
  }
  return null;
}

// ── ADR 0295 P3 — per-domain fixed-window rate limit (a tenant's viral page
// must not starve the platform origin; the per-IP bucket still applies too).
const WINDOW_MS = 60_000;
const domainWindows = new Map<string, { windowStart: number; count: number }>();
const domainLimit = (): number => {
  const raw = Number(process.env.OPENWOP_CUSTOM_DOMAIN_REQS_PER_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
};

function overDomainLimit(host: string, now: number): boolean {
  const w = domainWindows.get(host);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    domainWindows.set(host, { windowStart: now, count: 1 });
    if (domainWindows.size > 10_000) domainWindows.clear(); // bound the map
    return false;
  }
  w.count += 1;
  return w.count > domainLimit();
}

export function customDomainMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!host) { next(); return; }
      const bound = await resolveCustomHost(host);
      if (!bound) { next(); return; } // not a custom domain — untouched
      if (overDomainLimit(host, Date.now())) {
        // H27-b — `detail` was a NEW TOP-LEVEL key (`additionalProperties: false`
        // forbids it) carrying what is simply the envelope's `message`.
        sendError(res, 429, 'rate_limited', 'This site is receiving too many requests. Try again shortly.');
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
    } catch {
      // A resolution hiccup must never take the PLATFORM origin down —
      // pass through (custom-domain requests degrade to the normal gates).
      next();
    }
  };
}
