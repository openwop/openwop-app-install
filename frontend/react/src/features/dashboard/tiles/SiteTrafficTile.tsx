/**
 * Site traffic tile (ADR 0377 Wave 1) — sessions / pageviews / conversions over
 * the EXISTING analytics client. Org-scoped via `useOrgResource`; owns no data.
 */
import { useTranslation } from 'react-i18next';
import { getSummary, type AnalyticsSummary } from '../../analytics/analyticsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function SiteTrafficTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<AnalyticsSummary>((orgId) => getSummary(orgId).then((r) => r.summary));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['30%', '30%', '30%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  if (status === 'no-org' || !data || data.total === 0) return <p className="dash-tile__state muted">{t('trafficEmpty')}</p>;

  return (
    <TileStats
      stats={[
        // ANL-UX-15 — `sessions` is omitted by the server when no row in the window
        // carried a sessionKey; a confident 0 here would be the claim the page stopped making.
        ...(data.sessions !== undefined ? [{ label: t('trafficSessions'), value: formatNumber(data.sessions) }] : []),
        { label: t('trafficPageviews'), value: formatNumber(data.byType.pageview) },
        { label: t('trafficConversions'), value: formatNumber(data.byType.conversion) },
      ]}
    />
  );
}
