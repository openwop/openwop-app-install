/**
 * ADR 0392 — the public `/docs` + `/docs/:slug` route matchers, pure
 * zero-dependency functions (the `publicPageRoute` / `storeRoute` precedent).
 * Anchored so they never over-match a nested path.
 */

/** True for `/docs` and `/docs/` (the docs index / nav tree). A trailing slash
 *  used to fall through to the signed-in app shell (grade-ux row 88, finding 2). */
export function matchDocsIndex(pathname: string): boolean {
  return pathname === '/docs' || pathname === '/docs/';
}

/** The `/docs/<rest>` remainder with ONE trailing slash dropped, or null. */
function docsRemainder(pathname: string): string | null {
  const m = pathname.match(/^\/docs\/(.+?)\/?$/);
  return m ? m[1]! : null;
}

/** Returns the docs-page slug for any `/docs/<rest>` path, or null otherwise.
 *  A strict CMS slug comes back as-is, with case folded and one trailing slash
 *  dropped (`/docs/Welcome/` is the `welcome` page). ANY other remainder (a
 *  nested path, a bad escape, a non-slug) still stays inside the docs tier: it
 *  comes back verbatim, and the page read answers not-found. Returning null here
 *  dropped an anonymous visitor into the signed-in app shell (grade-ux row 88,
 *  finding 2). */
export function matchDocsSlug(pathname: string): string | null {
  const raw = docsRemainder(pathname);
  if (raw === null) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(raw);
  } catch {
    return raw;
  }
  const folded = rest.toLowerCase();
  return /^[a-z0-9][a-z0-9-]*$/.test(folded) ? folded : rest;
}

/** ADR 1057 D1 (grade-ux N1) — the ONE canonical spelling of a docs URL, shared
 *  with the backend crawler door (`features/docs/routes.ts` `canonicalDocsPath`,
 *  same rule): `/docs/` → `/docs`, and a docs slug in another case or with a
 *  trailing slash → `/docs/<lowercase>`. Null when `pathname` is already canonical
 *  or is not a docs slug at all. Without this the SPA rendered `/docs/Welcome`
 *  while a crawler got 404 for it, and `/docs/welcome/` the other way round. */
export function canonicalDocsPath(pathname: string): string | null {
  if (pathname === '/docs/') return '/docs';
  const slug = matchDocsSlug(pathname);
  if (slug === null || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  const canonical = `/docs/${slug}`;
  return canonical === pathname ? null : canonical;
}
