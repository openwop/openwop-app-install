/**
 * Cost by model tile (ADR 0377 Wave 2) — recorded AI cost per model
 * (usage rollup) as distribution bars. Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { fetchUsageRollup, type UsageRollupRow } from '../../../client/usageAnalyticsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatCurrency } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function CostByModelTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<UsageRollupRow[]>((orgId) => sharedRead(`usage-rollup:${orgId}`, () => fetchUsageRollup(orgId)));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const rows = (data ?? []).filter((r) => (r.costUsd ?? 0) > 0);
  if (status === 'no-org' || rows.length === 0) return <p className="dash-tile__state muted">{t('costByModelEmpty')}</p>;

  const bars = [...rows]
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, compact ? 4 : 8)
    .map((r) => ({
      key: `${r.provider}:${r.model}`,
      label: r.model,
      value: r.costUsd ?? 0,
      display: formatCurrency(r.costUsd ?? 0, 'USD'),
    }));

  return <TileBars bars={bars} />;
}
