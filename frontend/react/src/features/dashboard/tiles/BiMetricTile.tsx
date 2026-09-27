/**
 * BI metric tile (ADR 0417 P3) — the pipeline-value system metric bucketed by
 * month, through the governed runMetric lane. Rides the shared tile machinery
 * (useOrgResource + TileStats + Sparkline); owns no data.
 */
import { useTranslation } from 'react-i18next';
import { runBiMetric, type MetricRunResult } from '../../bi/biClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import { Sparkline } from '../Sparkline.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

export default function BiMetricTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<MetricRunResult>((orgId) =>
    sharedRead(`bi-metric:${orgId}`, () => runBiMetric(orgId, 'sys-pipeline-value', { bucket: 'month' })));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['40%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const points = data?.points ?? [];
  if (status === 'no-org' || points.length === 0) return <p className="dash-tile__state muted">{t('biMetricEmpty')}</p>;

  const series = points.map((p) => p.value);
  const latest = series[series.length - 1]!;
  const prior = series.length > 1 ? series[series.length - 2]! : null;
  const delta = prior !== null ? latest - prior : null;

  return (
    <div>
      <TileStats
        stats={[{
          label: t('biMetricLabel'),
          value: formatNumber(latest, { maximumFractionDigits: 0 }),
          delta: delta !== null ? { value: delta, display: formatNumber(Math.abs(delta), { maximumFractionDigits: 0 }) } : undefined,
        }]}
      />
      <Sparkline className="dash-tile__spark" points={series} label={t('biMetricAria', { months: series.length, latest: formatNumber(latest, { maximumFractionDigits: 0 }) })} />
    </div>
  );
}
