/**
 * Consent (host-extension product feature — ADR 0020).
 *
 * Gates on useFeatureAccess('consent'). An org picker → the per-tenant policy
 * (regulated regions + default mode) → a data-subject (GDPR) lookup/erase →
 * the consent records. Erase cascades to downstream subject data (Analytics).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../../ui/confirm.js';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon, LockIcon, SaveIcon, ShieldIcon, TrashIcon } from '../../ui/icons/index.js';
import {
  deleteSubject, getPolicy, getSubject, listOrgs, listRecords, setPolicy,
  type ConsentPolicy, type ConsentRecord, type DefaultMode, type Org,
} from './consentClient.js';

function CatChips({ c }: { c: ConsentRecord['categories'] }): JSX.Element {
  const { t } = useTranslation('consent');
  return (
    <>
      {c.analytics ? <span className="chip chip--success">{t('categoryAnalytics')}</span> : null}
      {c.marketing ? <span className="chip chip--success">{t('categoryMarketing')}</span> : null}
      {!c.analytics && !c.marketing ? <span className="chip chip--muted">{t('categoryNecessaryOnly')}</span> : null}
    </>
  );
}

export function ConsentPage(): JSX.Element {
  const { t } = useTranslation('consent');
  const f = useFormat();
  const access = useFeatureAccess('consent');
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [policy, setPolicyState] = useState<ConsentPolicy | null>(null);
  const [regions, setRegions] = useState('');
  const [mode, setMode] = useState<DefaultMode>('opt-in');
  const [records, setRecords] = useState<ConsentRecord[] | null>(null);
  const [lookupKey, setLookupKey] = useState('');
  const [lookup, setLookup] = useState<ConsentRecord | 'none' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!access.enabled) return;
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const load = useCallback((org: string) => {
    setError(null); setRecords(null); setLookup(null);
    void getPolicy(org).then((p) => { setPolicyState(p); setRegions(p.regulatedRegions.join(', ')); setMode(p.defaultMode); }).catch((e) => setError(e instanceof Error ? e.message : t('loadPolicyFailed')));
    void listRecords(org).then(setRecords).catch(() => setRecords([]));
  }, [t]);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const savePolicy = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const regulatedRegions = regions.split(',').map((r) => r.trim()).filter(Boolean);
      await setPolicy(orgId, { regulatedRegions, defaultMode: mode });
      toast.success(t('policySaved'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('saveFailed')); }
    finally { setBusy(false); }
  }, [orgId, regions, mode, t]);

  const doLookup = useCallback(async () => {
    if (!orgId || !lookupKey.trim()) return;
    try { const r = await getSubject(orgId, lookupKey.trim()); setLookup(r ?? 'none'); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('lookupFailed')); }
  }, [orgId, lookupKey, t]);

  const doErase = useCallback(async () => {
    if (!orgId || !lookupKey.trim()) return;
    if (!(await confirm({ title: t('eraseConfirm', { subjectKey: lookupKey.trim() }), danger: true }))) return;
    try { await deleteSubject(orgId, lookupKey.trim()); setLookup(null); setLookupKey(''); load(orgId); toast.success(t('subjectErased')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('eraseFailed')); }
  }, [orgId, lookupKey, load, t]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label={t('orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title={t('noOrgsTitle')} body={t('noOrgsBody')} />
      ) : (
        <>
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">{t('regulatedRegionsLabel')}</span>
              <input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder={t('regulatedRegionsPlaceholder')} />
            </label>
            <label className="u-grid u-gap-1 is-narrow">
              <span className="u-label-sm">{t('defaultModeLabel')}</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as DefaultMode)}>
                <option value="opt-in">{t('defaultModeOptInLabel')}</option>
                <option value="opt-out">{t('defaultModeOptOutLabel')}</option>
              </select>
            </label>
            <button type="button" className="btn-primary" disabled={busy || !policy} onClick={() => void savePolicy()}><SaveIcon /> {t('savePolicy')}</button>
          </div>

          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0 u-flex u-gap-1 u-items-center"><ShieldIcon /> {t('dataSubjectTitle')}</h2>
            <div className="surface-form">
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">{t('subjectKeyLabel')}</span>
                <input value={lookupKey} onChange={(e) => setLookupKey(e.target.value)} placeholder={t('subjectKeyPlaceholder')} />
              </label>
              <div className="action-bar">
                <button type="button" className="btn-ghost" disabled={!lookupKey.trim()} onClick={() => void doLookup()}>{t('lookup')}</button>
                <button type="button" className="btn-ghost u-text-danger" disabled={!lookupKey.trim()} onClick={() => void doErase()}><TrashIcon /> {t('erase')}</button>
              </div>
            </div>
            {lookup === 'none' ? <span className="u-label-sm">{t('lookupNoRecord')}</span>
              : lookup ? (
                <div className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                  <CatChips c={lookup.categories} />
                  {lookup.region ? <span className="chip chip--muted">{lookup.region}</span> : null}
                  <span className="u-label-sm">{f.dateTime(lookup.ts)}</span>
                </div>
              ) : null}
          </div>

          <div className="surface-card u-gap-2">
            <h2 className="u-fs-16 u-m-0">{t('recordsTitle')}</h2>
            {!records ? <Skeleton /> : records.length === 0 ? <span className="u-label-sm">{t('noRecords')}</span> : records.map((r) => (
              <div key={r.subjectKey} className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                <code className="u-flex-1">{r.subjectKey}</code>
                <CatChips c={r.categories} />
                {r.region ? <span className="chip chip--muted">{r.region}</span> : null}
                <span className="u-label-sm" title={r.ts}>{f.date(r.ts)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
