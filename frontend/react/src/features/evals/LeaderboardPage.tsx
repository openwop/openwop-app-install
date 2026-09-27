/**
 * Model quality leaderboard (ADR 0123 Phase 4b).
 *
 * Read-only per-model ranking from the captured MessageFeedback (win-rate + Elo).
 * Gates on `useFeatureAccess('evals')`; org picker → a sorted DataTable. No PII —
 * model ids, vote counts, win-rate, and Elo only. Mirrors the ADR 0118 usage
 * dashboard precedent.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SelectField } from '../../ui/Field.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useOrgSelection } from '../../ui/useOrgSelection.js';
import { OrgSelectionState } from '../../ui/OrgSelectionState.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { fetchLeaderboard, listOrgs, type LeaderboardRow, type Org } from '../../client/evalsClient.js';

export function LeaderboardPage(): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const { embedded } = useHub(); // a tab inside the Models console → drop our own header
  const access = useFeatureAccess('evals');

  /**
   * The shared read. It kept `orgs` null on failure — the local version wrote
   * `setOrgs([])` beside an `orgsError` flag, so `orgs.length === 0` meant both
   * "none" and "could not read" and only the flag told them apart.
   *
   * Migrating also closed a hang this page had for the GENUINELY empty tenant:
   * there was no zero-org branch at all, so `orgId` stayed `''`, the load effect
   * never fired, `rows` stayed `null`, and the render fell to `SkeletonRows`
   * with no terminal condition. `OrgSelectionState` supplies that branch.
   */
  const { orgs, orgId, setOrgId, orgsFailed, retry: retryOrgs } = useOrgSelection<Org>(listOrgs, access.enabled);
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((id: string) => {
    setRows(null);
    setError(null);
    void fetchLeaderboard(id).then(setRows).catch(() => setError(t('loadError')));
  }, [t]);

  useEffect(() => { if (access.enabled && orgId) load(orgId); }, [access.enabled, orgId, load]);

  const columns = useMemo<DataColumn<LeaderboardRow>[]>(() => [
    { key: 'model', header: t('colModel'), sortValue: (r) => r.model, render: (r) => r.model },
    { key: 'up', header: t('colUp'), align: 'right', width: '80px', cellClassName: 'u-tabular', sortValue: (r) => r.up, render: (r) => f.number(r.up) },
    { key: 'down', header: t('colDown'), align: 'right', width: '80px', cellClassName: 'u-tabular', sortValue: (r) => r.down, render: (r) => f.number(r.down) },
    { key: 'winRate', header: t('colWinRate'), align: 'right', width: '120px', cellClassName: 'u-tabular', sortValue: (r) => r.winRate, render: (r) => f.percent(r.winRate) },
    { key: 'elo', header: t('colElo'), align: 'right', width: '90px', cellClassName: 'u-tabular', sortValue: (r) => r.elo, render: (r) => f.number(Math.round(r.elo)) },
  ], [t, f]);

  if (!access.enabled) {
    return (
      <>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ActivityIcon />} title={t('disabled')} />
      </>
    );
  }

  return (
    <>
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} actions={<Link className="btn-ghost btn-sm" to="/leaderboard/arena">{t('openArena')}</Link>} />}
      {orgs && orgs.length > 1 && (
        <SelectField label={t('ui:orgPickerLabel')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      <OrgSelectionState
        orgs={orgs}
        orgsFailed={orgsFailed}
        retry={retryOrgs}
        emptyBody={t('orgsEmptyClause')}
        failedBody={t('orgsFailedClause')}
        icon={<ActivityIcon />}
      >
      {error ? (
        // ONLY the error. Previously this rendered the error Notice AND fell
        // through to the table below, whose `rows ?? []` produced the empty state
        // "No rated turns yet — thumbs-up/down build this ranking" right beneath
        // it. A failed read may not say the leaderboard is empty, and of the two
        // the instructive card reads as the substantive answer.
        <>
          <Notice variant="error">{error}</Notice>
          <div><Button variant="quiet" size="sm" onClick={() => orgId && load(orgId)}>{t('retry')}</Button></div>
        </>
      ) : rows === null ? (
        <SkeletonRows rows={5} columns={['1fr', '80px', '80px', '120px', '90px']} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows ?? []}
          rowKey={(r) => r.model}
          caption={t('title')}
          initialSort={{ key: 'elo', dir: 'desc' }}
          empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />}
        />
      )}
      </OrgSelectionState>
    </>
  );
}
