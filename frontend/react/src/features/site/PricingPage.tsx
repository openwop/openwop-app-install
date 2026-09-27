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

/** The bare fallback section shown when no `pricing` CMS page is authored yet. */
function fallbackSections(heading: string, eyebrow: string, blurb: string): Section[] {
  return [{ sectionId: 'pricing-fallback', type: 'pricing', data: { heading, eyebrow, blurb } }];
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

  // A11Y-1 — a labeled status region like the inner section's (discoverable;
  // role=status mounted with content is not reliably spoken on insertion).
  if (!done) return <div className="cms-public-page"><div className="u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div></div>;

  const sections = page && page.sections.length > 0
    ? page.sections
    : fallbackSections(t('pricingHeading'), t('pricingEyebrow'), t('pricingBlurb'));
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
