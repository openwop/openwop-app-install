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
 *
 * PageHeader exemption (DESIGN.md §5.5, UX AUTH-4): this surface intentionally
 * does NOT lead with <PageHeader>. It is a public marketing page rendered through
 * the CMS section system (hero/richText/cta/…), not a flat in-app index page — the
 * §5.5 "every top-level nav page leads with <PageHeader>" rule explicitly exempts
 * the public shell. The hero section carries the page's primary heading instead.
 */
import { Suspense, useEffect, useState } from 'react';
import i18n from '../../i18n/index.js';
import { brand } from '../../brand/brand.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { RenderSections } from '../cms/SectionRenderer.js';
import type { Section } from '../cms/cmsClient.js';
import { fetchPublicPage, type PublicPage } from './siteClient.js';
import { CatalogView, hasLargeCatalog } from './CatalogView.js';

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
 *
 * Built per call (not a module-level const) so its localized copy resolves against
 * the active UI locale at render time.
 */
function buildDefaultSections(): Section[] {
  return [
    { sectionId: 'd-hero', type: 'hero', data: {
      eyebrow: i18n.t('site:heroEyebrow'),
      heading: i18n.t('site:heroHeading'),
      subheading: i18n.t('site:heroSubheading'),
      ctaLabel: i18n.t('site:heroCtaLabel'), ctaUrl: '/chat',
      ctaLabel2: i18n.t('site:heroCtaLabel2'), ctaUrl2: 'https://openwop.dev',
    } },
    { sectionId: 'd-cols', type: 'columns', data: { eyebrow: i18n.t('site:columnsEyebrow'), heading: i18n.t('site:columnsHeading'), layout: 'steps', columns: [
      { title: i18n.t('site:columnBuildTitle'), text: i18n.t('site:columnBuildText') },
      { title: i18n.t('site:columnRunTitle'), text: i18n.t('site:columnRunText') },
      { title: i18n.t('site:columnControlTitle'), text: i18n.t('site:columnControlText') },
    ] } },
    { sectionId: 'd-intro', type: 'richText', data: {
      eyebrow: i18n.t('site:introEyebrow'), heading: i18n.t('site:introHeading'),
      text: i18n.t('site:introText'),
    } },
    { sectionId: 'd-cta', type: 'cta', data: { heading: i18n.t('site:ctaHeading'), label: i18n.t('site:ctaLabel'), url: '/chat' } },
  ];
}

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

  const sections = page && page.sections.length > 0 ? page.sections : buildDefaultSections();
  // A large catalog (the Features page: many card grids) gets a client-side
  // search field; ordinary pages — including the home page — render plainly.
  return (
    <div className="cms-public-page">
      <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}>
        {hasLargeCatalog(sections)
          ? <CatalogView sections={sections} />
          : <RenderSections sections={sections} mode="public" />}
      </Suspense>
    </div>
  );
}
