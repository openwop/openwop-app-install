/**
 * ADR 0390 — the public podcast page matcher, extracted pure (the storeRoute /
 * viewRoute precedent). Three shapes under `/pod/*`:
 *   /pod/:orgId                       → the org's published show index
 *   /pod/:orgId/:showSlug             → one published show + its episodes
 *   /pod/:orgId/:showSlug/:episodeSlug → one published episode
 * Org ids contain `:` (`user:…`) and app links percent-encode, so segments
 * accept `%` with a guarded decode — malformed encoding is a non-match, never a
 * URIError. Slugs are the lowercase-alphanumeric-hyphen shape the backend mints.
 */

export interface PodcastView {
  orgId: string;
  showSlug?: string;
  episodeSlug?: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function matchPodcastView(pathname: string): PodcastView | null {
  const m = pathname.match(/^\/pod\/([A-Za-z0-9%:_-]+)(?:\/([A-Za-z0-9%_-]+)(?:\/([A-Za-z0-9%_-]+))?)?$/);
  if (!m) return null;
  try {
    const orgId = decodeURIComponent(m[1]!);
    if (!orgId) return null;
    const view: PodcastView = { orgId };
    if (m[2] !== undefined) {
      const showSlug = decodeURIComponent(m[2]);
      if (!SLUG.test(showSlug)) return null;
      view.showSlug = showSlug;
    }
    if (m[3] !== undefined) {
      const episodeSlug = decodeURIComponent(m[3]);
      if (!SLUG.test(episodeSlug)) return null;
      view.episodeSlug = episodeSlug;
    }
    return view;
  } catch {
    return null;
  }
}
