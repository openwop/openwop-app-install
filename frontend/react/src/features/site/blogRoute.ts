/**
 * ADR 0391 (a) — the public `/blog/*` route matcher, extracted as a pure
 * zero-dependency function (the `publicPageRoute` / `storeRoute` precedent) so it
 * is unit-testable and stays out of App.tsx's render body. Recognizes:
 *
 *   /blog                    → the post index
 *   /blog/tag/:tag           → a tag archive
 *   /blog/category/:cat      → a category archive
 *   /blog/author/:id         → an author archive
 *   /blog/:slug              → a single post
 *
 * Archive routes are matched BEFORE the bare-`:slug` post so a two-segment
 * `/blog/tag/x` never resolves as a post named "tag". Segments may arrive
 * percent-encoded (author ids contain `:`, e.g. `user:…`), so the charset accepts
 * `%`/`:` and the decode is guarded — malformed encoding is a non-match, never a
 * URIError. Anchored so a nested path never over-matches.
 */

export type BlogRoute =
  | { kind: 'index' }
  | { kind: 'tag'; value: string }
  | { kind: 'category'; value: string }
  | { kind: 'author'; value: string }
  | { kind: 'post'; slug: string };

/** Guarded percent-decode: returns null on malformed encoding. */
function decode(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** Returns the matched blog route for a `/blog…` path, or null otherwise. */
export function matchBlogRoute(pathname: string): BlogRoute | null {
  if (pathname === '/blog' || pathname === '/blog/') return { kind: 'index' };

  const facet = pathname.match(/^\/blog\/(tag|category|author)\/([A-Za-z0-9%:_-]+)\/?$/);
  if (facet) {
    const value = decode(facet[2]!);
    if (value === null) return null;
    const which = facet[1] as 'tag' | 'category' | 'author';
    return { kind: which, value };
  }

  const post = pathname.match(/^\/blog\/([A-Za-z0-9%-]+)\/?$/);
  if (post) {
    const slug = decode(post[1]!);
    // Same strict CMS slug shape as publicPageRoute (lowercase alnum + hyphens).
    if (slug !== null && /^[a-z0-9][a-z0-9-]*$/.test(slug)) return { kind: 'post', slug };
    return null;
  }

  return null;
}
