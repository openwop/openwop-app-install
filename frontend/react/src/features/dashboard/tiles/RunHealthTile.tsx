/**
 * Run health tile (ADR 0844) — runs, success rate, median duration and runs
 * waiting on a person, for today / 7 days / 30 days, each against the previous
 * equal period.
 *
 * Computed client-side from the shared runs read (`runsWindow.ts`) because the
 * host has no run-statistics route. When that read is a truncated sample the
 * tile SAYS so, and drops a comparison it cannot make honestly.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunListItem } from '../../../client/runsClient.js';
import { Button } from '../../../ui/Button.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { Sparkline } from '../../../ui/Sparkline.js';
import { formatNumber, formatPercent } from '../../../i18n/format.js';
import { useTileData } from '../useTileData.js';
import { computeRunHealth, formatDuration, readRecentRuns, RUN_WINDOW, type RunRange } from '../runsWindow.js';
import type { DashboardTileProps } from '../tileTypes.js';

const RANGES: RunRange[] = ['24h', '7d', '30d'];

interface Kpi {
  key: string;
  label: string;
  value: string;
  /** Preformatted change and whether it is good news; absent = no comparison. */
  delta?: { text: string; good: boolean } | undefined;
  note?: string | undefined;
}

export default function RunHealthTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const [range, setRange] = useState<RunRange>('7d');
  const { status, data } = useTileData<RunListItem[]>(() => readRecentRuns(), []);
  // Re-evaluate "now" each minute so the window slides while the page is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(iv);
  }, []);

  if (status === 'loading') return <SkeletonRows rows={2} columns={['25%', '25%', '25%', '25%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const rows = data ?? [];
  if (rows.length === 0) return <p className="dash-tile__state muted">{t('healthEmpty')}</p>;

  const h = computeRunHealth(rows, range, now, rows.length >= RUN_WINDOW);
  const p = h.previous;
  const kpis: Kpi[] = [
    {
      key: 'runs',
      label: t('healthRuns'),
      value: formatNumber(h.runs),
      delta: p && p.runs > 0 ? pct((h.runs - p.runs) / p.runs, true) : undefined,
    },
    {
      key: 'success',
      label: t('healthSuccess'),
      value: h.successRate === null ? '—' : formatPercent(h.successRate),
      delta: p?.successRate != null && h.successRate !== null
        ? points(h.successRate - p.successRate)
        : undefined,
    },
    {
      key: 'median',
      label: t('healthMedian'),
      value: h.medianMs === null ? '—' : formatDuration(h.medianMs),
      delta: p?.medianMs != null && h.medianMs !== null && h.medianMs !== p.medianMs
        ? { text: `${h.medianMs < p.medianMs ? '−' : '+'}${formatDuration(Math.abs(h.medianMs - p.medianMs))}`, good: h.medianMs < p.medianMs }
        : undefined,
    },
    {
      key: 'waiting',
      label: t('healthWaiting'),
      value: formatNumber(h.waiting),
      note: t('healthWaitingNote'),
    },
  ];

  function pct(change: number, upIsGood: boolean): Kpi['delta'] {
    if (change === 0) return undefined;
    const text = `${change > 0 ? '+' : '−'}${formatPercent(Math.abs(change))}`;
    return { text, good: change > 0 === upIsGood };
  }
  function points(change: number): Kpi['delta'] {
    const pts = Math.round(change * 1000) / 10;
    if (pts === 0) return undefined;
    return { text: t('healthPoints', { value: `${pts > 0 ? '+' : '−'}${Math.abs(pts)}` }), good: pts > 0 };
  }

  return (
    <div className="dash-health">
      <div className="dash-health__head">
        <div className="segmented" role="group" aria-label={t('healthRangeLabel')}>
          {RANGES.map((r) => (
            <Button key={r} variant="primary" aria-pressed={range === r} onClick={() => setRange(r)}>
              {t(`healthRange_${r}`)}
            </Button>
          ))}
        </div>
        <span className="dash-health__caption muted">
          {h.covered ? t(`healthCompare_${range}`) : t('healthSampled', { count: RUN_WINDOW })}
        </span>
      </div>
      <dl className="dash-health__kpis u-m-0">
        {kpis.map((k) => (
          <div key={k.key} className="dash-health__kpi">
            <dt className="dash-health__label">{k.label}</dt>
            <dd className="dash-health__value u-m-0">
              {k.value}
              {k.delta ? (
                <span className={`dash-health__delta ${k.delta.good ? 'dash-health__delta--good' : 'dash-health__delta--bad'}`}>
                  <span className="sr-only">{t(k.delta.good ? 'healthBetter' : 'healthWorse')} </span>
                  {k.delta.text}
                </span>
              ) : null}
            </dd>
            {k.key === 'runs' ? (
              <dd className="u-m-0"><Sparkline points={h.series} label={t('healthSparkLabel', { range: t(`healthRange_${range}`) })} className="dash-health__spark" /></dd>
            ) : null}
            {k.note ? <dd className="dash-health__note muted u-m-0">{k.note}</dd> : null}
          </div>
        ))}
      </dl>
    </div>
  );
}
