/**
 * ADR 0392 — the public `/docs` + `/docs/:slug` route matchers, pure
 * zero-dependency functions (the `publicPageRoute` / `storeRoute` precedent).
 * Anchored so they never over-match a nested path.
 */

/** True for exactly `/docs` (the docs index / nav tree). */
export function matchDocsIndex(pathname: string): boolean {
  return pathname === '/docs';
}

/** Returns the decoded docs-page slug for `/docs/:slug`, or null otherwise.
 *  The decoded value MUST match the strict CMS slug shape. */
export function matchDocsSlug(pathname: string): string | null {
  const m = pathname.match(/^\/docs\/([A-Za-z0-9%-]+)$/);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}
