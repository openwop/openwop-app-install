/**
 * ADR 0391 (b) / ADR 0820 §7 / ADR 0821 D7 — the `pricing` section body: the
 * live plan grid, ONE Monthly / Yearly switch, the plan comparison, the add-on
 * bundles and the AI credit packs. Rendered only through `SectionRenderer`
 * (lazily — this is its own chunk), never as a second pricing page.
 *
 * Everything priced comes from the two PUBLIC billing reads at render time
 * (`/public/pricing`, `/public/bundle-pricing`); nothing is baked in. Honesty
 * rules carried over from the first version and kept here:
 *  - a price renders ONLY when the operator configured one (no invented figure);
 *  - the yearly note is the operator's own words, verbatim (never computed);
 *  - a FAILED read is not "nothing configured" (READ-1);
 *  - the comparison is built from the same `features` the cards use.
 * Feature names come from the server's `featureLabels` map — the toggle-registry
 * label the feature store also shows — and fall back to a humanized id only for
 * an id this build does not label.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { config, fetchOpts } from '../../client/config.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { Button } from '../../ui/Button.js';
import { useFormat } from '../../i18n/useFormat.js';
import { handleRadiogroupKeyDown } from '../../ui/rovingTabs.js';
import { useAuth } from '../../auth/useAuth.js';
import { useBackendSession } from '../../auth/backendSession.js';
import { CtaLink } from './CtaLink.js';
import { openHeaderSignIn, rememberReturn, STORE_URL, takeReturn } from '../../auth/signInReturn.js';

/** Pricing `features` are ENTITLEMENT feature ids (`app-builder`, `cdp`). The
 *  server labels the ones it registers; this is the fallback for the rest:
 *  Title-case words, UPPER-case known acronyms. Best-effort, deterministic. */
const FEATURE_ACRONYMS = new Set(['cdp', 'cad', 'crm', 'cms', 'api', 'ai', 'seo', 'sso', 'sms', 'kb', 'ui', 'ux', 'a2a', 'mcp', 'rag', 'hitl', 'byok', 'kpi', 'faq', 'pdf', 'csv', 'url', 'rss', 'dpa', 'aup', 'sla']);
export function humanizeFeatureId(id: string): string {
  // Limit keys are camelCase config keys (`workflowRuns`) — split those word
  // boundaries too, not just kebab/snake (R2-G5).
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).filter(Boolean)
    .map((w) => (FEATURE_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
/** How many feature bullets a tier card shows before an "and N more" line. */
const FEATURE_CARD_CAP = 6;
/**
 * Anonymous visitors cannot use the store (it is an authed admin page), so a
 * store CTA for them opens the EXISTING header sign-in dialog and remembers
 * where to go after sign-in (`auth/signInReturn`, shared with the store's own
 * anonymous state). The provider returns to /pricing, which then continues to
 * the store. `pricingSignInReturn.test.tsx` pins that contract.
 */
export { takeReturn };

/** A CTA into the store: a link when the visitor can use it; for an anonymous
 *  visitor, a button that opens sign-in and returns here → the store. */
function StoreCta({ label, ariaLabel, url, primary, anonymous }: { label: string; ariaLabel?: string; url: string; primary?: boolean; anonymous: boolean }): JSX.Element | null {
  const navigate = useNavigate();
  if (!anonymous) return <CtaLink label={label} url={url} primary={Boolean(primary)} {...(ariaLabel ? { ariaLabel } : {})} />;
  return (
    // variant="primary" adds no class (bare = the element's own styling); the
    // `fp-btn` chrome matches the CtaLink beside it, as the store's CadenceSwitch does.
    <Button
      variant="primary" aria-haspopup="dialog" aria-label={ariaLabel}
      className={`fp-btn ${primary ? 'fp-btn--primary' : 'fp-btn--ghost'}`}
      onClick={() => {
        rememberReturn(url);
        // No sign-in UI on this host (auth unconfigured) ⇒ the store itself.
        if (!openHeaderSignIn()) { takeReturn(); navigate(url); }
      }}
    >{label}</Button>
  );
}

/** One tier in the public pricing catalog. Marketing-safe only — the read never
 *  carries a Stripe id. `display` is present only when the operator configured it. */
interface PublicTier {
  tier: string;
  name: string;
  // '*' = unrestricted (all features) — the billing wire sentinel; NOT always an array.
  features?: '*' | string[];
  limits?: Record<string, unknown>;
  display?: PriceDisplay & { highlighted?: boolean; annualNote?: string };
}
interface PriceDisplay { price?: string; cadence?: string; blurb?: string; priceAnnual?: string; cadenceAnnual?: string }
interface PublicBundle { bundleId: string; label: string; features?: string[]; standalone?: boolean; priceDisplay?: PriceDisplay }
interface CreditPack { credits: number; price: string; label?: string }
interface PricingPayload { tiers: PublicTier[]; featureLabels?: Record<string, string>; creditPacks?: CreditPack[] }

type Period = 'monthly' | 'annual';

/** The price a card shows for the chosen period, plus the other period as a
 *  quiet "or …" line. A display without the chosen period keeps its own single
 *  price + its own cadence string (which discloses the period) — never relabeled. */
function priceFor(d: PriceDisplay | undefined, period: Period): { price?: string; cadence?: string; alt?: string } {
  if (!d) return {};
  const annual = period === 'annual' && Boolean(d.priceAnnual);
  const price = annual ? d.priceAnnual : d.price;
  const cadence = annual ? d.cadenceAnnual : d.cadence;
  const other = annual
    ? (d.price && d.cadence ? `${d.price}${d.cadence}` : undefined)
    : (d.priceAnnual ? `${d.priceAnnual}${d.cadenceAnnual ?? ''}` : undefined);
  return { ...(price ? { price } : {}), ...(cadence ? { cadence } : {}), ...(other ? { alt: other } : {}) };
}

const featureList = (tt: PublicTier): string[] => (Array.isArray(tt.features) ? tt.features.filter((f) => typeof f === 'string' && f.trim() !== '') : []);
/** A tier includes a bundle when it is unrestricted or lists every bundle feature. */
function tierHasBundle(tt: PublicTier, b: PublicBundle): boolean {
  if (tt.features === '*') return true;
  const fs = b.features ?? [];
  if (fs.length === 0 || !Array.isArray(tt.features)) return false;
  const own = new Set(tt.features);
  return fs.every((f) => own.has(f));
}
/** A $0 plan starts free (no checkout). */
const isFreeTier = (tt: PublicTier): boolean => tt.tier === 'free' || /^\D*0(?:[.,]0+)?\D*$/.test(tt.display?.price ?? '');

function makeLabel(labels: Record<string, string>): (id: string) => string {
  return (id) => labels[id] ?? humanizeFeatureId(id);
}

/** The billing-period switch: a real radiogroup (selection follows focus, one
 *  tab stop) with the feature store's labels — "Monthly" / "Yearly" + the
 *  operator's own yearly note. */
function PeriodSwitch({ period, onChange, note, t }: { period: Period; onChange: (p: Period) => void; note: string | undefined; t: TFunction }): JSX.Element {
  const opt = (p: Period, label: string, hint?: string): JSX.Element => (
    <button
      type="button" role="radio" aria-checked={period === p} tabIndex={period === p ? 0 : -1}
      className="fp-period__btn" onClick={() => onChange(p)}
    >
      {label}
      {hint ? <span className="fp-period__hint">{hint}</span> : null}
    </button>
  );
  return (
    <div className="fp-pricing__period" role="radiogroup" aria-label={t('pricingBillingPeriodLabel', { defaultValue: 'Billing period' })} onKeyDown={handleRadiogroupKeyDown}>
      {opt('monthly', t('pricingMonthly', { defaultValue: 'Monthly' }))}
      {opt('annual', t('pricingYearly', { defaultValue: 'Yearly' }), note)}
    </div>
  );
}

/**
 * The plan comparison. With bundle data it leads with one row per BUNDLE (what
 * a buyer actually chooses between) and expands to every feature on request,
 * grouped by bundle; without it, the flat feature × tier matrix. Either way it
 * is built from the SAME `features` the cards render, so it cannot disagree
 * with them. The table scrolls inside its own container on a phone.
 */
function TierComparison({ tiers, bundles, label, period }: { tiers: PublicTier[]; bundles: PublicBundle[]; label: (id: string) => string; period: Period }): JSX.Element | null {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const headingId = useId();
  const detailId = useId();
  const [showAll, setShowAll] = useState(false);

  const rows = ((): string[] => {
    const seen = new Set<string>();
    for (const tt of tiers) for (const f of featureList(tt)) seen.add(f);
    return [...seen];
  })();
  // R2-G5 — usage limits are the concrete differentiator. The config declares no
  // period/unit beyond the key itself, so none is invented; a missing key reads
  // "not specified" (the payload cannot tell unlimited from unconfigured).
  const limitRows = ((): string[] => {
    const seen = new Set<string>();
    for (const tt of tiers) {
      if (!tt.limits || typeof tt.limits !== 'object') continue;
      for (const [k, v] of Object.entries(tt.limits)) if (typeof v === 'number' && Number.isFinite(v) && k.trim()) seen.add(k);
    }
    return [...seen];
  })();
  if (tiers.length < 2 || (rows.length === 0 && limitRows.length === 0)) return null;

  const groupedBundles = bundles.filter((b) => (b.features ?? []).length > 0);
  const byBundle = groupedBundles.length > 0;

  const yesNo = (has: boolean, key: string): JSX.Element => (
    <td key={key} className={has ? 'fp-compare__yes' : 'fp-compare__no'}>
      <span aria-hidden="true">{has ? '✓' : '—'}</span>
      <span className="sr-only">{has
        ? t('pricingCompareIncluded', { defaultValue: 'Included' })
        : t('pricingCompareNotIncluded', { defaultValue: 'Not included' })}</span>
    </td>
  );
  const featureRow = (feature: string): JSX.Element => (
    <tr key={feature}>
      <th scope="row">{label(feature)}</th>
      {tiers.map((tt) => yesNo(tt.features === '*' || featureList(tt).includes(feature), tt.tier))}
    </tr>
  );
  const groupRow = (key: string, text: string): JSX.Element => (
    <tr key={`g:${key}`} className="fp-compare__group"><th scope="colgroup" colSpan={tiers.length + 1}>{text}</th></tr>
  );

  // Feature rows grouped by the bundle that sells them; the rest under "Platform".
  const groupedFeatureRows = (): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const placed = new Set<string>();
    for (const b of groupedBundles) {
      const fs = (b.features ?? []).filter((f) => rows.includes(f) && !placed.has(f));
      if (fs.length === 0) continue;
      out.push(groupRow(b.bundleId, b.label));
      for (const f of fs) { placed.add(f); out.push(featureRow(f)); }
    }
    const rest = rows.filter((f) => !placed.has(f));
    if (rest.length > 0) {
      out.push(groupRow('platform', t('pricingComparePlatform', { defaultValue: 'Platform' })));
      for (const f of rest) out.push(featureRow(f));
    }
    return out;
  };

  return (
    <section className="fp-compare" aria-labelledby={headingId}>
      <h3 id={headingId} className="fp-compare__title">{t('pricingCompareTitle', { defaultValue: 'Compare plans' })}</h3>
      <p className="fp-compare__hint" aria-hidden="true">{t('pricingCompareSwipeHint', { defaultValue: 'Swipe the table sideways to see every plan →' })}</p>
      <div className="fp-compare__scroll" tabIndex={0} role="region" aria-labelledby={headingId}>
        <table className="fp-compare__table">
          <caption className="sr-only">{t('pricingCompareCaption', { defaultValue: 'Which features each plan includes' })}</caption>
          <thead>
            <tr>
              <th scope="col">{byBundle ? t('pricingCompareBundle', { defaultValue: 'Bundle' }) : t('pricingCompareFeature', { defaultValue: 'Feature' })}</th>
              {tiers.map((tt) => <th key={tt.tier} scope="col">{tt.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {byBundle ? groupedBundles.map((b) => {
              const { price, cadence } = priceFor(b.priceDisplay, period);
              return (
                <tr key={`b:${b.bundleId}`}>
                  <th scope="row">{b.label}</th>
                  {tiers.map((tt) => {
                    if (tierHasBundle(tt, b)) return yesNo(true, tt.tier);
                    const text = b.standalone
                      ? t('pricingCompareSoldSeparately', { defaultValue: 'Sold separately' })
                      : price
                        ? t('pricingCompareAddonPrice', { defaultValue: 'Add-on · {{price}}', price: `${price}${cadence ?? ''}` })
                        : t('pricingCompareAddon', { defaultValue: 'Add-on' });
                    return <td key={tt.tier} className="fp-compare__addon">{text}</td>;
                  })}
                </tr>
              );
            }) : rows.map(featureRow)}
            {limitRows.map((key) => (
              <tr key={`limit:${key}`}>
                <th scope="row">{t(`pricingLimit_${key}`, { defaultValue: humanizeFeatureId(key) })}</th>
                {tiers.map((tt) => {
                  const v = tt.limits && typeof tt.limits === 'object' ? (tt.limits as Record<string, unknown>)[key] : undefined;
                  const isNum = typeof v === 'number' && Number.isFinite(v);
                  return (
                    <td key={tt.tier} className={isNum ? 'fp-compare__num' : 'fp-compare__no'}>
                      {isNum
                        ? <span>{fmt.number(v)}</span>
                        : <>
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">{t('pricingCompareUnspecified', { defaultValue: 'Not specified' })}</span>
                          </>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {byBundle && showAll ? <tbody id={detailId}>{groupedFeatureRows()}</tbody> : null}
        </table>
      </div>
      {byBundle && rows.length > 0 ? (
        <button type="button" className="fp-btn fp-btn--ghost fp-compare__toggle" aria-expanded={showAll} aria-controls={detailId} onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? t('pricingCompareHideAll', { defaultValue: 'Hide feature details' })
            : t('pricingCompareShowAll', { defaultValue: 'Compare all {{n}} features', n: rows.length })}
        </button>
      ) : null}
    </section>
  );
}

export function PricingSection({ tierFilter, ctaLabel, ctaUrl, contactUrl }: {
  tierFilter: string[]; ctaLabel?: string | undefined; ctaUrl?: string | undefined; contactUrl?: string | undefined;
}): JSX.Element {
  const { t } = useTranslation('cms');
  const fmt = useFormat();
  const [payload, setPayload] = useState<PricingPayload | null>(null);
  const [bundles, setBundles] = useState<PublicBundle[]>([]); // ADR 0419 — for-sale add-on bundles
  const [bundlesFailed, setBundlesFailed] = useState(false); // READ-1 — failed ≠ none configured
  const [error, setError] = useState(false);
  // ADR 0820 §7 — monthly first, like the feature store, so the page and the
  // store a visitor lands in after "Choose" show the same number.
  const [period, setPeriod] = useState<Period>('monthly');
  const navigate = useNavigate();
  // Signed in = a Firebase (OIDC) user OR a durable backend session — the same
  // two inputs the header's SignInButton treats as signed in.
  const { user, isConfigured, loading } = useAuth();
  const backendUser = useBackendSession().user;
  const signedIn = Boolean(user || backendUser);
  const anonymous = isConfigured && !loading && !signedIn;
  // Back from sign-in (password: same page; OIDC: a fresh load of /pricing) ⇒
  // continue to the store the visitor chose.
  useEffect(() => {
    if (!signedIn) return;
    const url = takeReturn();
    if (url) navigate(url);
  }, [signedIn, navigate]);
  const addonsId = useId();
  const creditsId = useId();
  useEffect(() => {
    let live = true;
    void fetch(`${config.baseUrl}/host/openwop-app/public/pricing`, fetchOpts({}))
      .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as Partial<PricingPayload>; })
      .then((r) => {
        if (!live) return;
        setPayload({
          tiers: Array.isArray(r.tiers) ? r.tiers : [],
          featureLabels: r.featureLabels && typeof r.featureLabels === 'object' ? r.featureLabels : {},
          creditPacks: Array.isArray(r.creditPacks) ? r.creditPacks.filter((p) => p && typeof p.credits === 'number' && typeof p.price === 'string' && p.price) : [],
        });
      })
      .catch(() => { if (live) setError(true); });
    // Bundle add-ons (ADR 0419) — genuinely-unconfigured (404 / empty) ⇒ nothing
    // shown; a FAILED read is not "no bundles" (READ-1). It never blocks the tier
    // grid — the failure renders as a note in the add-ons slot.
    void fetch(`${config.baseUrl}/host/openwop-app/public/bundle-pricing`, fetchOpts({}))
      .then(async (r) => {
        if (r.status === 404) return { bundles: [] as PublicBundle[] };
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { bundles: PublicBundle[] };
      })
      .then((r) => { if (live) { setBundlesFailed(false); setBundles(Array.isArray(r.bundles) ? r.bundles : []); } })
      .catch(() => { if (live) setBundlesFailed(true); });
    return () => { live = false; };
  }, []);

  const label = makeLabel(payload?.featureLabels ?? {});
  if (error) return <p className="fp-pricing__note">{t('pricingLoadError', { defaultValue: 'Couldn’t load pricing.' })}</p>;
  if (!payload) return <div className="u-p-2" role="status" aria-label={t('common:loading')}><Skeleton /></div>;
  const tiers = payload.tiers;
  // The section may name WHICH tiers to show (in order); empty ⇒ all, as returned.
  const shown = tierFilter.length > 0
    ? tierFilter.map((k) => tiers.find((x) => x.tier === k)).filter((x): x is PublicTier => Boolean(x))
    : tiers;
  if (shown.length === 0) return <p className="fp-pricing__note">{t('pricingEmpty', { defaultValue: 'No plans configured yet.' })}</p>;

  const hasAnnual = shown.some((tt) => tt.display?.priceAnnual) || bundles.some((b) => b.priceDisplay?.priceAnnual);
  const effPeriod: Period = hasAnnual ? period : 'monthly';
  // The yearly note is the operator's OWN claim, verbatim. First authored one wins.
  const annualNote = shown.map((tt) => tt.display?.annualNote).find((n) => n);
  const packs = payload.creditPacks ?? [];
  // The workspace-pricing facts below are claims about PRICED plans; an
  // unpriced (unconfigured) deployment makes none.
  const anyPrice = shown.some((tt) => tt.display?.price) || bundles.some((b) => b.priceDisplay?.price);

  /** The lowest shown plan that includes a bundle (for "Included in Pro"). */
  const includedIn = (b: PublicBundle): PublicTier | undefined => shown.find((tt) => tierHasBundle(tt, b));

  return (
    <>
      {hasAnnual ? <PeriodSwitch period={effPeriod} onChange={setPeriod} note={annualNote} t={t} /> : null}
      <div className="fp-pricing__grid fp-pricing__plans">
        {shown.map((tt, i) => {
          const { price, cadence, alt } = priceFor(tt.display, effPeriod);
          const features = featureList(tt);
          // Pro builds on Free: when the previous card's features are all here,
          // say so and list only what this plan ADDS (no repeated wall).
          const prev = i > 0 ? shown[i - 1] : undefined;
          const prevList = prev ? featureList(prev) : [];
          const buildsOnPrev = Boolean(prev) && prevList.length > 0 && Array.isArray(tt.features) && prevList.every((f) => features.includes(f));
          const own = buildsOnPrev ? features.filter((f) => !prevList.includes(f)) : features;
          const free = isFreeTier(tt);
          const cta = free
            ? { label: ctaLabel || t('pricingStartFree', { defaultValue: 'Start free' }), url: ctaUrl || '/chat', aria: undefined }
            : price
              ? { label: t('pricingChoosePlan', { defaultValue: 'Choose {{plan}}', plan: tt.name }), url: STORE_URL, aria: undefined }
              : contactUrl
                ? { label: t('pricingContactUs', { defaultValue: 'Contact us' }), url: contactUrl, aria: t('pricingContactUsAria', { defaultValue: 'Contact us about {{plan}}', plan: tt.name }) }
                : { label: ctaLabel || t('pricingCta', { defaultValue: 'Get started' }), url: ctaUrl || '/chat', aria: undefined };
          return (
            <article key={tt.tier} className={`fp-tier${tt.display?.highlighted ? ' fp-tier--highlighted' : ''}`}>
              {tt.display?.highlighted ? <span className="fp-tier__badge">{t('pricingPopular', { defaultValue: 'Popular' })}</span> : null}
              <h3 className="fp-tier__name">{tt.name}</h3>
              <div className="fp-tier__pricing">
                {price ? (
                  <p className="fp-tier__price">{price}{cadence ? <span className="fp-tier__cadence">{cadence}</span> : null}</p>
                ) : (
                  <p className="fp-tier__price fp-tier__price--none">{t('pricingContactPrice', { defaultValue: 'Let’s talk' })}</p>
                )}
                {alt && !free ? <p className="fp-tier__alt">{t('pricingOrAlt', { defaultValue: 'or {{price}}', price: alt })}</p> : null}
              </div>
              {tt.display?.blurb ? <p className="fp-tier__blurb">{tt.display.blurb}</p> : null}
              {tt.features === '*' ? (
                <ul className="fp-tier__features">
                  <li>{t('pricingAllFeatures', { defaultValue: 'Everything included' })}</li>
                </ul>
              ) : (
                <>
                  {buildsOnPrev && prev ? (
                    <p className="fp-tier__lead">{own.length > 0
                      ? t('pricingEverythingInPlus', { defaultValue: 'Everything in {{plan}}, plus:', plan: prev.name })
                      : t('pricingEverythingIn', { defaultValue: 'Everything in {{plan}}', plan: prev.name })}</p>
                  ) : null}
                  {own.length > 0 ? (
                    <ul className="fp-tier__features">
                      {own.slice(0, FEATURE_CARD_CAP).map((f) => <li key={f}>{label(f)}</li>)}
                      {own.length > FEATURE_CARD_CAP ? (
                        <li className="fp-tier__features-more">{t('pricingMoreFeatures', { defaultValue: 'and {{n}} more', n: own.length - FEATURE_CARD_CAP })}</li>
                      ) : null}
                    </ul>
                  ) : null}
                </>
              )}
              {cta.url === STORE_URL
                ? <StoreCta label={cta.label} url={cta.url} primary={Boolean(tt.display?.highlighted)} anonymous={anonymous} />
                : <CtaLink label={cta.label} url={cta.url} primary={Boolean(tt.display?.highlighted)} {...(cta.aria ? { ariaLabel: cta.aria } : {})} />}
            </article>
          );
        })}
      </div>
      <TierComparison tiers={shown} bundles={bundles} label={label} period={effPeriod} />
      {bundlesFailed ? (
        <p className="fp-pricing__note">{t('bundlePricingLoadError', { defaultValue: 'Couldn’t load add-on bundles.' })}</p>
      ) : null}
      {bundles.length > 0 ? (
        <section className="fp-pricing__addons" aria-labelledby={addonsId}>
          <h3 id={addonsId} className="fp-pricing__addons-title">{t('pricingAddonsTitle', { defaultValue: 'Add-on feature bundles' })}</h3>
          <p className="fp-pricing__addons-note">{t('pricingAddonsLede', { defaultValue: 'Add any bundle to any plan, priced per workspace. You buy them in your workspace’s feature store.' })}</p>
          <div className="fp-pricing__grid fp-pricing__grid--addons">
            {bundles.map((b) => {
              const { price, cadence, alt } = priceFor(b.priceDisplay, effPeriod);
              const plan = b.standalone ? undefined : includedIn(b);
              return (
                <article key={b.bundleId} className="fp-tier fp-tier--addon">
                  {/* UX-419A — h4 under the group's h3. */}
                  <h4 className="fp-tier__name">{b.label}</h4>
                  {price ? (
                    <div className="fp-tier__pricing">
                      <p className="fp-tier__price">{price}{cadence ? <span className="fp-tier__cadence">{cadence}</span> : null}</p>
                      {alt ? <p className="fp-tier__alt">{t('pricingOrAlt', { defaultValue: 'or {{price}}', price: alt })}</p> : null}
                    </div>
                  ) : null}
                  {b.priceDisplay?.blurb ? <p className="fp-tier__blurb">{b.priceDisplay.blurb}</p> : null}
                  {b.standalone ? (
                    <p className="fp-tier__tag">{t('pricingSoldSeparately', { defaultValue: 'Sold separately — not part of any plan' })}</p>
                  ) : plan ? (
                    <p className="fp-tier__tag fp-tier__tag--quiet">{t('pricingIncludedIn', { defaultValue: 'Included in {{plan}}', plan: plan.name })}</p>
                  ) : null}
                  {price ? (
                    <StoreCta
                      label={t('pricingAddBundle', { defaultValue: 'Add to a workspace' })}
                      ariaLabel={t('pricingAddBundleAria', { defaultValue: 'Add the {{bundle}} bundle to a workspace', bundle: b.label })}
                      url={`${STORE_URL}?bundle=${encodeURIComponent(b.bundleId)}`}
                      anonymous={anonymous}
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}
      {packs.length > 0 ? (
        <section className="fp-pricing__credits" aria-labelledby={creditsId}>
          <h3 id={creditsId} className="fp-pricing__addons-title">{t('pricingCreditsTitle', { defaultValue: 'AI credits' })}</h3>
          <p className="fp-pricing__addons-note">{t('pricingCreditsLede', { defaultValue: 'Paid plans include monthly AI credits. Need more? Top up with a one-time pack.' })}</p>
          <ul className="fp-credits">
            {packs.map((p) => (
              <li key={`${p.credits}:${p.price}`} className="fp-credits__pack">
                <span className="fp-credits__amount">{t('pricingCreditsAmount', { defaultValue: '{{n}} credits', n: fmt.number(p.credits) })}</span>
                <span className="fp-credits__price">{p.price}</span>
                {p.label ? <span className="fp-credits__label">{p.label}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {anyPrice ? <ul className="fp-pricing__facts" aria-label={t('pricingFactsLabel', { defaultValue: 'Good to know' })}>
        <li>{t('pricingFactSeats', { defaultValue: 'Every plan and bundle is priced per workspace, with unlimited seats.' })}</li>
        <li>{t('pricingFactCancel', { defaultValue: 'Change or cancel any time from Billing — your data stays, paid features pause.' })}</li>
      </ul> : null}
    </>
  );
}
