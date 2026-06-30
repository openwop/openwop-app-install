/**
 * LLM usage/cost admin dashboard (ADR 0118 Phase 3b).
 *
 * Read-only per-(provider, model) token rollup over the recorded provider usage
 * (the Phase-2 write-through). Gates on `useFeatureAccess('usage-analytics')`; org
 * picker → a sorted DataTable of token counts. Token COUNTS only — no prompt content
 * or secrets ever cross this surface. Mirrors the Analytics page precedent.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../i18n/useFormat.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { SelectField } from '../../ui/Field.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { ActivityIcon } from '../../ui/icons/index.js';
import { fetchUsageRollup, listOrgs, type Org, type UsageRollupRow } from '../../client/usageAnalyticsClient.js';

export function UsageDashboardPage(): JSX.Element {
  const { t } = useTranslation('usage-analytics');
  const f = useFormat();
  const access = useFeatureAccess('usage-analytics');

  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState('');
  const [rows, setRows] = useState<UsageRollupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!access.enabled) return; // don't touch the network when the feature is off
    void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || (o[0]?.orgId ?? '')); }).catch(() => setOrgs([]));
  }, [access.enabled]);

  const load = useCallback((id: string) => {
    setRows(null);
    setError(null);
    void fetchUsageRollup(id).then(setRows).catch(() => setError(t('loadError')));
  }, [t]);

  useEffect(() => { if (access.enabled && orgId) load(orgId); }, [access.enabled, orgId, load]);

  const columns = useMemo<DataColumn<UsageRollupRow>[]>(() => [
    { key: 'provider', header: t('colProvider'), sortValue: (r) => r.provider, render: (r) => r.provider },
    { key: 'model', header: t('colModel'), sortValue: (r) => r.model, render: (r) => r.model },
    { key: 'input', header: t('colInput'), align: 'right', width: '140px', cellClassName: 'u-tabular', sortValue: (r) => r.inputTokens, render: (r) => f.number(r.inputTokens) },
    { key: 'output', header: t('colOutput'), align: 'right', width: '140px', cellClassName: 'u-tabular', sortValue: (r) => r.outputTokens, render: (r) => f.number(r.outputTokens) },
    { key: 'calls', header: t('colCalls'), align: 'right', width: '100px', cellClassName: 'u-tabular', sortValue: (r) => r.calls, render: (r) => f.number(r.calls) },
    // ADR 0118 Phase 3c — estimated cost (Phase 5 backend); 0 for unpriced models.
    { key: 'cost', header: t('colCost'), align: 'right', width: '110px', cellClassName: 'u-tabular', sortValue: (r) => r.costUsd ?? 0, render: (r) => f.currency(r.costUsd ?? 0) },
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
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
      {orgs && orgs.length > 1 && (
        <SelectField label={t('org')} className="u-w-auto" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
        </SelectField>
      )}
      {error && <Notice variant="error">{error}</Notice>}
      {rows === null && !error ? (
        <SkeletonRows rows={5} columns={['1fr', '1fr', '140px', '140px', '100px', '110px']} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows ?? []}
          rowKey={(r) => `${r.provider}:${r.model}`}
          caption={t('title')}
          initialSort={{ key: 'input', dir: 'desc' }}
          empty={<StateCard icon={<ActivityIcon />} title={t('empty')} body={t('emptyHint')} />}
        />
      )}
    </>
  );
}
