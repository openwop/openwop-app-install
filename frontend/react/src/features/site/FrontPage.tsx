/**
 * Public CMS-driven front page (ADR 0027). Rendered at '/' for anonymous visitors
 * inside <PublicShell> (above <AppGate>). Fetches the configured site-org's
 * PUBLISHED home page via the public Publishing API and renders its typed
 * sections through the SHARED SectionRenderer (mode="public").
 *
 * TWO surfaces, TWO failure postures (UX_UPGRADE-site R2-G1):
 * - `surface="root"` ('/'): falls back to the built-in marketing page whenever
 *   the configured page can't be shown — unset org, unpublished, or the API is
 *   unreachable. The front page is never blank (ADR 0027).
 * - `surface="slug"` ('/p/:slug'): an HONEST deep link. A 404 renders a designed
 *   "page not found" state and a failed read renders a designed error state with
 *   a retry — never the home page under the wrong URL (a soft-404 wrong claim).
 *
 * SEO is set client-side (title + meta/OG/canonical — R2-G6) from the page's
 * merged SEO; bots additionally get the ADR 0384 prerender (JSON-LD) server-side.
 *
 * PageHeader exemption (DESIGN.md §5.5, UX AUTH-4): this surface intentionally
 * does NOT lead with <PageHeader>. It is a public marketing page rendered through
 * the CMS section system (hero/richText/cta/…), not a flat in-app index page — the
 * §5.5 "every top-level nav page leads with <PageHeader>" rule explicitly exempts
 * the public shell. The hero section carries the page's primary heading instead.
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import i18n from '../../i18n/index.js';
import { brand } from '../../brand/brand.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useDemoMode } from '../../client/useDemoMode.js';
import { RenderSections } from '../cms/SectionRenderer.js';
import type { Section } from '../cms/cmsClient.js';
import { fetchPublicPageResult, type PublicPage } from './siteClient.js';
import { applySeo } from './siteSeo.js';
import { getVisitorKey, sendExperimentPageview } from './visitorBeacon.js';
import { reportWebVitals } from './webVitalsBeacon.js';
import { CatalogView, hasLargeCatalog } from './CatalogView.js';
import { EditThisPageLink } from './EditThisPageLink.js';
import { OpenAppLink } from './OpenAppLink.js';
import { PublicHeaderActions, PublicMenuActions } from '../../chrome/PublicShell.js';

/**
 * The PRE-BAKED default home page (ADR 0027 default-on) — a real, brand-aware
 * marketing page shown out of the box when no CMS page is configured. Authored in
 * the same typed-section model as a CMS page, so it renders identically and a
 * superadmin can later replace it by pointing the front page at a CMS `home` page.
 *
 * It tells one story, in order: the run is where AI work now happens (hero +
 * the run ledger) → why that matters → what history says about standardizing
 * it → what an open run guarantees → the evidence → what you can do here today.
 * The operator-publishable CMS twin lives at docs/site/front-page-story.sections.json.
 *
 * Built per call (not a module-level const) so its localized copy resolves against
 * the active UI locale at render time. Links to openwop.dev and the paper are
 * OpenWOP-showcase chrome, so they are DEMO-GATED like the PublicShell chips
 * (ADR 0196 Gate A: a white-label install's fallback page must not send its
 * visitors to openwop.dev).
 */
/** Where the default page's primary calls to action send a visitor — the hero
 *  button and the closing CTA share it, so repointing the page is one edit. */
const PRIMARY_CTA_URL = '/chat';

function buildDefaultSections(demo: boolean): Section[] {
  return [
    { sectionId: 'd-hero', type: 'hero', data: {
      visual: 'run',
      heading: i18n.t('site:heroHeading'),
      subheading: i18n.t('site:heroSubheading'),
      ctaLabel: i18n.t('site:heroCtaLabel'), ctaUrl: PRIMARY_CTA_URL,
      ...(demo ? { ctaLabel2: i18n.t('site:heroCtaLabel2'), ctaUrl2: 'https://openwop.dev' } : {}),
    } },
    { sectionId: 'd-shift', type: 'richText', data: { heading: i18n.t('site:shiftHeading'), text: i18n.t('site:shiftText') } },
    { sectionId: 'd-history', type: 'richText', data: { heading: i18n.t('site:historyHeading'), text: i18n.t('site:historyText') } },
    { sectionId: 'd-open', type: 'columns', data: { heading: i18n.t('site:openHeading'), layout: 'rows', columns: [
      { title: i18n.t('site:openLeaveTitle'), text: i18n.t('site:openLeaveText') },
      { title: i18n.t('site:openSeeTitle'), text: i18n.t('site:openSeeText') },
      { title: i18n.t('site:openDecideTitle'), text: i18n.t('site:openDecideText') },
      { title: i18n.t('site:openBoundTitle'), text: i18n.t('site:openBoundText') },
      { title: i18n.t('site:openReplayTitle'), text: i18n.t('site:openReplayText') },
    ] } },
    { sectionId: 'd-proof', type: 'richText', data: {
      heading: i18n.t('site:proofHeading'),
      text: demo ? `${i18n.t('site:proofText')}\n\n${i18n.t('site:proofPaperLink')}` : i18n.t('site:proofText'),
    } },
    { sectionId: 'd-try', type: 'columns', data: { heading: i18n.t('site:tryHeading'), layout: 'steps', columns: [
      { title: i18n.t('site:tryBuildTitle'), text: i18n.t('site:tryBuildText') },
      { title: i18n.t('site:tryRunTitle'), text: i18n.t('site:tryRunText') },
      { title: i18n.t('site:tryDecideTitle'), text: i18n.t('site:tryDecideText') },
      { title: i18n.t('site:tryReplayTitle'), text: i18n.t('site:tryReplayText') },
    ] } },
    { sectionId: 'd-cta', type: 'cta', data: { heading: i18n.t('site:ctaHeading'), subheading: i18n.t('site:ctaSubheading'), label: i18n.t('site:ctaLabel'), url: PRIMARY_CTA_URL } },
  ];
}

/** Title + describe the document for the built-in default page (no CMS SEO to
 *  apply). SITE-R2-7: the localized hero subheading doubles as the meta
 *  description — a fresh install's '/' used to get an auto-generated search
 *  snippet despite marketing copy sitting right there. */
function applyDefaultTitle(): () => void {
  if (typeof document === 'undefined') return () => {};
  const prev = document.title;
  document.title = brand.tagline ? `${brand.productName} — ${brand.tagline}` : brand.productName;
  const undos: Array<() => void> = [() => { document.title = prev; }];
  const desc = i18n.t('site:heroSubheading');
  if (desc) {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (existing) {
      const prevDesc = existing.getAttribute('content');
      undos.push(() => { if (prevDesc === null) existing.removeAttribute('content'); else existing.setAttribute('content', prevDesc); });
      existing.setAttribute('content', desc);
    } else {
      const el = document.createElement('meta');
      el.setAttribute('name', 'description');
      el.setAttribute('content', desc);
      document.head.appendChild(el);
      undos.push(() => { el.remove(); });
    }
  }
  return () => { for (const u of undos.reverse()) u(); };
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'page'; page: PublicPage }
  /** Root only — render the pre-baked default (absent OR failed; never blank). */
  | { kind: 'default' }
  /** Slug only — the server said nothing is published here. */
  | { kind: 'notFound' }
  /** Slug only — the read failed; we don't know what's published. */
  | { kind: 'error' };

/** Where a slug-surface embed lives (UX_UPGRADE-docs R2-D1/D2). The docs shell
 *  passes `basePath: '/docs/'` + a "Back to docs" fallback so a renamed slug
 *  canonicalizes WITHIN docs and the 404/empty states never eject the reader
 *  to the marketing home. Default = the standalone `/p/` surface.
 *
 *  `isKnownSlug` (R2-D4, the collection guard) is consulted AFTER the fetch
 *  resolves and AFTER redirect canonicalization — so a renamed doc still
 *  redirects (its NEW slug passes the check), and only a page that exists but
 *  does not belong to the embedding surface renders the not-found state. The
 *  predicate must FAIL OPEN (return true) while its source list is loading. */
export interface SlugEmbed { basePath: string; fallbackTo: string; fallbackLabel: string; isKnownSlug?: (slug: string) => boolean }

export function FrontPage({ orgId, slug, surface, embed }: { orgId: string; slug: string; surface: 'root' | 'slug'; embed?: SlugEmbed }): JSX.Element {
  const { t } = useTranslation('site');
  const navigate = useNavigate();
  const location = useLocation();
  const demo = useDemoMode();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Latest-ref so the canonicalizing navigate reads the CURRENT query/hash
  // without making them fetch-effect deps (a hash change must not refetch).
  const locRef = useRef(location);
  locRef.current = location;
  // Same for the embed config: a per-render object literal must not refire the
  // fetch, and the navigate reads whatever is current.
  const embedRef = useRef(embed);
  embedRef.current = embed;

  useEffect(() => {
    // No configured org ⇒ the built-in pre-baked page; skip the network call.
    // (Only the root surface renders without an org — /p/:slug always has one.)
    if (!orgId) { setState({ kind: 'default' }); return; }
    let live = true;
    let undoSeo: (() => void) | null = null;
    setState({ kind: 'loading' });
    // ADR 0236 (D1): send the anonymous visitor key so a RUNNING page
    // experiment can assign a variant (consent enforced server-side — no
    // consent/key ⇒ the plain published page, byte-identical to before).
    const vk = getVisitorKey();
    void fetchPublicPageResult(orgId, slug, vk).then((r) => {
      if (!live) return;
      if (r.status === 'ok') {
        // A renamed slug answers with the page's CURRENT slug — canonicalize the
        // address bar so the visitor keeps (and shares) the live URL. Root stays
        // put: '/' is already the canonical address of the home page.
        if (surface === 'slug' && r.page.slug && r.page.slug !== slug) {
          // Keep the query + hash: a renamed-slug hit from an ad must not shed
          // its UTM params mid-canonicalization (review R2-4). The base path is
          // the EMBEDDING surface's (R2-D1): a renamed doc canonicalizes to
          // /docs/new-slug, never ejecting the reader to /p/.
          navigate(`${embedRef.current?.basePath ?? '/p/'}${encodeURIComponent(r.page.slug)}${locRef.current.search}${locRef.current.hash}`, { replace: true });
          return;
        }
        setState({ kind: 'page', page: r.page });
        // R2R-2 — when the embed's guard rejects this page at resolve time,
        // skip SEO + beacons: a guard-blocked "Page not found" must not carry
        // the real page's canonical/OG meta, and an experiment must not record
        // an exposure for a body the reader never saw (ADR 0236 attribution).
        // Conservative direction: a guard list that arrives LATE misses one
        // exposure rather than fabricating one.
        const rejected = surface === 'slug' && Boolean(embedRef.current?.isKnownSlug) && !embedRef.current!.isKnownSlug!(r.page.slug);
        if (rejected) return;
        undoSeo = applySeo(r.page);
        // Assigned a variant ⇒ stamp ONE pageview on the beacon so the results
        // projection can attribute this exposure. No experiment ⇒ no beacon.
        if (r.page.experiment && vk) sendExperimentPageview(orgId, vk, r.page.experiment);
        // ADR 0018 CWV fold-in — report real-user Core Web Vitals for this public
        // page (consent enforced server-side at the beacon, like the pageview).
        if (vk) reportWebVitals(orgId, vk);
        return;
      }
      if (surface === 'root') {
        // ADR 0027 — the front page is never blank: absent AND failed both fall
        // back to the pre-baked page. (The failure is silent by design here; the
        // default page is a full, correct answer for '/'.)
        setState({ kind: 'default' });
        undoSeo = applyDefaultTitle();
        return;
      }
      setState({ kind: r.status === 'notFound' ? 'notFound' : 'error' });
      if (typeof document !== 'undefined') {
        const prev = document.title;
        document.title = `${i18n.t(r.status === 'notFound' ? 'site:pageNotFoundTitle' : 'site:pageLoadErrorTitle')} — ${brand.productName}`;
        undoSeo = () => { document.title = prev; };
      }
    });
    return () => { live = false; if (undoSeo) undoSeo(); };
  }, [orgId, slug, surface, navigate, attempt]);

  // The built-in page also sets a sensible title.
  useEffect(() => {
    if (orgId) return; // handled in the fetch effect
    return applyDefaultTitle();
  }, [orgId]);

  // R2-D4 — the embed's collection guard, at RENDER time (not fetch time): the
  // page fetch and the embed's own list race, so a resolution-time check loses
  // whenever the page lands first. Evaluated per render, it re-fires when the
  // list arrives; redirect canonicalization already happened at fetch time, so
  // a renamed slug never reaches here under its old name.
  const blocked = state.kind === 'page' && surface === 'slug'
    && Boolean(embed?.isKnownSlug) && !embed!.isKnownSlug!(state.page.slug);
  useEffect(() => {
    if (!blocked || typeof document === 'undefined') return;
    const prev = document.title;
    document.title = `${i18n.t('site:pageNotFoundTitle')} — ${brand.productName}`;
    return () => { document.title = prev; };
  }, [blocked]);

  if (state.kind === 'loading') return <div className="u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div>;

  if (state.kind === 'notFound' || state.kind === 'error' || blocked) {
    const notFound = state.kind === 'notFound' || blocked;
    return (
      <div className="cms-public-page">
        <section className="cms-public-section fp-section">
          <div className="fp-shell fp-shell--narrow">
            <div className="fp-blog__empty">
              <h1 className="fp-blog__empty-title">{t(notFound ? 'pageNotFoundTitle' : 'pageLoadErrorTitle')}</h1>
              <p className="fp-blog__empty-body">{t(notFound ? 'pageNotFoundBody' : 'pageLoadErrorBody')}</p>
              {notFound
                ? <Link to={embed?.fallbackTo ?? '/'} className="fp-btn fp-btn--ghost">{embed?.fallbackLabel ?? t('backToHome')}</Link>
                : <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</button>}
            </div>
          </div>
        </section>
      </div>
    );
  }

  const page = state.kind === 'page' ? state.page : null;
  // Root falls back to the pre-baked page when the answer has nothing to show;
  // a deep-linked slug never borrows the home content — a published-but-empty
  // page renders its own (honest) title instead.
  if (surface === 'slug' && page && page.sections.length === 0) {
    return (
      <div className="cms-public-page">
        <PublicMenuActions>
          <EditThisPageLink orgId={orgId} slug={page.slug} />
        </PublicMenuActions>
        <section className="cms-public-section fp-section">
          <div className="fp-shell fp-shell--narrow">
            <div className="fp-blog__empty">
              <h1 className="fp-blog__empty-title">{page.title}</h1>
              <Link to={embed?.fallbackTo ?? '/'} className="fp-btn fp-btn--ghost">{embed?.fallbackLabel ?? t('backToHome')}</Link>
            </div>
          </div>
        </section>
      </div>
    );
  }
  const sections = page && page.sections.length > 0 ? page.sections : buildDefaultSections(demo);
  // A large CHILD-page catalog (the Features page: many card grids) gets a
  // client-side search field. The root home page never does: a content-rich
  // home can legitimately use four card sections, and structural card count
  // alone must not turn its narrative into a feature finder.
  return (
    <div className="cms-public-page">
      <PublicMenuActions>
        {/* CMS-R2-3 — the authorized-editor jump link. Renders NOTHING (and
            issues NO request) for anonymous visitors; only a real CMS page has
            something to edit, so it is gated on `page` too. */}
        {page ? <EditThisPageLink orgId={orgId} slug={page.slug} /> : null}
      </PublicMenuActions>
      <PublicHeaderActions>
        {/* CORRECTION 2026-09-11 — `/` is the front page for signed-in visitors
            too, so give them the way back into the product. Root surface only. */}
        {surface === 'root' ? <OpenAppLink /> : null}
      </PublicHeaderActions>
      <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}>
        {surface === 'slug' && hasLargeCatalog(sections)
          ? <CatalogView sections={sections} />
          : <RenderSections sections={sections} mode="public" />}
      </Suspense>
    </div>
  );
}
