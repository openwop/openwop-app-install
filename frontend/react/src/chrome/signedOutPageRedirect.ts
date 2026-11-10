/**
 * Signed-out bare-path redirects (myndhyve.ai, 2026-11-07).
 *
 * The marketing site links bare paths like `/features` and `/compare`. Several
 * of them are ALSO real app routes, so a hosting-level 301 (how `/about`,
 * `/roadmap`, … forward to `/p/<slug>` in the distribution's firebase.json)
 * would take a signed-in user away from the app page they asked for. Hosting
 * cannot see a session; the SPA can. So the decision lives here:
 *
 *   - only on a deployment whose app shell is behind the SIGN-IN gate
 *     (`brand.appGate.mode === 'sign-in'`). On a gate-less deployment (the demo
 *     app) an anonymous visitor uses the app itself, and redirecting them would
 *     take the app page away from them;
 *   - only once auth has RESOLVED with no user. While it is resolving we wait,
 *     so a returning signed-in user is never bounced to the marketing page;
 *   - only when the host-site actually publishes a page with that slug. A
 *     deployment without one keeps the sign-in wall rather than trading it for a
 *     "page not found".
 *
 * The query and hash ride along, so a UTM-tagged ad link keeps its params.
 */

/** Bare paths that forward to `/p/<slug>` for a signed-out visitor. Each slug
 *  equals its path, so the map is just the set. */
export const SIGNED_OUT_PAGE_PATHS: readonly string[] = [
  'features',
  'agencies',
  'capabilities',
  'compare',
  'campaign-studio',
  'vulnerability-disclosure',
];

/** The `/p/` slug a bare path forwards to, or null. Exact match only (one
 *  trailing slash tolerated): `/features/x` and `/campaign-studio/plans/1` are
 *  app deep links and never redirect. */
export function signedOutPageSlug(pathname: string): string | null {
  const m = /^\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (!m) return null;
  return SIGNED_OUT_PAGE_PATHS.includes(m[1]!) ? m[1]! : null;
}

export type SignedOutRedirectDecision =
  /** Not a candidate: render whatever this path renders today. */
  | { kind: 'none' }
  /** A candidate, but auth is still resolving: hold (neutral splash). */
  | { kind: 'wait' }
  /** Signed out on a sign-in-gated deployment: check the page, then forward. */
  | { kind: 'check'; slug: string };

export function decideSignedOutRedirect(o: {
  pathname: string;
  gateMode: 'none' | 'password' | 'sign-in';
  hasUser: boolean;
  authLoading: boolean;
}): SignedOutRedirectDecision {
  if (o.gateMode !== 'sign-in' || o.hasUser) return { kind: 'none' };
  const slug = signedOutPageSlug(o.pathname);
  if (slug === null) return { kind: 'none' };
  if (o.authLoading) return { kind: 'wait' };
  return { kind: 'check', slug };
}

/** The address to forward to, keeping the visitor's query and hash. */
export function signedOutRedirectTarget(slug: string, search: string, hash: string): string {
  return `/p/${encodeURIComponent(slug)}${search}${hash}`;
}
