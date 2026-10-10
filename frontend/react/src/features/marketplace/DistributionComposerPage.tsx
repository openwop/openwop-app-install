/**
 * White-label distribution composer (ADR 0366 P3/P4) — its own route,
 * `/marketplace/distribution`, since the feature store redesign (ADR 0820 §7 UI)
 * gave `/marketplace/bundles` to buyers. Same gate as before the move: the route
 * table's `admin` tier + the `marketplace` feature toggle; the store links here
 * only for owners/admins.
 *
 * Tick bundles/features and EXPORT an include-mode `distributions/<name>.json`
 * manifest; the composer closes the dependsOn graph so the export always builds.
 * Read-only against the host: a manifest becomes a build only via a repo PR +
 * the gated `gen-distribution` pipeline (the ADR 0366 P3 pipeline-security ruling).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { BoxesIcon, LockIcon } from '../../ui/icons/index.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useHub } from '../../chrome/hubContext.js';
import { fetchFeatureBundles, type BundleFeatureInfo, type FeatureBundleCatalog } from './marketplaceClient.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const ANCHOR = 'marketplace-distribution.page';

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

export function DistributionComposerPage(): JSX.Element {
  const { t } = useTranslation('marketplace');
  const access = useFeatureAccess('marketplace');
  const { embedded } = useHub();
  const [catalog, setCatalog] = useState<FeatureBundleCatalog | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [pickedBundles, setPickedBundles] = useState<Set<string>>(new Set());
  const [pickedFeatures, setPickedFeatures] = useState<Set<string>>(new Set());
  const [name, setName] = useState('my-distribution');

  const loadCatalog = useCallback(() => {
    setCatalog(null);
    setCatalogFailed(false);
    void fetchFeatureBundles().then(setCatalog).catch(() => { setCatalogFailed(true); });
  }, []);
  useEffect(() => {
    if (!access.enabled) return;
    loadCatalog();
  }, [access.enabled, loadCatalog]);

  const bundles = useMemo(() => catalog?.bundles ?? [], [catalog]);
  const standalone = useMemo(() => catalog?.standalone ?? [], [catalog]);
  const core = useMemo(() => catalog?.core ?? [], [catalog]);

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
    // MKT-G2 — say which outcome actually happened; a rejected clipboard write is not silence.
    try {
      await navigator.clipboard.writeText(composed.manifest);
      toast.success(t('bundleCopied'));
    } catch {
      toast.error(t('bundleCopyFailed'));
    }
  };

  // Inside the Marketplace hub the hub owns the H1 + lede (and the tab back to the store).
  const header = embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('composerTitle')} lede={t('composerLede')} />;
  if (access.loading) {
    return <div className="u-gap-3 u-flex u-flex-col" data-walkthrough={ANCHOR}>{header}<Skeleton /></div>;
  }
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }
  const standaloneGroups = groupByCategory(standalone, t('bundleUncategorized'));
  const coreGroups = groupByCategory(core, t('bundleUncategorized'));

  return (
    <div className="u-gap-3 u-flex u-flex-col" data-walkthrough={ANCHOR}>
      {header}
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
          {bundles.length > 0 ? (
            <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="bundles-heading">
              <h2 id="bundles-heading" className="u-m-0">{t('bundlesSectionTitle')}</h2>
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

          {standalone.length > 0 ? (
            <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="standalone-heading">
              <h2 id="standalone-heading" className="u-m-0">{t('standaloneSectionTitle')}</h2>
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

          {core.length > 0 ? (
            <section className="u-gap-2 u-flex u-flex-col" aria-labelledby="core-heading">
              <h2 id="core-heading" className="u-m-0">{t('coreSectionTitle')}</h2>
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

          <section className="surface-card u-gap-2 u-p-4" aria-labelledby="manifest-heading">
            <h2 id="manifest-heading" className="u-m-0 u-fs-16">{t('bundleManifestLabel')}</h2>
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
          </section>
        </>
      )}
    </div>
  );
}
