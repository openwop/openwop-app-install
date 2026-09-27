/**
 * Commerce summary tile (ADR 0375 Phase 3) — revenue + orders + AOV from the
 * EXISTING commerce client (`commerceSummary`). Admin-tier, gated by the
 * `commerce` toggle. Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { commerceSummary, type CommerceSummary } from '../../commerce/commerceClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber, formatCurrency } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import { TileBars } from '../TileBars.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function CommerceSummaryTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<CommerceSummary>((orgId) => commerceSummary(orgId));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org' || !data) return <p className="dash-tile__state muted">{t('commerceEmpty')}</p>;

  const orders = Object.values(data.orderCounts).reduce((a, b) => a + b, 0);
  const statusBars = Object.entries(data.orderCounts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => ({ key: s, label: s, value: n }));
  return (
    <div>
      <TileStats
        stats={[
          { label: t('commerceRevenue'), value: formatCurrency(data.netRevenue, data.currency) },
          { label: t('commerceOrders'), value: formatNumber(orders) },
          { label: t('commerceAov'), value: formatCurrency(data.aov, data.currency) },
        ]}
      />
      {/* ADR 0377 Wave 2 — progressive render: order-status bars at full size (same fetch). */}
      {!compact && statusBars.length > 0 ? (
        <div className="u-mt-3">
          <TileBars bars={statusBars} />
        </div>
      ) : null}
    </div>
  );
}
