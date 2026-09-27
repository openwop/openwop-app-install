/**
 * Funnel daily tile (ADR 0377 Wave 2) — daily completions of the org's first
 * published funnel as a sparkline (`getFunnelStats().days[]`). Shares the SAME
 * memoized {funnel, stats} read as the funnel-conversion tile (`sharedRead`
 * key `funnel-first:<orgId>` — grade-code fix S3: both tiles enabled = ONE
 * two-hop fetch, not two). Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { listFunnels, getFunnelStats, type FunnelStats, type Funnel } from '../../funnels/funnelsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { Sparkline } from '../Sparkline.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

interface FunnelView { funnel: Funnel; stats: FunnelStats }

// Same shape + memo key as FunnelConversionTile's loader so the two tiles join
// on one request when both are enabled.
async function loadFirstFunnel(orgId: string): Promise<FunnelView | null> {
  const funnels = await listFunnels(orgId);
  const chosen = funnels.find((f) => f.status === 'published') ?? funnels[0];
  if (!chosen) return null;
  const stats = await getFunnelStats(orgId, chosen.funnelId);
  return { funnel: chosen, stats };
}

export default function FunnelDailyTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<FunnelView | null>((orgId) => sharedRead(`funnel-first:${orgId}`, () => loadFirstFunnel(orgId)));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['40%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const days = data?.stats.days ?? [];
  if (status === 'no-org' || days.length < 2) return <p className="dash-tile__state muted">{t('funnelDailyEmpty')}</p>;

  const series = days.map((d) => Object.values(d.steps).reduce((a, s) => a + s.completions, 0));
  const total = series.reduce((a, b) => a + b, 0);

  return (
    <div>
      <p className="dash-tile__state muted">{t('funnelDailySummary', { n: formatNumber(total), days: days.length })}</p>
      <Sparkline className="dash-tile__spark" points={series} label={t('funnelDailyAria', { days: days.length, total: formatNumber(total) })} />
    </div>
  );
}
