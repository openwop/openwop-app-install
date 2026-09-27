/**
 * ADR 0391 (a) — the public blog-archive client. Reads the site-org's PUBLISHED
 * posts through the EXISTING unauthenticated public tier (ADR 0012):
 *   GET /host/openwop-app/public/:orgId/blog?tag=&category=&author=
 * No auth headers, no credentials — the surface is published-only by definition
 * (drafts never appear). Mirrors the backend list projection: a post is a `cms`
 * page with `kind:'post'` (ADR 0391 §a), so the projection carries only
 * discovery-safe facets (never draft section bodies).
 *
 * The blog-scoped RSS lives at `/public/:orgId/blog/feed.xml` (a server-rendered
 * variant of `feedRss`); `blogFeedUrl` builds the absolute URL the `<link
 * rel="alternate">` head tag and the "Subscribe" affordance point at.
 */
import { config } from '../../client/config.js';
import { getRequestLocale } from '../../i18n/requestLocale.js';

/** One post in the public blog list projection (never a draft, never a body). */
export interface BlogPost {
  pageId: string;
  slug: string;
  title: string;
  authorId?: string;
  authorName?: string;
  category?: string;
  tags?: string[];
  excerpt?: string;
  publishedAt?: string;
  /** Whole minutes to read the post, floored at 1 (server-computed from the
   *  published body, so the estimate can't drift from what's rendered). */
  readingMinutes?: number;
  /** The post's OG image token, reused as the card cover; absent when the
   *  author set no social image (the card then renders text-only). */
  coverImageToken?: string;
}

/** A single archive filter — at most one of tag/category/author is set. */
export interface BlogFilter {
  tag?: string;
  category?: string;
  author?: string;
}

/**
 * Fetch the site-org's published posts, optionally narrowed to one archive
 * facet. Returns `null` on any failure (unconfigured org / unreachable / non-2xx)
 * so callers render a designed error/empty state — the archive is never blank
 * from an unhandled throw.
 */
export async function fetchBlog(orgId: string, filter: BlogFilter = {}): Promise<BlogPost[] | null> {
  if (!orgId) return null;
  try {
    const qs = new URLSearchParams();
    if (filter.tag) qs.set('tag', filter.tag);
    if (filter.category) qs.set('category', filter.category);
    if (filter.author) qs.set('author', filter.author);
    const query = qs.toString();
    const url = `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/blog${query ? `?${query}` : ''}`;
    // Public: no auth/credentials — but forward the content-locale preference:
    // the server localizes excerpts + reading estimates through the same
    // RFC 0103 negotiation as the page view (R2-BLOG-3). Titles stay base-locale
    // BY DESIGN — `localizePage` never localizes the title field anywhere, so
    // cards and post pages agree. (Accept-Language is CORS-safelisted.)
    const requestLocale = getRequestLocale();
    const res = await fetch(url, requestLocale ? { headers: { 'accept-language': requestLocale } } : undefined);
    if (!res.ok) return null;
    const body = (await res.json()) as { posts?: BlogPost[] };
    return Array.isArray(body.posts) ? body.posts : [];
  } catch {
    return null;
  }
}

/** Absolute URL of the site-org's blog RSS feed (the `<link rel="alternate">`). */
export function blogFeedUrl(orgId: string): string {
  return `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/blog/feed.xml`;
}
