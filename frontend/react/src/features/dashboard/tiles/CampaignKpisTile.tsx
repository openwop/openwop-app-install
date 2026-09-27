/**
 * Campaign KPIs tile (ADR 0375 Phase 3) — impressions / clicks / conversions
 * summed across platforms from the EXISTING campaign-intel client (`getOverview`).
 * Admin-tier, gated by the `campaign-intel` toggle. Org-scoped; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { getOverview } from '../../campaign-intel/campaignIntelClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

type Overview = Awaited<ReturnType<typeof getOverview>>;

export default function CampaignKpisTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<Overview>((orgId) => getOverview(orgId));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org' || !data) return <p className="dash-tile__state muted">{t('campaignEmpty')}</p>;

  const sum = (key: 'impressions' | 'clicks' | 'conversions'): number => data.funnel.reduce((a, r) => a + r[key], 0);
  if (data.funnel.length === 0) return <p className="dash-tile__state muted">{t('campaignEmpty')}</p>;

  return (
    <TileStats
      stats={[
        { label: t('campaignImpressions'), value: formatNumber(sum('impressions')) },
        { label: t('campaignClicks'), value: formatNumber(sum('clicks')) },
        { label: t('campaignConversions'), value: formatNumber(sum('conversions')) },
      ]}
    />
  );
}
