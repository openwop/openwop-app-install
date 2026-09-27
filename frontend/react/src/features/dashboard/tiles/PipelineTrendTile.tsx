/**
 * Pipeline trend tile (ADR 0377 Wave 2) — the weekly weighted-pipeline trend
 * from CRM snapshots (`getPipelineReport().snapshots[]`), rendered as the ONE
 * dashboard sparkline + a latest-vs-prior-week delta (the delta variant's
 * first real consumer). Org-scoped; owns no data (ADR 0082).
 */
import { useTranslation } from 'react-i18next';
import { getPipelineReport, type PipelineReport } from '../../crm/crmReportsClient.js';
import { SkeletonRows } from '../../../ui/Skeleton.js';
import { formatCurrency, formatNumber } from '../../../i18n/format.js';
import { useOrgResource } from '../useOrgResource.js';
import { TileStats } from '../TileStats.js';
import { Sparkline } from '../Sparkline.js';
import { sharedRead } from '../sharedRead.js';
import type { DashboardTileProps } from '../tileTypes.js';

const weightedSum = (s: PipelineReport['snapshots'][number]): number =>
  // ADR 0540 D3 — a non-revenue pipeline reports `null`; it contributes nothing
  // to a revenue trend rather than dragging it to zero.
  s.perStage.reduce((a, st) => a + (st.weightedSum ?? 0), 0);

export default function PipelineTrendTile(_props: DashboardTileProps): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { status, data } = useOrgResource<PipelineReport>((orgId) => sharedRead(`crm-pipeline:${orgId}`, () => getPipelineReport(orgId)));

  if (status === 'loading') return <SkeletonRows rows={2} columns={['40%', '55%']} />;
  if (status === 'error') return <p className="dash-tile__state muted">{t('tileError')}</p>;
  const snaps = data?.snapshots ?? [];
  if (status === 'no-org' || snaps.length === 0) return <p className="dash-tile__state muted">{t('pipelineTrendEmpty')}</p>;

  const series = snaps.map(weightedSum);
  const latest = series[series.length - 1]!;
  const prior = series.length > 1 ? series[series.length - 2]! : null;
  const delta = prior !== null ? latest - prior : null;

  // R3 (the CRM console XCC-6 recorded follow-up) — this tile summed snapshot
  // weightedSum currency-BLIND with no caveat while the console's ReportsTab
  // got the CC-SP-3 honesty pass. Same wire facts, same posture: exactly ONE
  // deal currency → format the amount IN it; several → the number stays (a
  // trend of mixed units is still a trend) but the mix is DISCLOSED.
  const currencies = (data?.currencies ?? []).filter(Boolean);
  const fmt = (v: number): string => currencies.length === 1
    ? formatCurrency(v, currencies[0]!, { maximumFractionDigits: 0 })
    : formatNumber(v, { maximumFractionDigits: 0 });

  return (
    <div>
      <TileStats
        stats={[{
          label: t('pipelineWeighted'),
          value: fmt(latest),
          delta: delta !== null ? { value: delta, display: fmt(Math.abs(delta)) } : undefined,
        }]}
      />
      <Sparkline className="dash-tile__spark" points={series} label={t('pipelineTrendAria', { weeks: series.length, latest: fmt(latest) })} />
      {currencies.length > 1 ? (
        <p className="muted u-fs-11 u-m-0">{t('pipelineMixedCurrencyCaveat', { currencies: currencies.join(', ') })}</p>
      ) : null}
    </div>
  );
}
