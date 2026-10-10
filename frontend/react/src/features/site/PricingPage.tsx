/**
 * ADR 0391 (b) — the public `/pricing` route. Pricing IS a CMS page: the operator
 * authors a `pricing`-slug page on the system-site org (wrapping the tier grid
 * with marketing copy + FAQ + CTA), and it renders through the ONE
 * `SectionRenderer` (no second rendering path). This component fetches that page
 * and renders its sections; if the operator hasn't authored one yet (404), it
 * falls back to a bare `pricing` section so the route still works out of the box
 * — the tier grid itself is fetched live from `/public/pricing` inside the
 * section renderer (billing stays the owner; no prices baked here).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { brand } from '../../brand/brand.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { RenderSections } from '../cms/SectionRenderer.js';
import { SYSTEM_SITE_ORG, type Section } from '../cms/cmsClient.js';
import { fetchPublicPageResult, type PublicPage } from './siteClient.js';
import { applySeo } from './siteSeo.js';
import type { FaqItem } from './pricingFaq.js';
import { useFormat } from '../../i18n/useFormat.js';

/** The bare fallback section shown when no `pricing` CMS page is authored yet.
 *  `contactUrl` gives an unpriced plan (Enterprise) a real "Contact us" — the
 *  host-site `support` page, which an operator can override by authoring the
 *  `pricing` page with its own `contactUrl`. */
const FALLBACK_CONTACT_URL = '/p/support';
function fallbackSections(heading: string, eyebrow: string, blurb: string, faq: { eyebrow: string; heading: string; items: FaqItem[]; support: { heading: string; lede: string; label: string } } | null): Section[] {
  const sections: Section[] = [{ sectionId: 'pricing-fallback', type: 'pricing', data: { heading, eyebrow, blurb, contactUrl: FALLBACK_CONTACT_URL } }];
  // ADR 0820 §7 — the FAQ rides the ordinary `faq` section type (the block an
  // operator can author too), and the support CTA is a plain `cta` section: FAQ
  // answers are plain text by design, so the link lives here, not in an answer.
  if (faq && faq.items.length > 0) {
    sections.push({ sectionId: 'pricing-fallback-faq', type: 'faq', data: { eyebrow: faq.eyebrow, heading: faq.heading, items: faq.items } });
    sections.push({ sectionId: 'pricing-fallback-support', type: 'cta', data: { heading: faq.support.heading, subheading: faq.support.lede, label: faq.support.label, url: FALLBACK_CONTACT_URL } });
  }
  return sections;
}

export function PricingPage(): JSX.Element {
  const { t } = useTranslation('site');
  const [page, setPage] = useState<PublicPage | null>(null);
  // A FAILED read of the authored wrapper is not "no wrapper authored": without
  // this flag a transient 500 silently stripped the operator's marketing page
  // down to the bare tier grid with no signal to anyone (READ-2).
  const [degraded, setDegraded] = useState(false);
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fmt = useFormat();
  // ADR 0820 §7 — the fallback FAQ's items, built from the live pricing read.
  // Only fetched when the fallback is actually shown (an authored page wins).
  const [faqItems, setFaqItems] = useState<FaqItem[] | null>(null);
  const fallback = done && !(page && page.sections.length > 0);

  useEffect(() => {
    let live = true;
    // Provisional title now (the bare fallback still deserves one); an authored
    // page's applySeo layers on top once it resolves. Both undos run on cleanup.
    const undos: Array<() => void> = [];
    if (typeof document !== 'undefined') {
      const prev = document.title;
      document.title = `${t('pricingTitle')} — ${brand.productName}`;
      undos.push(() => { document.title = prev; });
    }
    void fetchPublicPageResult(SYSTEM_SITE_ORG, 'pricing').then((r) => {
      if (!live) return;
      setPage(r.status === 'ok' ? r.page : null);
      setDegraded(r.status === 'error');
      setDone(true);
      if (r.status === 'ok') undos.push(applySeo(r.page));
    });
    return () => { live = false; for (const u of undos.reverse()) u(); };
  }, [t, attempt]);

  useEffect(() => {
    if (!fallback) { setFaqItems(null); return; }
    let live = true;
    // A failed bundle read only hides the "sold separately" sentence (null);
    // a failed pricing read hides the FAQ — the tier grid already says why.
    // Dynamic import: keeps the FAQ builder + the shared pricing client out of
    // the entry chunk's preload map for this lazy route (entry budget).
    void import('./pricingFaq.js')
      .then((m) => m.loadPricingFaq(t, (xs) => fmt.list(xs)))
      .then((items) => { if (live) setFaqItems(items); })
      .catch(() => { if (live) setFaqItems(null); });
    return () => { live = false; };
  }, [fallback, t, fmt]);

  // A11Y-1 — a labeled status region like the inner section's (discoverable;
  // role=status mounted with content is not reliably spoken on insertion).
  if (!done) return <div className="cms-public-page"><div className="u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div></div>;

  const sections = page && page.sections.length > 0
    ? page.sections
    : fallbackSections(t('pricingHeading'), t('pricingEyebrow'), t('pricingBlurb'), faqItems ? {
      eyebrow: t('pricingFaqEyebrow'), heading: t('pricingFaqHeading'), items: faqItems,
      support: { heading: t('pricingSupportHeading'), lede: t('pricingSupportLede'), label: t('pricingSupportLabel') },
    } : null);
  const hasHero = sections.some((section) => section.type === 'hero');

  return (
    <div className="cms-public-page">
      {!hasHero ? (
        <div className="fp-shell fp-shell--narrow fp-page-heading">
          <h1 className="fp-page-heading__title">{page?.title || t('pricingTitle')}</h1>
        </div>
      ) : null}
      {/* The tier grid below still works (it fetches live from /public/pricing),
          so degrade with a note + retry rather than replacing the page. */}
      {degraded ? (
        <div className="fp-shell fp-shell--narrow">
          <p className="fp-pricing__note">
            {t('pricingWrapperDegraded')}{' '}
            <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</button>
          </p>
        </div>
      ) : null}
      <RenderSections sections={sections} mode="public" />
    </div>
  );
}
