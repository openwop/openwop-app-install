/**
 * ADR 0027 / 0391 — client-side `<head>` SEO application for the public CMS
 * surfaces (front page, blog posts). The SPA doesn't otherwise manage `<head>`,
 * so each public page applies its merged SEO on mount and RESTORES the prior
 * title + meta tags on unmount — without this an anonymous visitor who signs in
 * and navigates into the app would carry a marketing page's og/meta tags.
 *
 * Extracted from FrontPage so the blog post view shares one implementation.
 */
import { brand } from '../../brand/brand.js';
import type { PublicPage } from './siteClient.js';

/**
 * UX_UPGRADE-podcasts P-G1 — head for a public page that SHOULD be indexed:
 * a real document title and a meta description. The deliberate counterpart to
 * {@link applyUnlistedHead}: a podcast show is meant to be found, a
 * capability-token page is not, and the two must not be confused. Returns an
 * undo that restores what it replaced.
 */
export function applyPublicHead(title: string, description?: string): () => void {
  if (typeof document === 'undefined') return () => {};
  const undos: Array<() => void> = [];
  const prevTitle = document.title;
  document.title = title;
  undos.push(() => { document.title = prevTitle; });
  if (description) {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    const prev = existing?.getAttribute('content') ?? null;
    const el = existing ?? document.createElement('meta');
    if (!existing) el.setAttribute('name', 'description');
    el.setAttribute('content', description);
    if (!existing) document.head.appendChild(el);
    undos.push(() => {
      if (!existing) el.remove();
      else if (prev === null) el.removeAttribute('content');
      else el.setAttribute('content', prev);
    });
  }
  return () => { for (const u of undos.reverse()) u(); };
}

/**
 * UX_UPGRADE-sharing SH-G3 — mark a CAPABILITY-TOKEN page as unindexable and
 * give it a real document title. These URLs (a share link, a signing link, a
 * booking-manage link) are authorized purely by POSSESSING an unguessable
 * token, so they must never reach a search index if one leaks — through a
 * referrer header, a pasted forum post, or a screenshot. The SPA owns its own
 * `<head>`, so this is the reliable place to say so, independent of how
 * robots.txt happens to be routed for a given deployment.
 *
 * Returns an undo that restores the prior title and the prior robots value, so
 * navigating on from the page never leaves the whole app marked noindex.
 */
export function applyUnlistedHead(title: string): () => void {
  if (typeof document === 'undefined') return () => {};
  const prevTitle = document.title;
  document.title = title;
  const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  const prev = existing?.getAttribute('content') ?? null;
  const el = existing ?? document.createElement('meta');
  if (!existing) el.setAttribute('name', 'robots');
  el.setAttribute('content', 'noindex,nofollow');
  if (!existing) document.head.appendChild(el);
  return () => {
    document.title = prevTitle;
    if (!existing) el.remove();
    else if (prev === null) el.removeAttribute('content');
    else el.setAttribute('content', prev);
  };
}

/**
 * Add a feed-autodiscovery `<link rel="alternate" type="application/rss+xml">`
 * to the head; returns an undo that removes it. Used by BOTH the blog index and
 * a single post — a post page is the URL readers actually land on and share, so
 * it must advertise the feed too (UX_UPGRADE-site G8).
 */
export function applyFeedAlternate(title: string, feedUrl: string): () => void {
  if (typeof document === 'undefined') return () => {};
  const link = document.createElement('link');
  link.setAttribute('rel', 'alternate');
  link.setAttribute('type', 'application/rss+xml');
  link.setAttribute('title', title);
  link.setAttribute('href', feedUrl);
  document.head.appendChild(link);
  return () => { link.remove(); };
}

/**
 * Apply the page's SEO to the document head and return an undo function that
 * restores the prior title + meta tags (removing any this call created).
 */
export function applySeo(page: PublicPage): () => void {
  if (typeof document === 'undefined') return () => {};
  const undos: Array<() => void> = [];
  const prevTitle = document.title;
  undos.push(() => { document.title = prevTitle; });

  /** Upsert a meta tag, recording how to undo it (restore prior content, or
   *  remove the element if this call created it). */
  const setMeta = (attr: 'name' | 'property', key: string, content: string): void => {
    const existing = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
    if (existing) {
      const prev = existing.getAttribute('content');
      undos.push(() => { if (prev === null) existing.removeAttribute('content'); else existing.setAttribute('content', prev); });
      existing.setAttribute('content', content);
    } else {
      const el = document.createElement('meta');
      el.setAttribute(attr, key);
      el.setAttribute('content', content);
      document.head.appendChild(el);
      undos.push(() => { el.remove(); });
    }
  };

  const s = page.seo;
  document.title = s.title || page.title || brand.productName;
  if (s.description) setMeta('name', 'description', s.description);
  setMeta('name', 'robots', s.noindex ? 'noindex,nofollow' : 'index,follow');
  setMeta('property', 'og:title', s.ogTitle || s.title || page.title);
  if (s.ogDescription || s.description) setMeta('property', 'og:description', s.ogDescription || s.description);
  if (s.ogImageUrl) setMeta('property', 'og:image', s.ogImageUrl);
  setMeta('property', 'og:type', 'website');

  // R2-G6 (SITE-R2-2): the payload's canonical URL was fetched and discarded —
  // an experiment/`?vk=` URL (or `/` vs `/p/home`) indexed without consolidation.
  // Upsert `<link rel="canonical">` + mirror it on `og:url`, undo like the metas.
  if (s.canonicalUrl) {
    const existing = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (existing) {
      const prev = existing.getAttribute('href');
      undos.push(() => { if (prev === null) existing.removeAttribute('href'); else existing.setAttribute('href', prev); });
      existing.setAttribute('href', s.canonicalUrl);
    } else {
      const el = document.createElement('link');
      el.setAttribute('rel', 'canonical');
      el.setAttribute('href', s.canonicalUrl);
      document.head.appendChild(el);
      undos.push(() => { el.remove(); });
    }
    setMeta('property', 'og:url', s.canonicalUrl);
  }

  return () => { for (const u of undos.reverse()) u(); };
}
