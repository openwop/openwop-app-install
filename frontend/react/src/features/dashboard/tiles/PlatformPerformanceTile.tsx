/**
 * Platform performance tile (ADR 0377 Wave 2) — ad spend per platform
 * (`getKpi().byPlatform[]`) as distribution bars. Org-scoped; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { getKpi, type KpiSummary } from '../../campaign-connectors/campaignConnectorsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatCurrency } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileBars } from '../TileBars.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function PlatformPerformanceTile({ compact }: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<KpiSummary>((orgId) => sharedRead(`ad-kpi:${orgId}`, () => getKpi(orgId)));

  if (status === 'loading') return <SkeletonRows rows={compact ? 3 : 5} columns={['30%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const platforms = data?.byPlatform ?? [];
  if (status === 'no-org' || platforms.length === 0) return <p className="dash-tile__state muted">{t('platformEmpty')}</p>;

  const bars = [...platforms]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, compact ? 4 : 8)
    .map((p) => ({
      key: p.platform,
      label: p.platform,
      value: p.spend,
      display: formatCurrency(p.spend, data!.currency),
    }));

  return <TileBars bars={bars} />;
}
