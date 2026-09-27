/**
 * Feature-bundle shop (ADR 0366 P3/P4 + ADR 0419 P2). Two audiences, one page:
 *
 *  - the tenant **Feature store** (ADR 0419) — buy a premium bundle and its
 *    features turn on in your workspace (entitlement-gated). The hero when
 *    billing is on and any bundle is for sale.
 *  - the operator **white-label composer** (ADR 0366) — tick bundles/features
 *    and EXPORT an include-mode `distributions/<name>.json` manifest (the shop
 *    closes the dependsOn graph so the export always builds). Demoted to a
 *    collapsible "advanced" section so the two mental models don't blur.
 *
 * The store composes the billing-owned commerce read (`fetchBundleCommerce`)
 * over HTTP onto the catalog; buying rides the billing checkout. Composing a
 * manifest stays read-only against the host (a manifest becomes a build only via
 * a repo PR + the gated `gen-distribution` pipeline).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { BoxesIcon, LockIcon, CheckIcon, SparklesIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import {
  fetchFeatureBundles, fetchBundleCommerce, buyBundle,
  type BundleFeatureInfo, type FeatureBundleCatalog, type BundleCommerce,
} from './marketplaceClient.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

const featureLabel = (f: BundleFeatureInfo): string => f.label ?? f.id;

/** Group features by their toggle category, sorted; '' → the "Other" bucket. */
function groupByCategory(feats: BundleFeatureInfo[], otherLabel: string): Array<[string, BundleFeatureInfo[]]> {
  const groups = new Map<string, BundleFeatureInfo[]>();
  for (const f of feats) {
    const key = f.category && f.category.trim() ? f.category : otherLabel;
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function BundleShopPage(): JSX.Element {
  const { t } = useTranslation('marketplace');
  const access = useFeatureAccess('marketplace');
  const billing = useFeatureAccess('billing');
  const [catalog, setCatalog] = useState<FeatureBundleCatalog | null>(null);
  const [commerce, setCommerce] = useState<BundleCommerce[]>([]);
  const [commerceUnavailable, setCommerceUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // MKT2-M2 (R3) — failure is its own state, with retry (the error used to sit
  // above a permanent skeleton).
  const [catalogFailed, setCatalogFailed] = useState(false);
  /** MKT-UX-8 — the Consent double-submit shape, live one route from the code
   *  that gets it right. `buy` set NO flag and the button carried no `disabled`,
   *  so every click during the `buyBundle` round trip fired another
   *  `POST …/billing/bundles/:bundleId/checkout`. Keyed by bundleId so buying one
   *  bundle does not disable the rest (MKT-UX-19's shape, avoided here rather
   *  than repeated). */
  const [buying, setBuying] = useState<string | null>(null);
  const [pickedBundles, setPickedBundles] = useState<Set<string>>(new Set());
  const [pickedFeatures, setPickedFeatures] = useState<Set<string>>(new Set());
  const [name, setName] = useState('my-distribution');
  const [params, setParams] = useSearchParams();

  const loadCatalog = useCallback(() => {
    setCatalog(null);
    setCatalogFailed(false);
    void fetchFeatureBundles().then((c) => { setCatalog(c); setError(null); }).catch((e) => { setCatalogFailed(true); setError(e instanceof Error ? e.message : String(e)); });
  }, []);
  useEffect(() => {
    if (!access.enabled) return;
    loadCatalog();
  }, [access.enabled, loadCatalog]);

  // The billing-owned commerce projection (for-sale / owned / price). Empty when
  // billing is off — the route 404s and the client returns []. A THROWN failure
  // is different (MKT-G1): folding it into [] made a transient error render the
  // paid store as "nothing for sale" — the legitimate billing-off shape — with
  // no sign anything went wrong on a revenue surface.
  const loadCommerce = useCallback(() => {
    if (!access.enabled || !billing.enabled) { setCommerce([]); return; }
    setCommerceUnavailable(false);
    void fetchBundleCommerce().then(setCommerce).catch(() => { setCommerce([]); setCommerceUnavailable(true); });
  }, [access.enabled, billing.enabled]);
  useEffect(() => { loadCommerce(); }, [loadCommerce]);

  // Checkout return — the entitlement flips only when Stripe's webhook lands, so
  // never mark "owned" optimistically: toast honestly and re-read the grant.
  useEffect(() => {
    const outcome = params.get('checkout');
    if (!outcome) return;
    if (outcome === 'success') { toast.success(t('bundleCheckoutSuccess')); loadCommerce(); }
    else if (outcome === 'cancelled') { toast.info(t('bundleCheckoutCancelled')); }
    const next = new URLSearchParams(params); next.delete('checkout'); setParams(next, { replace: true });
  }, [params, setParams, loadCommerce, t]);

  // Stable references so the composition memos below don't recompute every render.
  const bundles = useMemo(() => catalog?.bundles ?? [], [catalog]);
  const standalone = useMemo(() => catalog?.standalone ?? [], [catalog]);
  const core = useMemo(() => catalog?.core ?? [], [catalog]);
  const commerceById = useMemo(() => new Map(commerce.map((c) => [c.bundleId, c])), [commerce]);

  // Feature index: id → info + the core set.
  const index = useMemo(() => {
    const info = new Map<string, BundleFeatureInfo>();
    const coreSet = new Set<string>();
    for (const b of bundles) for (const f of b.features) info.set(f.id, f);
    for (const f of standalone) info.set(f.id, f);
    for (const f of core) { info.set(f.id, f); coreSet.add(f.id); }
    return { info, coreSet };
  }, [bundles, standalone, core]);

  const nameOk = NAME_RE.test(name);

  // Compose the manifest — closing the dependsOn graph so the export always
  // builds (core is always present, so deps ON core need no listing).
  const composed = useMemo(() => {
    const { info, coreSet } = index;
    const coveredByPickedBundle = new Set<string>();
    for (const b of bundles) if (pickedBundles.has(b.id)) for (const f of b.features) coveredByPickedBundle.add(f.id);

    const included = new Set<string>([...coveredByPickedBundle, ...pickedFeatures]);
    const stack = [...included];
    while (stack.length) {
      const id = stack.pop() as string;
      for (const dep of info.get(id)?.dependsOn ?? []) {
        if (coreSet.has(dep) || included.has(dep)) continue;
        included.add(dep);
        stack.push(dep);
      }
    }
    const features = [...included].filter((id) => !coveredByPickedBundle.has(id)).sort();
    const autoRequired = features.filter((id) => !pickedFeatures.has(id));
    const manifestObj = {
      description: t('bundleManifestDescription'),
      ...(pickedBundles.size ? { bundles: [...pickedBundles].sort() } : {}),
      ...(features.length ? { features } : {}),
    };
    return { manifest: JSON.stringify(manifestObj, null, 2) + '\n', autoRequired, selectedCount: included.size };
  }, [pickedBundles, pickedFeatures, bundles, index, t]);

  const toggleIn = (setter: typeof setPickedBundles) => (id: string): void => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleBundle = toggleIn(setPickedBundles);
  const toggleFeature = toggleIn(setPickedFeatures);

  const download = (): void => {
    const blob = new Blob([composed.manifest], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async (): Promise<void> => {
    // MKT-G2 — a rejected clipboard write was an unobserved promise rejection:
    // no toast, no error, the user believes the manifest copied (Step 5.5
    // failure-as-silence). Say which outcome actually happened.
    try {
      await navigator.clipboard.writeText(composed.manifest);
      toast.success(t('bundleCopied'));
    } catch {
      toast.error(t('bundleCopyFailed'));
    }
  };
  const buy = async (bundleId: string): Promise<void> => {
    if (buying) return;
    setBuying(bundleId);
    try {
      const { url, mode } = await buyBundle(bundleId);
      // MKT-UX-9 (the pack lane's sibling) — branch on `mode` ALONE. A LIVE
      // response with an unusable url used to fall through to `bundleBuyDemo`,
      // which says "no real charge was made" — the worst possible sentence to be
      // wrong about, asserted to a user whose live checkout session may exist.
      if (mode === 'live') {
        if (url) { window.location.assign(url); return; }
        toast.error(t('bundleCheckoutUnavailable'));
        return;
      }
      toast.info(t('bundleBuyDemo'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('bundleBuyFailed'));
    } finally {
      setBuying(null);
    }
  };

  if (access.loading) {
    return (
      <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="marketplace-bundles.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('bundleShopTitle')} lede={t('bundleShopLede')} />
        <Skeleton />
      </div>
    );
  }
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const forSaleBundles = bundles.filter((b) => commerceById.get(b.id)?.forSale);
  const hasStore = billing.enabled && forSaleBundles.length > 0;
  const standaloneGroups = groupByCategory(standalone, t('bundleUncategorized'));
  const coreGroups = groupByCategory(core, t('bundleUncategorized'));

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough="marketplace-bundles.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('bundleShopTitle')} lede={t('bundleShopLede')} />
      {error ? <Notice variant="error">{t('bundlesFailedLead')} {error}</Notice> : null}
      {commerceUnavailable ? (
        <Notice variant="warning" announce={t('commerceUnavailable')}>
          {t('commerceUnavailable')}{' '}
          <Button variant="secondary" size="sm" onClick={loadCommerce}>{t('common:retry')}</Button>
        </Notice>
      ) : null}
      <p className="muted">
        <Link to="/marketplace">{t('bundleBackToMarketplace')}</Link>
      </p>

      {catalogFailed ? (
        <StateCard
          announce
          icon={<BoxesIcon />}
          title={t('bundlesFailedTitle')}
          body={t('bundlesFailedBody')}
          action={<Button variant="secondary" onClick={loadCatalog}>{t('common:retry')}</Button>}
        />
      ) : !catalog ? (
        <Skeleton />
      ) : !catalog.available ? (
        <StateCard icon={<BoxesIcon />} title={t('bundlesNoneTitle')} body={t('bundlesNoneBody')} />
      ) : (
        <>
          {/* ── ADR 0419 — the tenant FEATURE STORE (hero when billing is on) ── */}
          {billing.enabled ? (
            <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="store-heading">
              <h2 id="store-heading" className="u-m-0">{t('storeTitle')}</h2>
              <p className="muted u-m-0">{t('storeLede')}</p>
              {!hasStore ? (
                <StateCard icon={<SparklesIcon />} title={t('storeEmptyTitle')} body={t('storeEmptyBody')} />
              ) : (
                <div className="card-grid">
                  {forSaleBundles.map((b) => {
                    const c = commerceById.get(b.id);
                    const owned = !!c?.owned;
                    const price = c?.priceDisplay?.price;
                    return (
                      <div key={b.id} className="surface-card u-gap-2 u-p-4">
                        <div className="u-flex u-items-center u-justify-between u-gap-2">
                          <strong>{b.label}</strong>
                          {owned ? (
                            <span className="chip chip--success u-flex u-items-center u-gap-1"><CheckIcon aria-hidden /> {t('owned')}</span>
                          ) : price ? (
                            <span className="u-flex u-items-baseline u-gap-1">
                              <strong>{price}</strong>
                              {c?.priceDisplay?.cadence ? <span className="muted">{c.priceDisplay.cadence}</span> : null}
                            </span>
                          ) : null}
                        </div>
                        {c?.priceDisplay?.blurb ? <p className="muted u-m-0">{c.priceDisplay.blurb}</p> : null}
                        <ul className="muted u-gap-1">
                          {b.features.map((f) => <li key={f.id}>{featureLabel(f)}</li>)}
                        </ul>
                        <div className="action-bar">
                          {owned ? (
                            <Link className="btn-ghost btn-sm" to="/billing">{t('manageInPortal')}</Link>
                          ) : (
                            <Button
                              variant="primary"
                              disabled={buying !== null || !price}
                              onClick={() => { void buy(b.id); }}
                              aria-label={t('buyAria', { bundle: b.label })}
                            >
                              <LockIcon aria-hidden /> {buying === b.id ? t('buying') : t('buy')}
                            </Button>
                          )}
                        </div>
                        {/* MKT-UX-6 — `forSale` comes from OPENWOP_BILLING_BUNDLE_PRICES and
                            `priceDisplay` from OPENWOP_BILLING_BUNDLE_DISPLAY, two
                            INDEPENDENT env vars with nothing coupling them. An operator
                            who configures prices without display copy shipped a store
                            whose every card offered **Buy** with no amount, no cadence
                            and no blurb anywhere on the page — the buyer first learned
                            the charge on Stripe's own page. An irreversible money action
                            must not be offered without an amount beside it, so the button
                            is disabled and the reason is stated instead of left blank. */}
                        {!owned && !price ? <p className="muted u-m-0">{t('bundlePriceUnavailable')}</p> : null}
                        {!owned ? <p className="muted u-m-0">{t('unlockHint')}</p> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {/* ── ADR 0366 — the operator WHITE-LABEL COMPOSER (demoted; open when there is no store) ── */}
          <details className="surface-card u-p-4" open={!hasStore}>
            <summary className="u-flex u-items-center u-gap-2"><BoxesIcon aria-hidden /> <strong>{t('composerTitle')}</strong></summary>
            <p className="muted">{t('composerLede')}</p>

            {/* Tier 1 — selectable bundles (feature groupings) */}
            {bundles.length > 0 ? (
              <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="bundles-heading">
                <h3 id="bundles-heading" className="u-m-0">{t('bundlesSectionTitle')}</h3>
                <p className="muted u-m-0">{t('bundlesSectionLede')}</p>
                <div className="card-grid">
                  {bundles.map((b) => (
                    <div key={b.id} className="surface-card u-gap-2 u-p-4">
                      <label className="u-flex u-items-center u-gap-2">
                        <input
                          type="checkbox"
                          checked={pickedBundles.has(b.id)}
                          onChange={() => toggleBundle(b.id)}
                          aria-describedby={`bundle-${b.id}-features`}
                        />
                        <strong>{b.label}</strong>
                        <span className="chip chip--muted">{t('bundleFeatureCount', { count: b.features.length })}</span>
                      </label>
                      <ul id={`bundle-${b.id}-features`} className="muted u-gap-1">
                        {b.features.map((f) => (
                          <li key={f.id}>
                            {featureLabel(f)}
                            {!f.registered ? <span className="chip chip--muted">{t('bundleNotInBuild')}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Tier 2 — individually selectable standalone features */}
            {standalone.length > 0 ? (
              <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="standalone-heading">
                <h3 id="standalone-heading" className="u-m-0">{t('standaloneSectionTitle')}</h3>
                <p className="muted u-m-0">{t('standaloneSectionLede')}</p>
                {standaloneGroups.map(([category, feats]) => (
                  <div key={category} className="surface-card u-gap-2 u-p-4">
                    <strong>{category}</strong>
                    <ul className="u-gap-1">
                      {feats.map((f) => (
                        <li key={f.id}>
                          <label className="u-flex u-items-center u-gap-2">
                            <input type="checkbox" checked={pickedFeatures.has(f.id)} onChange={() => toggleFeature(f.id)} />
                            <span>{featureLabel(f)}</span>
                            {!f.registered ? <span className="chip chip--muted">{t('bundleNotInBuild')}</span> : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            ) : null}

            {/* Tier 3 — read-only core */}
            {core.length > 0 ? (
              <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="core-heading">
                <h3 id="core-heading" className="u-m-0">{t('coreSectionTitle')}</h3>
                <p className="muted u-m-0">{t('coreSectionLede')}</p>
                <div className="surface-card u-gap-2 u-p-4">
                  {coreGroups.map(([category, feats]) => (
                    <div key={category} className="u-gap-1 u-flex u-flex-col">
                      <strong>{category}</strong>
                      <div className="u-flex u-flex-wrap u-gap-1">
                        {feats.map((f) => <span key={f.id} className="chip chip--muted">{featureLabel(f)}</span>)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Manifest composer */}
            <div className="surface-card u-gap-2 u-p-4">
              <strong>{t('bundleManifestLabel')}</strong>
              <p className="muted">{t('bundleManifestExplainer')}</p>
              <span className="chip chip--muted">{t('bundleSelectionSummary', { count: composed.selectedCount })}</span>
              {composed.autoRequired.length > 0 ? (
                <Notice variant="info">
                  {t('bundleRequiredBySelection', {
                    features: composed.autoRequired.map((id) => featureLabel(index.info.get(id) ?? { id, dependsOn: [], registered: false })).join(', '),
                  })}
                </Notice>
              ) : null}
              <label className="u-flex u-items-center u-gap-2">
                {t('bundleNameLabel')}
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!nameOk} aria-describedby="bundle-name-hint" />
              </label>
              {!nameOk ? <Notice variant="error" id="bundle-name-hint">{t('bundleNameInvalid')}</Notice> : <span id="bundle-name-hint" className="sr-only">{t('bundleNameLabel')}</span>}
              <pre className="bundle-manifest-preview"><code>{composed.manifest}</code></pre>
              <div className="action-bar">
                <Button variant="primary" onClick={download} disabled={!nameOk}>{t('bundleDownload')}</Button>
                <Button variant="primary" onClick={() => { void copy(); }}>{t('bundleCopy')}</Button>
              </div>
              <p className="muted">{t('bundlePipelineExplainer')}</p>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
