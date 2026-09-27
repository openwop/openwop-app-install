/**
 * ADR 0027 — the public `/p/:slug` route matcher, extracted as a pure
 * zero-dependency function (the shareRoute / storeRoute precedent). The raw
 * segment may arrive percent-encoded (any link builder that runs a slug
 * through encodeURIComponent must still resolve), so the charset accepts `%`
 * and the decode is guarded; the DECODED value is then validated against the
 * strict CMS slug shape (lowercase alphanumeric + hyphens, no leading
 * hyphen), so this widens tolerated encodings, never what counts as a slug.
 * Anchored so it never over-matches a nested path.
 */

/** Returns the decoded CMS slug for a `/p/:slug` path, or null otherwise. */
export function matchPublicPageSlug(pathname: string): string | null {
  const m = pathname.match(/^\/p\/([A-Za-z0-9%-]+)$/);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]!);
  } catch {
    // Malformed percent-encoding (e.g. a stray `%`) — not a public-page link.
    return null;
  }
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}
