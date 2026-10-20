/**
 * Custom domains (ADR 0295 / FNL-UX-3) — the management surface: register a
 * hostname, publish the DNS TXT ownership record, verify, watch status.
 * ADR 0906 P4 adds the second axis: HTTPS at the edge (its own chip), every DNS
 * record the domain needs with copy buttons, plain-language issues, "Check
 * again", and the force-remove escape. Under the `manual` provider HTTPS stays
 * the operator's job and the page says so. Gated by the `custom-domains` toggle.
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
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import {
  listOrgs, listDomainPage, addDomain, verifyDomain, removeDomain, retryDomain, forceRemoveDomain, dnsRecordsFor,
  type CustomDomain, type DnsRecord, type EdgeSummary, type EdgeTlsState, type Org,
} from './domainsClient.js';

const statusChip = (status: CustomDomain['status']): string =>
  status === 'live' ? 'chip chip--success' : status === 'failed' ? 'chip chip--warning' : 'chip chip--muted';

const tlsChip = (tls: EdgeTlsState): string =>
  tls === 'active' ? 'chip chip--success' : tls === 'failed' ? 'chip chip--danger' : tls === 'releasing' ? 'chip chip--warning' : 'chip chip--muted';

/** States in which "Check again" can change something. */
const RETRYABLE: ReadonlySet<EdgeTlsState> = new Set(['awaiting_dns', 'provisioning', 'failed']);
/** ADR 0906 D4 — failed release sweeps before an org admin may force removal (server-enforced). */
const FORCE_AFTER = 3;
/** Issue reasons with their own plain-language copy; anything else reads as `issue_unknown`. */
const KNOWN_ISSUES = new Set(['dns_not_configured', 'provider_error', 'release_incomplete', 'provider_changed', 'CAA', 'RATE_LIMITED', 'CONFIG']);

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
  const [edge, setEdge] = useState<EdgeSummary | null>(null);
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
    try { const page = await listDomainPage(org); setRows(page.domains); setEdge(page.edge); setError(null); }
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
    try {
      const outcome = await removeDomain(orgId, d.hostname);
      await load(orgId);
      toast.success(outcome === 'releasing' ? t('domainReleasing') : t('domainDeleted'));
    } catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const forceRemove = useCallback(async (d: CustomDomain) => {
    if (!(await confirm({ title: t('forceRemoveConfirm', { hostname: d.hostname }), danger: true, confirmLabel: t('forceRemove') }))) return;
    try { await forceRemoveDomain(orgId, d.hostname); await load(orgId); toast.success(t('domainDeleted')); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('deleteFailed')); }
  }, [orgId, load, t]);

  const checkAgain = useCallback(async (d: CustomDomain) => {
    try {
      const next = await retryDomain(orgId, d.hostname);
      toast.success(t('checkAgainDone', { status: t(`tls_${next.edge?.tls ?? 'not_requested'}`) }));
      await load(orgId);
    } catch (e) { toast.error(e instanceof Error ? e.message : t('checkAgainFailed')); }
  }, [orgId, load, t]);

  const copyRecord = useCallback((r: DnsRecord) => { void copyToClipboard(r.value, t('recordCopied')); }, [t]);

  const manual = edge === null || edge.provider === 'manual';

  const issueText = useCallback((reason: string): string =>
    t(KNOWN_ISSUES.has(reason) ? `issue_${reason}` : 'issue_unknown'), [t]);

  const renderRecord = useCallback((r: DnsRecord, hostname: string, alternative = false) => (
    <li key={`${r.purpose}-${r.type}-${alternative ? 'alt' : 'main'}`} className="u-grid u-gap-1">
      <span className="u-label-sm">{alternative ? t('recordRoutingApex') : t(`record_${r.purpose}`)}</span>
      <span className="action-bar">
        <span className="chip chip--static">{r.type}</span>
        <code>{r.name}</code>
        <code>{r.value}</code>
        <Button variant="quiet" onClick={() => copyRecord(r)}
          aria-label={t('copyRecordLabel', { type: r.type, purpose: t(`record_${r.purpose}`), hostname })}>{t('copyValue')}</Button>
      </span>
    </li>
  ), [t, copyRecord]);

  const columns = useMemo<DataColumn<CustomDomain>[]>(() => [
    { key: 'hostname', header: t('colHostname'), render: (d) => <code>{d.hostname}</code>, sortValue: (d) => d.hostname },
    { key: 'status', header: t('colStatus'), render: (d) => <span className={statusChip(d.status)}>{t(`status_${d.status}`)}</span>, sortValue: (d) => d.status },
    { key: 'https', header: t('colHttps'), render: (d) => {
      if (!d.edge) {
        return manual
          ? <span className="chip chip--muted" title={t('tlsOperatorHint')}>{t('tls_operator')}</span>
          : <span className="chip chip--muted">{t('tls_not_requested')}</span>;
      }
      const issue = d.edge.issue;
      return (
        <span className="u-grid u-gap-1">
          <span className={tlsChip(d.edge.tls)}>{t(`tls_${d.edge.tls}`)}</span>
          {issue ? <span className="u-text-sm" title={issue.detail}>{issueText(issue.reason)}</span> : null}
        </span>
      );
    }, sortValue: (d) => d.edge?.tls ?? '' },
    { key: 'records', header: t('colRecords'), render: (d) => {
      const { records, alternative } = dnsRecordsFor(d, edge);
      return (
        <details>
          <summary>{t('recordsSummary', { count: records.length })}</summary>
          <ul className="u-grid u-gap-2">
            {records.map((r) => renderRecord(r, d.hostname))}
            {alternative ? renderRecord(alternative, d.hostname, true) : null}
          </ul>
          {!manual && !records.some((r) => r.purpose === 'routing') ? <p className="u-text-sm">{t('routingUnknown')}</p> : null}
        </details>
      );
    } },
    { key: 'checked', header: t('colChecked'), render: (d) => d.lastError ? <span className="chip chip--warning" title={d.lastError}>{t('lastErrorChip')}</span> : (d.lastCheckedAt ? d.lastCheckedAt.slice(0, 16).replace('T', ' ') : '—') },
    { key: 'actions', header: '', render: (d) => (
      <span className="action-bar">
        <Button variant="quiet" onClick={() => void verify(d)}>{t('verifyNow')}</Button>
        {d.edge && RETRYABLE.has(d.edge.tls)
          ? <Button variant="quiet" onClick={() => void checkAgain(d)} aria-label={t('checkAgainLabel', { hostname: d.hostname })}>{t('checkAgain')}</Button>
          : null}
        {d.edge?.tls === 'releasing' && (d.edge.releaseAttempts ?? 0) >= FORCE_AFTER
          ? <Button variant="quiet" onClick={() => void forceRemove(d)} aria-label={t('forceRemoveLabel', { hostname: d.hostname })}>{t('forceRemove')}</Button>
          : <Button variant="quiet" onClick={() => void remove(d)} aria-label={t('deleteRowLabel', { hostname: d.hostname })}
              disabled={d.edge?.tls === 'releasing'}>{t('common:delete')}</Button>}
      </span>
    ) },
  ], [t, verify, remove, forceRemove, checkAgain, manual, edge, issueText, renderRecord]);

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
      {edge && !edge.ready ? (
        <Notice variant="warning">
          {t('edgeNotReady')}{'reason' in edge && edge.reason ? <> <span className="u-text-sm">({edge.reason})</span></> : null}
        </Notice>
      ) : null}
      <Notice variant="info">{manual ? t('howItWorks') : t('howItWorksAuto')}</Notice>

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
