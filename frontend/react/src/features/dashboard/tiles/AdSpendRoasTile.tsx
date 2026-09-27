/**
 * Ad spend & ROAS tile (ADR 0377 Wave 1) — cross-platform ad KPIs over the
 * EXISTING campaign-connectors client. Org-scoped via `useOrgResource`.
 */
import { useTranslation } from 'react-i18next';
import { getKpi, type KpiSummary } from '../../campaign-connectors/campaignConnectorsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber, formatCurrency } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function AdSpendRoasTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<KpiSummary>((orgId) => sharedRead(`ad-kpi:${orgId}`, () => getKpi(orgId)));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org' || !data || data.recordCount === 0) return <p className="dash-tile__state muted">{t('adSpendEmpty')}</p>;

  // R2 CC-SP-3 — the SECOND consumer of the round-1 mixed-currency fix: this
  // tile kept labelling `$` while the page (same data) rendered the honest
  // unlabelled figure. Same rule, both consumers; unknown counts too.
  const unlabelled = data.currencyMixed === true || data.currencyKnown === false;
  return (
    <TileStats
      stats={[
        { label: t('adSpend'), value: unlabelled ? formatNumber(Math.round(data.totals.spend)) : formatCurrency(data.totals.spend, data.currency) },
        { label: t('adRoas'), value: `${formatNumber(data.totals.roas, { maximumFractionDigits: 2 })}×` },
        { label: t('adConversions'), value: formatNumber(data.totals.conversions) },
      ]}
    />
  );
}
