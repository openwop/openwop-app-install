/**
 * ADR 1136 P3b — the browser sessions of a workspace. A read surface over the
 * closed session projection: the task, the status, the site and the step count,
 * each row opening the trajectory. Nothing here drives a browser.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Panel } from '../../ui/layout.js';
import { Button } from '../../ui/Button.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { formatRelativeTime } from '../../i18n/format.js';
import { GlobeIcon } from '../../ui/icons/index.js';
import { listOrgs, type Organization } from '../../client/accessClient.js';
import { hostOf, listSessions, type SessionSummary } from './computerUseClient.js';
import { SessionStatusBadge } from './SessionStatusBadge.js';

export function ComputerUseSessionsPage(): JSX.Element {
  const { t } = useTranslation('computer-use');
  const access = useFeatureAccess('computer-use');
  const [searchParams, setSearchParams] = useSearchParams();
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } =
    useOrgSelection<Organization>(listOrgs, access.enabled, searchParams.get('org') ?? '');
  // null = loading, 'failed' = the read failed (never collapsed into "none").
  const [rows, setRows] = useState<SessionSummary[] | null | 'failed'>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!orgId) return;
    let live = true;
    setRows(null);
    listSessions(orgId)
      .then((r) => { if (live) setRows([...r].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); })
      .catch(() => { if (live) setRows('failed'); });
    return () => { live = false; };
  }, [orgId, reload]);

  const selectOrg = useCallback((id: string): void => {
    setOrgId(id);
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('org', id); return n; }, { replace: true });
  }, [setOrgId, setSearchParams]);

  const header = <PageHeader eyebrow={t('eyebrow')} title={t('listTitle')} lede={t('listLede')} actions={orgs && orgs.length > 1 ? (
    <select value={orgId} onChange={(e) => selectOrg(e.target.value)} className="u-w-auto" aria-label={t('ui:orgPickerLabel')}>
      {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
    </select>
  ) : undefined} />;

  if (access.loading) return <div className="u-grid u-gap-4">{header}<Skeleton /></div>;

  const columns: DataColumn<SessionSummary>[] = [
    {
      key: 'task', header: t('colTask'), rowHeader: true,
      render: (s) => <Link to={`/computer-use/sessions/${encodeURIComponent(s.sessionId)}?org=${encodeURIComponent(orgId)}`}>{s.task}</Link>,
    },
    { key: 'status', header: t('colStatus'), render: (s) => <SessionStatusBadge status={s.status} />, sortValue: (s) => s.status },
    { key: 'site', header: t('colSite'), render: (s) => hostOf(s.startUrl), cellClassName: 'muted' },
    { key: 'steps', header: t('colSteps'), render: (s) => s.steps, sortValue: (s) => s.steps, align: 'right' },
    { key: 'updated', header: t('colUpdated'), render: (s) => formatRelativeTime(s.updatedAt), sortValue: (s) => s.updatedAt, cellClassName: 'muted' },
  ];

  return (
    <section className="u-grid u-gap-4" data-walkthrough="computer-use.page">
      {header}
      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
      >
        {!orgId ? <Skeleton /> : (
          <Panel>
            {rows === null ? (
              <div role="status" aria-busy="true" aria-label={t('tableCaption')} className="u-flex u-flex-col u-gap-2">
                {['80%', '65%'].map((w, i) => <Skeleton key={i} width={w} height={18} />)}
              </div>
            ) : rows === 'failed' ? (
              <StateCard
                announce
                title={t('loadFailedTitle')}
                body={t('loadFailedBody')}
                action={<Button variant="secondary" onClick={() => setReload((n) => n + 1)}>{t('retry')}</Button>}
              />
            ) : rows.length === 0 ? (
              <StateCard icon={<GlobeIcon size={20} />} title={t('emptyTitle')} body={t('emptyBody')} />
            ) : (
              <DataTable caption={t('tableCaption')} columns={columns} rows={rows} rowKey={(s) => s.sessionId} stack />
            )}
          </Panel>
        )}
      </OrgSelectionState>
    </section>
  );
}
