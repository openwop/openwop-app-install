/**
 * ADR 0339 — the public `/fn/:orgId/:slug` funnel-viewer matcher, extracted
 * pure (the storeRoute precedent). Org ids contain `:` (`user:…`) and
 * app-generated links percent-encode, so both segments accept `%` with a
 * guarded decode — malformed encoding is a non-match, never a URIError.
 */

export function matchFunnelView(pathname: string): { orgId: string; slug: string } | null {
  const m = pathname.match(/^\/fn\/([A-Za-z0-9%:_-]+)\/([A-Za-z0-9%_-]+)$/);
  if (!m) return null;
  try {
    return { orgId: decodeURIComponent(m[1]!), slug: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}
