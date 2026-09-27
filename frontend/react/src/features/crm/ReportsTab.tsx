/**
 * ReportsTab — CRM decision-intelligence dashboard (ADR 0210 §4 / Phase C6).
 * Reads the ONE `/reports/pipeline` endpoint once per org+pipeline (no
 * dashboard fan-out, per ADR 0210 §3): a KeyFigureBand of open/won/lost/win-rate,
 * a weighted-pipeline table with per-row bars, a contacts-by-stage funnel,
 * an aging list of stalled open deals, and a last-12-week snapshot trend.
 *
 * The pipeline picker is OWNED here (DealsTab owns its own separately, per
 * ADR 0008) — this tab loads pipelines itself and renders its own small
 * `<select>` when the org has more than one, matching DealsTab's picker
 * markup + i18n key (`pipelinePickerLabel`).
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatNumber, formatPercent } from '../../i18n/format.js';
import { formatDealAmount } from './dealMoney.js';
import { KeyFigureBand, type KeyFigureItem } from '../../ui/KeyFigure.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { BarChartIcon, ClockIcon } from '../../ui/icons/index.js';
import { listPipelines, type Pipeline } from './crmOrgClient.js';
import {
  getPipelineReport,
  type PipelineReport,
  type PerStageReport,
  type AgingDeal,
} from './crmReportsClient.js';

interface Props {
  orgId: string;
}

export function ReportsTab({ orgId }: Props): JSX.Element {
  const { t } = useTranslation('crm');
  const { t: tc } = useTranslation('common');
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [pipelineId, setPipelineId] = useState('');
  const [report, setReport] = useState<PipelineReport | null>(null);
  // CRM-UX-13 — TWO flags, one per read, because the recovery differs: a
  // pipelines failure must not let the report read fire against a picker
  // that was never resolved, and the ONE Retry must re-read BOTH (the old
  // Retry re-ran only the report, so a failed pipelines list stayed failed
  // forever behind a button that claimed otherwise). Neither holds the
  // transport string: the card renders the canonical shared copy, and the
  // server's words go to `console.warn` and nowhere else.
  const [pipelinesFailed, setPipelinesFailed] = useState(false);
  const [reportFailed, setReportFailed] = useState(false);

  const loadPipelines = useCallback(() => {
    // UNKNOWN (`null`) for the whole read, never a stale list: the skeleton
    // below is gated on `null`, so a Retry shows loading, not the failed card
    // AND a picker it is about to replace.
    setPipelines(null);
    setPipelinesFailed(false);
    setReportFailed(false);
    if (!orgId) return;
    void listPipelines(orgId)
      .then((p) => {
        setPipelines(p);
        setPipelineId((cur) => (p.some((x) => x.pipelineId === cur) ? cur : (p[0]?.pipelineId ?? '')));
      })
      .catch((e) => { console.warn('[crm] pipelines read failed:', e); setPipelines([]); setPipelinesFailed(true); });
  }, [orgId]);
  useEffect(() => { setPipelineId(''); loadPipelines(); }, [loadPipelines]);

  // Gate on `pipelines !== null` so the initial mount does ONE fetch (with the
  // resolved pipelineId), not two — an unguarded effect would fire once with
  // pipelineId still '' and again once listPipelines resolves it, doubling
  // the report fetch on every tab open (ADR 0210 §3: one fetch, no fan-out).
  // A failed pipelines read does NOT fire it either: the report would be for
  // a pipeline the picker cannot name, and its success would clear the card.
  const load = useCallback(() => {
    if (!orgId || pipelines === null || pipelinesFailed) return;
    setReportFailed(false);
    void getPipelineReport(orgId, pipelineId || undefined)
      .then(setReport)
      .catch((e) => { console.warn('[crm] pipeline report read failed:', e); setReportFailed(true); });
  }, [orgId, pipelineId, pipelines, pipelinesFailed]);
  useEffect(() => { setReport(null); load(); }, [load]);
  const error = pipelinesFailed || reportFailed;

  const stageNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of report?.perStage ?? []) m.set(s.stageId, s.name);
    return m;
  }, [report]);

  const figures = useMemo<KeyFigureItem[]>(() => {
    if (!report) return [];
    const { totals } = report;
    return [
      { key: 'open', label: t('figOpen'), value: formatNumber(totals.openCount) },
      { key: 'won', label: t('figWon'), value: formatNumber(totals.wonCount) },
      { key: 'lost', label: t('figLost'), value: formatNumber(totals.lostCount) },
      { key: 'winRate', label: t('figWinRate'), value: totals.winRate === null ? '—' : formatPercent(totals.winRate) },
    ];
  }, [report, t]);

  const maxWeighted = useMemo(
    () => Math.max(...(report?.perStage ?? []).map((s) => s.weightedSum ?? 0), 1e-9),
    [report],
  );
  // R2 CC-SP-3 — render the currency-grouped sums; fall back to the blind
  // figure only when the backend predates `sums`.
  const groupedCell = useCallback((s: PerStageReport, pick: 'sum' | 'weightedSum'): string => {
    const blind = s[pick];
    // `null` = the rollup is not applicable (non-revenue, ADR 0540 D3). Only
    // reachable if a caller renders this column on such a pipeline; show `—`
    // rather than coercing to 0, which would assert "no money".
    if (blind === null) return '—';
    if (!s.sums || s.sums.length === 0) return formatNumber(blind);
    return s.sums.map((g) => formatDealAmount(g[pick], g.currency)).join(' + ');
  }, []);
  // ADR 0540 D3 — on a NON-REVENUE pipeline the money columns are not rendered
  // blank, they are ABSENT. A `—` in a "Weighted" column still asserts that a
  // weighted figure is the right question here; removing the column says it is
  // not. The meter goes with them (it plots weightedSum).
  const isRevenue = (report?.kind ?? 'revenue') === 'revenue';
  const stageColumns = useMemo<DataColumn<PerStageReport>[]>(() => [
    { key: 'name', header: t('colStage'), render: (s) => s.name },
    { key: 'probability', header: t('colProbability'), align: 'right', cellClassName: 'tabular-nums', render: (s) => formatPercent(s.probability / 100) },
    { key: 'count', header: t('colCount'), align: 'right', cellClassName: 'tabular-nums', render: (s) => formatNumber(s.count) },
    // ADR 0540 D3 — on a NON-REVENUE pipeline these are ABSENT, not blank. A `—`
    // in a "Weighted" column still asserts a weighted figure is the right
    // question here; removing the column says it is not. The meter goes with
    // them, since it plots weightedSum.
    ...(isRevenue
      ? ([
          { key: 'sum', header: t('colSum'), align: 'right', cellClassName: 'tabular-nums', render: (s) => groupedCell(s, 'sum') },
          { key: 'weighted', header: t('colWeighted'), align: 'right', cellClassName: 'tabular-nums', render: (s) => groupedCell(s, 'weightedSum') },
          {
            key: 'bar',
            header: '',
            width: '80px',
            render: (s) => (
              <span className="crm-meter" aria-hidden="true">
                <span className="crm-meter__fill" style={{ width: `${((s.weightedSum ?? 0) / maxWeighted) * 100}%` }} />
              </span>
            ),
          },
        ] as DataColumn<PerStageReport>[])
      : []),
  ], [t, maxWeighted, groupedCell, isRevenue]);

  const maxFunnel = useMemo(
    () => Math.max(...(report?.funnel ?? []).map((f) => f.count), 1e-9),
    [report],
  );

  const maxAgingDays = useMemo(
    () => Math.max(...(report?.aging ?? []).map((a) => a.daysSinceActivity), 1e-9),
    [report],
  );
  const agingColumns = useMemo<DataColumn<AgingDeal>[]>(() => [
    { key: 'title', header: t('colTitle'), render: (d) => <Link to={`/crm/deals/${encodeURIComponent(d.dealId)}?org=${encodeURIComponent(orgId)}`}>{d.title}</Link> },
    { key: 'stage', header: t('colStage'), cellClassName: 'muted', render: (d) => stageNameById.get(d.stageId) ?? d.stageId },
    {
      key: 'daysSinceActivity',
      header: t('colDaysSinceActivity'),
      align: 'right',
      cellClassName: 'tabular-nums',
      sortValue: (d) => d.daysSinceActivity,
      render: (d) => (
        <span className="action-bar u-justify-end">
          {formatNumber(d.daysSinceActivity)}
          <span className="crm-meter crm-meter--sm" aria-hidden="true">
            <span className="crm-meter__fill" style={{ width: `${(d.daysSinceActivity / maxAgingDays) * 100}%` }} />
          </span>
        </span>
      ),
    },
  ], [t, orgId, stageNameById, maxAgingDays]);

  const trend = useMemo(() => {
    const rows = [...(report?.snapshots ?? [])]
      .sort((a, b) => a.isoWeek.localeCompare(b.isoWeek))
      .slice(-12)
      .map((snap) => ({
        isoWeek: snap.isoWeek,
        totalWeighted: snap.perStage.reduce((acc, s) => acc + (s.weightedSum ?? 0), 0),
      }));
    const max = Math.max(...rows.map((r) => r.totalWeighted), 1e-9);
    return { rows, max };
  }, [report]);

  const pipelinePicker = pipelines && pipelines.length > 1 ? (
    <div className="action-bar">
      <label className="u-iflex u-items-center u-gap-2">
        <span className="u-label-sm">{t('pipelinePickerLabel')}</span>
        <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className="u-w-auto">
          {pipelines.map((p) => <option key={p.pipelineId} value={p.pipelineId}>{p.name}</option>)}
        </select>
      </label>
    </div>
  ) : null;

  if (pipelines === null) return <Skeleton height={32} />;

  return (
    <div className="u-grid u-gap-4">
      {pipelinePicker}
      {/* CRM-UX-13 — the canonical announced failed-read card + Retry (the bar
          every other CRM surface met under CRM-UX-4), never a bare Notice
          carrying the transport's raw string. Retry re-reads the pipelines,
          which re-mints `load` and so re-reads the report — BOTH, one press. */}
      {error ? (
        <StateCard
          announce
          icon={<BarChartIcon />}
          title={tc('loadFailedTitle')}
          body={tc('loadFailedBody')}
          action={<Button variant="secondary" onClick={loadPipelines}>{tc('retry')}</Button>}
        />
      ) : null}
      {!error && report === null ? (
        <div className="u-grid u-gap-4">
          <SkeletonRows rows={1} columns={[120, 120, 120, 120]} />
          <SkeletonRows rows={4} columns={[180, 90, 90, 90, 90]} />
        </div>
      ) : null}
      {report ? (
        <>
          <KeyFigureBand figures={figures} ariaLabel={t('reportsTitle')} />

          <div className="surface-card u-p-4 u-grid u-gap-3">
            <h2>{t('weightedPipelineTitle')}</h2>
            <DataTable
              stack
              rows={report.perStage}
              rowKey={(s) => s.stageId}
              columns={stageColumns}
              caption={t('weightedPipelineTitle')}
              empty={<StateCard title={t('noStagesTitle')} body={t('noStagesBody')} />}
            />
          </div>

          <div className="surface-card u-p-4 u-grid u-gap-3">
            <h2>{t('funnelTitle')}</h2>
            {report.funnel.length === 0 ? (
              <p className="muted u-fs-12">{t('funnelEmpty')}</p>
            ) : (
              <div className="u-grid u-gap-2">
                {report.funnel.map((f) => (
                  <div key={f.stage} className="crm-funnel-row">
                    {/* Pipeline funnel stages are USER-NAMED (deal pipeline), not the
                        contact-stage enum — render verbatim (rule 13 localizes enums only). */}
                    <span className="crm-funnel-row__label" title={f.stage}>{f.stage}</span>
                    <span className="crm-meter" aria-hidden="true">
                      <span className="crm-meter__fill" style={{ width: `${(f.count / maxFunnel) * 100}%` }} />
                    </span>
                    <span className="crm-funnel-row__count tabular-nums">{formatNumber(f.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="surface-card u-p-4 u-grid u-gap-3">
            <h2>{t('agingTitle')}</h2>
            <DataTable
              stack
              rows={report.aging}
              rowKey={(d) => d.dealId}
              columns={agingColumns}
              caption={t('agingTitle')}
              initialSort={{ key: 'daysSinceActivity', dir: 'desc' }}
              empty={<StateCard icon={<ClockIcon />} title={t('agingEmptyTitle')} body={t('agingEmptyBody')} />}
            />
          </div>

          <div className="surface-card u-p-4 u-grid u-gap-3">
            <h2>{t('snapshotsTitle')}</h2>
            {(report?.currencies?.length ?? 0) > 1 ? (
              <p className="muted u-fs-12">{t('snapshotsMixedCurrencyCaveat', { currencies: (report?.currencies ?? []).join(', ') })}</p>
            ) : null}
            {trend.rows.length < 2 ? (
              <p className="muted u-fs-12">{t('snapshotsEmpty')}</p>
            ) : (
              <div className="u-grid u-gap-2">
                {trend.rows.map((r) => (
                  <div key={r.isoWeek} className="crm-funnel-row">
                    <span className="crm-funnel-row__label muted u-fs-12">{r.isoWeek}</span>
                    <span className="crm-meter" aria-hidden="true">
                      <span className="crm-meter__fill" style={{ width: `${(r.totalWeighted / trend.max) * 100}%` }} />
                    </span>
                    <span className="crm-funnel-row__count tabular-nums">{formatNumber(r.totalWeighted)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
