/**
 * Public CMS-driven front page (ADR 0027). Rendered at '/' for anonymous visitors
 * inside <PublicShell> (above <AppGate>). Fetches the configured site-org's
 * PUBLISHED home page via the public Publishing API and renders its typed
 * sections through the SHARED SectionRenderer (mode="public"). Falls back to
 * built-in marketing content when the site-org is unset, the page is
 * unpublished, or the API is unreachable — so the page is never blank.
 *
 * SEO is set client-side (title + meta/OG/canonical) from the page's merged SEO.
 * The server-side sitemap.xml / robots.txt / feed.rss come from Publishing.
 */
import { Suspense, useEffect, useState } from 'react';
import { brand } from '../../brand/brand.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { RenderSections } from '../cms/SectionRenderer.js';
import type { Section } from '../cms/cmsClient.js';
import { fetchPublicPage, type PublicPage } from './siteClient.js';

/**
 * Apply the page's SEO to the document head and return an undo function that
 * restores the prior title + meta tags (removing any this page created). The SPA
 * doesn't otherwise manage `<head>`, so without this an anonymous visitor who
 * signs in and navigates into the app would carry the front page's og/meta tags.
 */
function applySeo(page: PublicPage): () => void {
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

  return () => { for (const u of undos.reverse()) u(); };
}

/**
 * The PRE-BAKED default home page (ADR 0027 default-on) — a real, brand-aware
 * marketing page shown out of the box when no CMS page is configured. Authored in
 * the same typed-section model as a CMS page, so it renders identically and a
 * superadmin can later replace it by pointing the front page at a CMS `home` page.
 */
const DEFAULT_SECTIONS: Section[] = [
  { sectionId: 'd-hero', type: 'hero', data: {
    eyebrow: 'An open standard for AI agents & workflows',
    heading: 'AI coworkers that do real work — and stay yours.',
    subheading: 'Build AI agents and automated workflows that handle real tasks, then run them anywhere — because what you build is portable, not locked to one vendor.',
    ctaLabel: 'Try the live demo', ctaUrl: '/chat',
    ctaLabel2: 'See the open standard', ctaUrl2: 'https://openwop.dev',
  } },
  { sectionId: 'd-cols', type: 'columns', data: { eyebrow: 'How it works', heading: 'Build it. Run it. Stay in control.', layout: 'steps', columns: [
    { title: 'Build', text: 'Design an agent or a workflow on a visual canvas — or start from a ready-made template.' },
    { title: 'Run', text: 'Watch it work in real time. Every run is repeatable and reviewable.' },
    { title: 'Stay in control', text: 'You decide what runs on its own and what needs your sign-off — with your own keys for connected apps.' },
  ] } },
  { sectionId: 'd-intro', type: 'richText', data: {
    eyebrow: 'The open standard', heading: 'Build it once. Run it anywhere.',
    text: 'OpenWOP is an **open standard** — like email or the web — that any provider can support, so the agents and workflows you build aren’t locked to one vendor. Read the full standard at [openwop.dev](https://openwop.dev).',
  } },
  { sectionId: 'd-cta', type: 'cta', data: { heading: 'See it for yourself.', label: 'Open the live demo →', url: '/chat' } },
];

/** Title the document for the built-in default page (no CMS SEO to apply). */
function applyDefaultTitle(): () => void {
  if (typeof document === 'undefined') return () => {};
  const prev = document.title;
  document.title = brand.tagline ? `${brand.productName} — ${brand.tagline}` : brand.productName;
  return () => { document.title = prev; };
}

export function FrontPage({ orgId, slug }: { orgId: string; slug: string }): JSX.Element {
  const [page, setPage] = useState<PublicPage | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // No configured org ⇒ the built-in pre-baked page; skip the network call.
    if (!orgId) { setPage(null); setDone(true); return; }
    let live = true;
    let undoSeo: (() => void) | null = null;
    void fetchPublicPage(orgId, slug).then((p) => {
      if (!live) return;
      setPage(p);
      setDone(true);
      undoSeo = p ? applySeo(p) : applyDefaultTitle();
    });
    return () => { live = false; if (undoSeo) undoSeo(); };
  }, [orgId, slug]);

  // The built-in page also sets a sensible title.
  useEffect(() => {
    if (orgId) return; // handled in the fetch effect
    return applyDefaultTitle();
  }, [orgId]);

  if (!done) return <div className="u-p-4"><Skeleton /></div>;

  const sections = page && page.sections.length > 0 ? page.sections : DEFAULT_SECTIONS;
  return (
    <div className="cms-public-page">
      <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}>
        <RenderSections sections={sections} mode="public" />
      </Suspense>
    </div>
  );
}
