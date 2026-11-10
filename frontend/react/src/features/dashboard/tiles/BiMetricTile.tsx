/**
 * BI metric tile (ADR 0417 P3) — the pipeline-value system metric bucketed by
 * month, through the governed runMetric lane. Rides the shared tile machinery
 * (useOrgResource + TileStats + Sparkline); owns no data.
 *
 * ADR 1052 D14 — the value is the CURRENT month's bucket, read by key over a
 * bounded, zero-filled 12-month window that starts this month. It used to be the
 * LAST bucket of an unbounded series: the furthest-future close month, or the
 * `undated` bucket (which sorted after every month), and its delta compared months
 * that need not have been adjacent. The metric itself now excludes won and lost
 * deals.
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

const pad = (n: number): string => String(n).padStart(2, '0');

/** The 12-month window STARTING with the viewer's current month (UX grade H1: an open
 *  deal whose close month is past is overdue, not pipeline), as `since`/`until` dates
 *  and the month keys in order. The month is the viewer's LOCAL month; close dates are
 *  date-only, so their month needs no time zone. */
export function pipelineWindow(now: Date): { since: string; until: string; months: string[] } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y, m + i, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  });
  const end = new Date(y, m + 12, 0);
  return { since: `${months[0]}-01`, until: `${months[11]}-${pad(end.getDate())}`, months };
}

export default function BiMetricTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const win = pipelineWindow(new Date());
  const { status, data } = useOrgResource<MetricRunResult>((orgId) =>
    sharedRead(`bi-metric:${orgId}:${win.since}`, () => runBiMetric(orgId, 'sys-pipeline-value', { bucket: 'month', since: win.since, until: win.until })));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['40%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const byKey = new Map((data?.points ?? []).map((p) => [p.key, p]));
  const rows = [...byKey.values()].reduce((a, p) => a + p.n, 0);
  if (status === 'no-org' || rows === 0) return <p className="dash-tile__state muted">{t('biMetricEmpty')}</p>;

  // Read by KEY: a missing month is a month with nothing closing, not a skipped one.
  // No delta: the months ahead are a schedule, not a trend against a prior period.
  const series = win.months.map((k) => byKey.get(k)?.value ?? 0);
  const current = series[0]!;
  const ahead = series.reduce((a, v) => a + v, 0);

  return (
    <div>
      <TileStats
        stats={[
          { label: t('biMetricLabel'), value: formatNumber(current, { maximumFractionDigits: 0 }) },
          { label: t('biMetricAheadLabel'), value: formatNumber(ahead, { maximumFractionDigits: 0 }) },
        ]}
      />
      <Sparkline className="dash-tile__spark" points={series} label={t('biMetricAria', { months: series.length, latest: formatNumber(current, { maximumFractionDigits: 0 }) })} />
    </div>
  );
}
