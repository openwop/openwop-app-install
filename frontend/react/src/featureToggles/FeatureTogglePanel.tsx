/**
 * Feature-toggle admin screen (ADR 0001 §3.2) — modeled on myndhyve's
 * FeatureTogglePanel, extended with weighted multivariant traffic-splitting.
 *
 * Superadmin-only (the backend gates writes; a non-superadmin gets a 403 on the
 * admin list and sees the access notice). Per toggle: an Off/Beta/On control,
 * the randomization unit (user|tenant), and — when split — a variant editor
 * with per-variant weight inputs and live sum-to-100 validation. Variant→
 * behavior BINDINGS are administered here once candidate features ship
 * (Phase 4); this panel owns status + split + unit.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatNumber } from '../i18n/format.js';
import { PageHeader } from '../ui/PageHeader.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { toast } from '../ui/toast.js';
import {
  listToggleConfigs,
  saveToggleConfig,
  type BucketUnit,
  type FeatureToggleStatus,
  type ToggleConfig,
  type Variant,
} from '../client/featureTogglesClient.js';
import { useAllFeatureAccess } from './FeatureAccessContext.js';

const STATUSES: { value: FeatureToggleStatus; labelKey: 'statusOff' | 'statusBeta' | 'statusOn' }[] = [
  { value: 'off', labelKey: 'statusOff' },
  { value: 'beta', labelKey: 'statusBeta' },
  { value: 'on', labelKey: 'statusOn' },
];

function variantsSum(variants: Variant[] | undefined): number {
  return (variants ?? []).reduce((s, v) => s + (Number.isFinite(v.weight) ? v.weight : 0), 0);
}

function ToggleCard({
  config,
  onSaved,
}: {
  config: ToggleConfig;
  onSaved: (next: ToggleConfig) => void;
}): JSX.Element {
  const { t } = useTranslation('featureToggles');
  const [draft, setDraft] = useState<ToggleConfig>(config);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(config), [config]);

  const split = (draft.variants?.length ?? 0) > 0;
  const sum = variantsSum(draft.variants);
  const sumOk = !split || sum === 100;
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);

  const setStatus = (status: FeatureToggleStatus) => setDraft((d) => ({ ...d, status }));
  const setBucketUnit = (bucketUnit: BucketUnit) => setDraft((d) => ({ ...d, bucketUnit }));

  const setVariants = (variants: Variant[] | undefined) =>
    setDraft((d) => {
      const next = { ...d };
      if (variants && variants.length > 0) next.variants = variants;
      else delete next.variants;
      return next;
    });

  const enableSplit = () => setVariants([{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }]);
  const disableSplit = () => setVariants(undefined);
  const addVariant = () =>
    setVariants([...(draft.variants ?? []), { key: `V${(draft.variants?.length ?? 0) + 1}`, weight: 0 }]);
  const removeVariant = (i: number) => setVariants((draft.variants ?? []).filter((_, j) => j !== i));
  const editVariant = (i: number, patch: Partial<Variant>) =>
    setVariants((draft.variants ?? []).map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const save = useCallback(async () => {
    if (!sumOk) {
      toast.error(t('weightsMustSum'));
      return;
    }
    setSaving(true);
    try {
      const { id, ...body } = draft;
      const next = await saveToggleConfig(id, body);
      onSaved(next);
      toast.success(t('saved', { label: draft.label ?? draft.id }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [draft, sumOk, onSaved, t]);

  return (
    <div className="surface-card u-p-4 u-grid u-gap-3">
      <div className="u-flex u-justify-between u-gap-3 u-items-baseline">
        <div>
          <strong>{draft.label ?? draft.id}</strong>
          <code className="ftoggle-id">{draft.id}</code>
          {draft.description ? (
            <p className="ftoggle-desc">{draft.description}</p>
          ) : null}
        </div>
      </div>

      {/* Status segmented control */}
      <div className="segmented" role="group" aria-label={t('statusForAria', { id: draft.id })}>
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            className={draft.status === s.value ? 'is-active' : ''}
            aria-pressed={draft.status === s.value}
            onClick={() => setStatus(s.value)}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>

      {/* Randomization unit + split toggle */}
      <div className="u-flex u-gap-4 u-wrap u-items-center">
        <label className="u-iflex u-gap-2 u-items-center">
          <span className="u-ink-3">{t('randomizeBy')}</span>
          <select value={draft.bucketUnit} onChange={(e) => setBucketUnit(e.target.value as BucketUnit)}>
            <option value="user">{t('unitUser')}</option>
            <option value="tenant">{t('unitTenant')}</option>
          </select>
        </label>
        <label className="u-iflex u-gap-2 u-items-center">
          <input type="checkbox" checked={split} onChange={(e) => (e.target.checked ? enableSplit() : disableSplit())} />
          <span>{t('multivariantSplit')}</span>
        </label>
      </div>
      <p className="muted u-fs-11 u-mt-0 u-mb-0">{t('randomizeByHelp')}</p>

      {/* Variant editor */}
      {split ? (
        <div className="u-grid u-gap-2">
          {(draft.variants ?? []).map((v, i) => (
            <div key={i} className="u-flex u-gap-2 u-items-center">
              <input
                aria-label={t('variantKeyAria', { n: i + 1 })}
                value={v.key}
                placeholder={t('variantKeyPlaceholder')}
                className="ftoggle-key-input"
                onChange={(e) => editVariant(i, { key: e.target.value })}
              />
              <input
                aria-label={t('variantWeightAria', { n: i + 1 })}
                type="number"
                min={0}
                max={100}
                value={v.weight}
                className="ftoggle-weight-input"
                onChange={(e) => editVariant(i, { weight: Math.trunc(Number(e.target.value)) || 0 })}
              />
              <span className="u-ink-3">%</span>
              {v.bindings?.length ? (
                <span className="u-label-sm">
                  → {v.bindings.map((b) => `${b.slot}=${b.ref.name}@${b.ref.version}`).join(', ')}
                </span>
              ) : null}
              <button type="button" className="btn-ghost" onClick={() => removeVariant(i)} aria-label={t('removeVariantAria', { n: i + 1 })}>
                {t('removeVariant')}
              </button>
            </div>
          ))}
          <div className="u-flex u-gap-3 u-items-center">
            <button type="button" className="btn-ghost" onClick={addVariant}>
              {t('addVariant')}
            </button>
            <span className={sumOk ? 'u-ink-3' : 'u-text-danger'}>
              {t('variantSum', { sum: formatNumber(sum) })}{sumOk ? '' : t('variantSumMustBe100')}
            </span>
          </div>
          <div className="u-flex u-gap-2 u-items-center u-wrap u-fs-11">
            <span className="muted">{t('presetsLabel')}</span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setVariants([{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }])}>{t('preset5050')}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setVariants([{ key: 'stable', weight: 90 }, { key: 'beta', weight: 10 }])}>{t('presetBeta')}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setVariants([{ key: 'stable', weight: 95 }, { key: 'canary', weight: 5 }])}>{t('presetCanary')}</button>
          </div>
        </div>
      ) : null}

      <div className="action-bar u-flex u-justify-end u-gap-2">
        {draft.updatedAt ? (
          <span className="ftoggle-updated">
            {t('updatedAt', { when: formatDateTime(draft.updatedAt) })}
          </span>
        ) : null}
        <button type="button" className="btn-primary" disabled={!dirty || !sumOk || saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
}

export function FeatureTogglePanel(): JSX.Element {
  const { t } = useTranslation('featureToggles');
  const [configs, setConfigs] = useState<ToggleConfig[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-resolve the caller's assignments after a save so the nav (Sidebar/admin
  // rail/⌘K) reflects the new on/off/beta state immediately — no hard reload.
  const { reload } = useAllFeatureAccess();

  const load = useCallback(() => {
    setError(null);
    void listToggleConfigs()
      .then(setConfigs)
      .catch((err) => setError(err instanceof Error ? err.message : t('loadFailed')));
  }, [t]);
  useEffect(() => load(), [load]);

  const onSaved = useCallback((next: ToggleConfig) => {
    setConfigs((prev) => (prev ?? []).map((c) => (c.id === next.id ? next : c)));
    reload();
  }, [reload]);

  const byCategory = useMemo(() => {
    const groups = new Map<string, ToggleConfig[]>();
    for (const c of configs ?? []) {
      const cat = c.category ?? t('generalCategory');
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(c);
    }
    return [...groups.entries()];
  }, [configs, t]);

  return (
    <section className="u-grid u-gap-4">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        lede={t('lede')}
      />
      {error ? (
        <Notice variant="error">
          {t('superadminRequired', { error })}
        </Notice>
      ) : null}
      {configs === null && !error ? <Skeleton /> : null}
      {configs !== null && configs.length === 0 ? (
        <StateCard title={t('noTogglesTitle')} body={t('noTogglesBody')} />
      ) : null}
      {byCategory.map(([cat, items]) => (
        <div key={cat} className="u-grid u-gap-3">
          <h3 className="ftoggle-cat-heading">{cat}</h3>
          {items.map((c) => (
            <ToggleCard key={c.id} config={c} onSaved={onSaved} />
          ))}
        </div>
      ))}
    </section>
  );
}
