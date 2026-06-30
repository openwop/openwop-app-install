/**
 * Model quality leaderboard (ADR 0123 Phase 4b).
 *
 * Read-only per-model ranking from the captured MessageFeedback (win-rate + Elo).
 * Gates on `useFeatureAccess('evals')`; org picker → a sorted DataTable. No PII —
 * model ids, vote counts, win-rate, and Elo only. Mirrors the ADR 0118 usage
 * dashboard precedent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { useHub } from '../../chrome/hubContext.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SelectField } from '../../ui/Field.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { fetchLeaderboard, listOrgs, type LeaderboardRow, type Org } from '../../client/evalsClient.js';

export function LeaderboardPage(): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const { embedded } = useHub(); // a tab inside the Models console → drop our own header
  const access = useFeatureAccess('evals');

  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return; // don't touch the network when the feature is off
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

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
      {embedded ? null : <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />}
      {orgs && orgs.length > 1 && (
        <SelectField label={t('org')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {error && <Notice variant="error">{error}</Notice>}
      {rows === null && !error ? (
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
    </>
  );
}
