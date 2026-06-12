/**
 * Consent (host-extension product feature — ADR 0020).
 *
 * Gates on useFeatureAccess('consent'). An org picker → the per-tenant policy
 * (regulated regions + default mode) → a data-subject (GDPR) lookup/erase →
 * the consent records. Erase cascades to downstream subject data (Analytics).
 */
import { useCallback, useEffect, useState } from 'react';
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
  return (
    <>
      {c.analytics ? <span className="chip chip--success">analytics</span> : null}
      {c.marketing ? <span className="chip chip--success">marketing</span> : null}
      {!c.analytics && !c.marketing ? <span className="chip chip--muted">necessary only</span> : null}
    </>
  );
}

export function ConsentPage(): JSX.Element {
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
    void getPolicy(org).then((p) => { setPolicyState(p); setRegions(p.regulatedRegions.join(', ')); setMode(p.defaultMode); }).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load policy.'));
    void listRecords(org).then(setRecords).catch(() => setRecords([]));
  }, []);
  useEffect(() => { if (orgId) load(orgId); }, [orgId, load]);

  const savePolicy = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    try {
      const regulatedRegions = regions.split(',').map((r) => r.trim()).filter(Boolean);
      await setPolicy(orgId, { regulatedRegions, defaultMode: mode });
      toast.success('Policy saved');
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed.'); }
    finally { setBusy(false); }
  }, [orgId, regions, mode]);

  const doLookup = useCallback(async () => {
    if (!orgId || !lookupKey.trim()) return;
    try { const r = await getSubject(orgId, lookupKey.trim()); setLookup(r ?? 'none'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Lookup failed.'); }
  }, [orgId, lookupKey]);

  const doErase = useCallback(async () => {
    if (!orgId || !lookupKey.trim()) return;
    if (!window.confirm(`Erase all data for subject "${lookupKey.trim()}"? GDPR data-subject delete — cannot be undone.`)) return;
    try { await deleteSubject(orgId, lookupKey.trim()); setLookup(null); setLookupKey(''); load(orgId); toast.success('Subject data erased'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Erase failed.'); }
  }, [orgId, lookupKey, load]);

  if (access.loading) return <Skeleton />;
  if (!access.enabled) {
    return <StateCard icon={<LockIcon />} title="Consent is not enabled" body="Ask an administrator to enable the Consent feature for this tenant." />;
  }

  const orgPicker = orgs && orgs.length > 0 ? (
    <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="u-w-auto" aria-label="Organization">
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined;

  return (
    <div className="u-gap-3 u-flex u-flex-col">
      <PageHeader eyebrow="Workspace" title="Consent" lede="Region-aware consent policy + data-subject (GDPR) tools." actions={orgPicker} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {!orgs ? <Skeleton /> : orgs.length === 0 ? (
        <StateCard icon={<GlobeIcon />} title="No organizations" body="Create an organization first — consent policy belongs to an org." />
      ) : (
        <>
          <div className="surface-card u-p-4 surface-form">
            <label className="u-grid u-gap-1">
              <span className="u-label-sm">Regulated regions (comma-separated)</span>
              <input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="EU, CA" />
            </label>
            <label className="u-grid u-gap-1 is-narrow">
              <span className="u-label-sm">Default mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as DefaultMode)}>
                <option value="opt-in">opt-in (fail-closed)</option>
                <option value="opt-out">opt-out</option>
              </select>
            </label>
            <button type="button" className="btn-primary" disabled={busy || !policy} onClick={() => void savePolicy()}><SaveIcon /> Save policy</button>
          </div>

          <div className="surface-card u-gap-2">
            <strong><ShieldIcon /> Data subject (GDPR)</strong>
            <div className="surface-form">
              <label className="u-grid u-gap-1">
                <span className="u-label-sm">Subject key</span>
                <input value={lookupKey} onChange={(e) => setLookupKey(e.target.value)} placeholder="visitor cookie / user id" />
              </label>
              <div className="action-bar">
                <button type="button" className="btn-ghost" disabled={!lookupKey.trim()} onClick={() => void doLookup()}>Look up</button>
                <button type="button" className="btn-ghost" disabled={!lookupKey.trim()} onClick={() => void doErase()}><TrashIcon /> Erase</button>
              </div>
            </div>
            {lookup === 'none' ? <span className="u-label-sm">No consent record for that subject — downstream data (if any) is still erased.</span>
              : lookup ? (
                <div className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                  <CatChips c={lookup.categories} />
                  {lookup.region ? <span className="chip chip--muted">{lookup.region}</span> : null}
                  <span className="u-label-sm">{new Date(lookup.ts).toLocaleString()}</span>
                </div>
              ) : null}
          </div>

          <div className="surface-card u-gap-2">
            <strong>Consent records</strong>
            {!records ? <Skeleton /> : records.length === 0 ? <span className="u-label-sm">No consent records yet.</span> : records.map((r) => (
              <div key={r.subjectKey} className="surface-inset u-flex u-gap-2 u-items-center u-wrap">
                <code className="u-flex-1">{r.subjectKey}</code>
                <CatChips c={r.categories} />
                {r.region ? <span className="chip chip--muted">{r.region}</span> : null}
                <span className="u-label-sm" title={r.ts}>{new Date(r.ts).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
