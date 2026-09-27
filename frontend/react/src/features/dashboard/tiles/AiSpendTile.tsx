/**
 * AI spend tile (ADR 0377 Wave 1) — recorded provider usage rollup (cost /
 * calls / top model) over the EXISTING usage-analytics client. Org-scoped via
 * `useOrgResource`; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { fetchUsageRollup, type UsageRollupRow } from '../../../client/usageAnalyticsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber, formatCurrency } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function AiSpendTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<UsageRollupRow[]>((orgId) => sharedRead(`usage-rollup:${orgId}`, () => fetchUsageRollup(orgId)));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const rows = data ?? [];
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('aiSpendEmpty')}</p>;

  const cost = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const calls = rows.reduce((a, r) => a + r.calls, 0);
  const top = [...rows].sort((a, b) => b.calls - a.calls)[0];

  return (
    <TileStats
      stats={[
        { label: t('aiSpendCost'), value: formatCurrency(cost, 'USD') },
        { label: t('aiSpendCalls'), value: formatNumber(calls) },
        { label: t('aiSpendTopModel'), value: top?.model ?? '—' },
      ]}
    />
  );
}
