/**
 * Custom domains (ADR 0295 / FNL-UX-3) — the management surface: register a
 * hostname, publish the DNS TXT ownership record, verify, watch status.
 * TLS/routing for the hostname stay operator infrastructure (DEPLOY.md).
 * Gated by the `custom-domains` toggle.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { GlobeIcon } from '../../ui/icons/index.js';
import { listOrgs, listDomains, addDomain, verifyDomain, removeDomain, type CustomDomain, type Org } from './domainsClient.js';

const statusChip = (status: CustomDomain['status']): string =>
  status === 'live' ? 'chip chip--success' : status === 'failed' ? 'chip chip--warning' : 'chip chip--muted';

// §4.5 collection kit — the status facet reuses the existing status_* chip keys,
// so its option labels can't drift from the status column.
const DOMAIN_STATUSES = ['pending', 'live', 'failed'] as const;

export function DomainsPage(): JSX.Element {
  const { t } = useTranslation('custom-domains');
  const { t: tc } = useTranslation('common');
  // `useFeatureAccess` returns an OBJECT, so the previous `const enabled = …`
  // + `if (!enabled)` was ALWAYS truthy: the "not enabled" branch below was dead
  // and this page rendered regardless of its toggle. The test mocked the hook as
  // `() => true`, which is why nothing caught it. Destructure the flag, and gate
  // the org read on it so a disabled feature touches no network.
  const access = useFeatureAccess('custom-domains');

  // HG-4 — this page hand-rolled the org read (`.catch(() => setOrgs([]))`), so it
  // sat OUTSIDE the ratchet that protects the other adopters: a failed read became
  // an empty org list, `orgId` stayed '', the domain rows never loaded, and the
  // selector answered "No workspaces" — an answer, about a list that was never read.
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [rows, setRows] = useState<CustomDomain[] | null>(null);
  // Same reasoning as `orgsFailed` above, one level down: a failed domain read fell to
  // `[]` and drew "No domains yet — add a hostname above to start verification", which
  // invites re-adding a hostname that may already be registered and mid-verification.
  const [rowsFailed, setRowsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  // §4.5 collection kit — gated search + status facet feeding a separate memo
  // over the unfiltered rows.
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | CustomDomain['status']>('');
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((d) =>
      (!q || d.hostname.toLowerCase().includes(q))
      && (!statusFilter || d.status === statusFilter));
  }, [rows, query, statusFilter]);

  const load = useCallback(async (org: string) => {
    if (!org) return;
    setRowsFailed(false);
    try { setRows(await listDomains(org)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : t('loadFailed')); setRows([]); setRowsFailed(true); }
  }, [t]);
  useEffect(() => { if (orgId) void load(orgId); }, [orgId, load]);

  const add = useCallback(async () => {
    if (!orgId || !hostname.trim()) return;
    setBusy(true);
    try { await addDomain(orgId, hostname.trim()); setHostname(''); toast.success(t('domainAdded')); await load(orgId); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('addFailed')); }
    finally { setBusy(false); }
  }, [orgId, hostname, load, t]);

  const verify = useCallback(async (d: CustomDomain) => {
    try {
      const next = await verifyDomain(orgId, d.hostname);
      toast.success(next.status === 'live' ? t('verifiedLive') : t('verifyRan', { status: next.status }));
      await load(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('verifyFailed')); }
  }, [orgId, load, t]);

  const remove = useCallback(async (d: CustomDomain) => {
    if (!(await confirm({ title: t('deleteConfirm', { hostname: d.hostname }), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await removeDomain(orgId, d.hostname); await load(orgId); toast.success(t('domainDeleted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const copyToken = useCallback(async (d: CustomDomain) => {
    try { await navigator.clipboard.writeText(d.verificationToken); toast.success(t('tokenCopied')); }
    catch { toast.error(t('copyFailed')); }
  }, [t]);

  const columns = useMemo<DataColumn<CustomDomain>[]>(() => [
    { key: 'hostname', header: t('colHostname'), render: (d) => <code>{d.hostname}</code>, sortValue: (d) => d.hostname },
    { key: 'status', header: t('colStatus'), render: (d) => <span className={statusChip(d.status)}>{t(`status_${d.status}`)}</span>, sortValue: (d) => d.status },
    { key: 'record', header: t('colRecord'), render: (d) => (
      <span className="action-bar">
        <code>{`_openwop-verify.${d.hostname}`}</code>
        <Button variant="quiet" onClick={() => void copyToken(d)} aria-label={t('copyTokenLabel', { hostname: d.hostname })}>{t('copyToken')}</Button>
      </span>
    ) },
    { key: 'checked', header: t('colChecked'), render: (d) => d.lastError ? <span className="chip chip--warning" title={d.lastError}>{t('lastErrorChip')}</span> : (d.lastCheckedAt ? d.lastCheckedAt.slice(0, 16).replace('T', ' ') : '—') },
    { key: 'actions', header: '', render: (d) => (
      <span className="action-bar">
        <Button variant="quiet" onClick={() => void verify(d)}>{t('verifyNow')}</Button>
        <Button variant="quiet" onClick={() => void remove(d)} aria-label={t('deleteRowLabel', { hostname: d.hostname })}>{t('common:delete')}</Button>
      </span>
    ) },
  ], [t, copyToken, verify, remove]);

  // The toggle has not resolved yet. NOT a `<StateCard title loading />`: its only
  // text is the page title, so it reads as a terminal answer, and it unmounts
  // `PageHeader`. Corpus majority instead — keep the header, swap the body for the
  // same shape the table below renders while its own read is in flight.
  if (access.loading) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="domains.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <SkeletonRows rows={3} columns={["30%", "15%", "35%", "20%"]} />
      </section>
    );
  }
  if (!access.enabled) {
    return (
      <section className="u-grid u-gap-4" data-walkthrough="domains.page">
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} />
        <StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </section>
    );
  }

  return (
    <section className="u-grid u-gap-4" data-walkthrough="domains.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      <Notice variant="info">{t('howItWorks')}</Notice>

      {/* HG-4 — the noun and the branch ORDER (failed → zero-orgs → children) are
          `OrgSelectionState`'s, not this page's. It wraps the FORM as well as the
          table because the form is what carried the false claim: its selector read
          "No workspaces" whenever `orgs` was empty, which a failed read also
          produced — and with no org there is nothing an "Add domain" submit could
          write to anyway. Both org states stay above the loading sentinel: `orgId`
          gates the rows read, so with none it never fires and the skeleton below
          would render forever. */}
      <OrgSelectionState orgs={orgs} orgsFailed={orgsFailed} retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')} failedBody={t('orgsFailedClause')} icon={<GlobeIcon />}>
      <form className="surface-card u-p-4 surface-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('ui:orgPickerLabel')}</span>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs === null ? <option value="">{t('ui:orgPickerLoading')}</option> : null}
            {(orgs ?? []).map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
          </select>
        </label>
        <label className="u-grid u-gap-1">
          <span className="u-label-sm">{t('fieldHostname')}</span>
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="pages.example.com" autoComplete="off" spellCheck={false} />
        </label>
        <Button variant="primary" type="submit" disabled={busy || !orgId || !hostname.trim()}>{t('addDomain')}</Button>
      </form>

      {rows === null ? <SkeletonRows rows={3} columns={["30%", "15%", "35%", "20%"]} /> : rowsFailed ? (
        <StateCard announce title={tc('loadFailedTitle')} body={tc('loadFailedBody')}
          action={<Button variant="secondary" size="sm" onClick={() => { if (orgId) void load(orgId); }}>{t('retry')}</Button>} />
      ) : rows.length === 0 ? (
        <StateCard title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <>
          {rows.length > 3 ? (
            <div className="filterbar" role="group" aria-label={t('filterGroup')}>
              <input
                type="search"
                className="ui-input filterbar-search"
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterAria')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select className="ui-input filterbar-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | CustomDomain['status'])} aria-label={t('filterStatusLabel')}>
                <option value="">{t('allStatuses')}</option>
                {DOMAIN_STATUSES.map((s) => <option key={s} value={s}>{t(`status_${s}`)}</option>)}
              </select>
            </div>
          ) : null}
          {visibleRows.length === 0 ? (
            <StateCard title={t('noMatchTitle')} body={t('noMatchBody')} action={<Button variant="secondary" onClick={() => { setQuery(''); setStatusFilter(''); }}>{t('clearFilters')}</Button>} />
          ) : (
            <DataTable caption={t('captionDomains')} columns={columns} rows={visibleRows} rowKey={(d) => d.hostname} />
          )}
        </>
      )}
      </OrgSelectionState>
    </section>
  );
}
