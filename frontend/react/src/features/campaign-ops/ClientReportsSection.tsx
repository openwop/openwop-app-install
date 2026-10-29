/**
 * ADR 0957 P1 — the internal review view for client reports: the client's
 * definitions, local draft computation and the workflow-backed review action.
 * Each frozen draft shows its figures' sources. Publication follows the
 * workflow's scoped approval; portal delivery remains P2.
 *
 * Lazy (own chunk). Renders nothing when client reports are off for the
 * workspace. A failed read is said with a retry, never shown as "no reports".
 * A figure with no value reads "Not available", never 0, and every source's
 * window is stated: the sources are not filtered to the report period.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { InlineState } from '../../ui/InlineState.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { formatCurrency, formatDateTime, formatNumber } from '../../i18n/format.js';
import { CampaignOpsError } from './campaignOpsClient.js';
import {
  computeReport, createDefinition, listDefinitions, listReports, sendReportForReview,
  type ClientReport, type ReportDefinition, type ReportMetric, type ReportPeriodKind,
} from './reportsClient.js';

type Load = { kind: 'loading' } | { kind: 'off' } | { kind: 'failed' } | { kind: 'ready'; definitions: ReportDefinition[]; reports: ClientReport[] };
type TFn = ReturnType<typeof useTranslation>['t'];

function isOff(e: unknown): boolean {
  return e instanceof CampaignOpsError && e.status === 404 && /not enabled/i.test(e.message);
}

function MetricValue({ m, t }: { m: ReportMetric; t: TFn }): JSX.Element {
  if (m.value === null) return <span className="muted">{t('reportsNotAvailable')}</span>;
  if (m.unit === 'currency') return <>{m.currency ? formatCurrency(m.value, m.currency) : t('reportsNoCurrency', { amount: formatNumber(m.value) })}</>;
  return <>{formatNumber(m.value)}</>;
}

function noteText(note: string, computedAt: string, t: TFn): string {
  if (note === 'all-data-to-computedAt') return t('reportsNoteWindow', { when: formatDateTime(computedAt) });
  const kind = note.split(':')[0] ?? note;
  const value = note.slice(note.indexOf(':') + 1);
  const known = ['currency-mixed', 'currency-unknown', 'unreported-conversions', 'unreported-revenue', 'shared-join-keys', 'platform-and-web-conversions-not-summed', 'opens-approximate', 'unsubscribes-unenforced', 'data-range'];
  return known.includes(kind) ? t(`reportsNote_${kind.replace(/-/g, '_')}`, { value }) : note;
}

const METRIC_NAMES = new Set(['spend', 'revenue', 'impressions', 'clicks', 'conversions', 'ctr', 'cvr', 'cpc', 'cpa', 'roas', 'unattributedConversions', 'uniqueClicks', 'opens', 'uniqueOpens', 'unsubscribes', 'unsubscribesUnenforced']);
const SOURCE_KEYS: Record<string, string> = {
  'campaign-connectors.kpiSummary': 'reportsSource_kpi', 'campaign-intel.buildAttribution': 'reportsSource_attribution', 'email.engagementStats': 'reportsSource_email',
};

function sourceLabel(source: string, t: TFn): string {
  const key = SOURCE_KEYS[source];
  return key ? t(key) : source;
}

/** A plain-words label for a metric key (`kpi.spend` → "Ad performance: Spend"). */
function metricLabel(key: string, m: ReportMetric, t: TFn): string {
  const dot = key.lastIndexOf('.');
  const name = key.slice(dot + 1);
  const section = SOURCE_KEYS[m.lineage.source] ? sourceLabel(m.lineage.source, t) : key.slice(0, dot);
  return `${section}: ${METRIC_NAMES.has(name) ? t(`reportsMetric_${name}`) : name}`;
}

function ReportView({ report, t }: { report: ClientReport; t: TFn }): JSX.Element {
  const metrics = Object.entries(report.snapshot.metrics).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="u-mt-3">
      <p className="u-fs-13 u-mt-0">
        <span className="chip chip--muted">{t(`reportsStatus_${report.status}`)}</span>{' '}
        {t('reportsPeriodRange', { start: report.periodStart, end: report.periodEnd })} · {t('reportsFingerprint')} <code title={report.snapshotHash}>{report.snapshotHash.slice(0, 10)}</code>
      </p>
      <table className="data-table">
        <caption className="sr-only">{t('reportsMetricsCaption', { title: report.title })}</caption>
        <thead><tr><th scope="col">{t('reportsMetric')}</th><th scope="col">{t('reportsValue')}</th><th scope="col">{t('reportsSource')}</th></tr></thead>
        <tbody>
          {metrics.map(([key, m]) => (
            <tr key={key}>
              <th scope="row">{metricLabel(key, m, t)}</th>
              <td><MetricValue m={m} t={t} /></td>
              <td>
                <details>
                  <summary className="u-fs-13">{sourceLabel(m.lineage.source, t)}</summary>
                  <ul className="u-fs-13 u-m-0">
                    {(m.lineage.notes ?? []).map((n) => <li key={n}>{noteText(n, m.lineage.computedAt, t)}</li>)}
                    {m.lineage.rows !== undefined ? <li>{t('reportsRows', { count: m.lineage.rows })}</li> : null}
                  </ul>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ClientReportsSection({ orgId }: { orgId: string }): JSX.Element | null {
  return <ClientReportsForOrg key={orgId} orgId={orgId} />;
}

function ClientReportsForOrg({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-ops');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [title, setTitle] = useState('');
  const [period, setPeriod] = useState<ReportPeriodKind>('month');

  const refresh = useCallback(async () => {
    try {
      const [definitions, reports] = await Promise.all([listDefinitions(orgId), listReports(orgId)]);
      setLoad({ kind: 'ready', definitions, reports });
    } catch (e) { setLoad(isOff(e) ? { kind: 'off' } : { kind: 'failed' }); }
  }, [orgId]);
  useEffect(() => { setLoad({ kind: 'loading' }); void refresh(); }, [refresh]);

  const create = async (): Promise<void> => {
    if (!title.trim()) { setError(t('reportsTitleRequired')); return; }
    setBusy('create'); setError(null);
    try {
      await createDefinition(orgId, { title: title.trim(), sections: [{ kind: 'kpi' }, { kind: 'attribution' }], period: { kind: period, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } });
      setTitle(''); await refresh();
    } catch (e) { setError(e instanceof Error && e.message ? e.message : t('reportsCreateFailed')); } finally { setBusy(null); }
  };
  const compute = async (definitionId: string): Promise<void> => {
    setBusy(definitionId); setError(null);
    try { const r = await computeReport(orgId, definitionId); setOpen(r.reportId); await refresh(); }
    catch (e) { setError(e instanceof Error && e.message ? e.message : t('reportsComputeFailed')); } finally { setBusy(null); }
  };

  // ADR 0957 D2 — the gated path: the report waits in the approvals inbox under
  // the client's review policy and publishes once approved.
  const sendForReview = async (definitionId: string): Promise<void> => {
    setBusy(definitionId); setError(null); setSent(null);
    try {
      await sendReportForReview(orgId, definitionId);
      if (!mounted.current) return;
      setSent(definitionId); await refresh();
    } catch (e) { if (mounted.current) setError(e instanceof Error && e.message ? e.message : t('reportsSendFailed')); }
    finally { if (mounted.current) setBusy(null); }
  };

  if (load.kind === 'off') return null;
  return (
    <section className="surface-card" aria-labelledby="campaign-ops-reports">
      <h3 id="campaign-ops-reports" className="u-mt-0 u-fs-15">{t('reportsHeading')}</h3>
      <p className="muted u-fs-13 u-mt-0">{t('reportsIntro')}</p>
      {load.kind === 'loading' ? <InlineState kind="loading" message={t('reportsLoading')} /> : null}
      {load.kind === 'failed' ? (
        <InlineState kind="failed" announce={t('reportsLoadFailed')} announcePolite message={t('reportsLoadFailed')}
          action={<Button variant="secondary" size="sm" onClick={() => void refresh()}>{t('reportsRetry')}</Button>} />
      ) : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {sent ? <Notice variant="success" announce={t('reportsSentForReview')}>{t('reportsSentForReview')}</Notice> : null}
      {load.kind === 'ready' ? (
        <>
          <div className="action-bar u-flex u-items-center u-gap-2 u-mb-2">
            <TextField label={t('reportsNewTitle')} value={title} onChange={(e) => setTitle(e.target.value)} className="u-mb-0" />
            <SelectField label={t('reportsPeriodLabel')} value={period} onChange={(e) => setPeriod(e.target.value as ReportPeriodKind)} className="u-mb-0">
              <option value="month">{t('reportsPeriod_month')}</option>
              <option value="week">{t('reportsPeriod_week')}</option>
            </SelectField>
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void create()}>{t('reportsCreate')}</Button>
          </div>
          {load.definitions.length === 0 ? <p className="muted u-mb-0">{t('reportsEmpty')}</p> : (
            <ul className="u-m-0">
              {load.definitions.map((d) => {
                const reports = load.reports.filter((r) => r.definitionId === d.definitionId);
                return (
                  <li key={d.definitionId} className="u-mb-3">
                    <span className="u-fw-600">{d.title}</span>{' '}
                    <span className="chip chip--muted">{t('reportsVersion', { version: d.version })}</span>{' '}
                    <Button variant="link" disabled={busy !== null} onClick={() => void compute(d.definitionId)}>{t('reportsCompute')}</Button>{' '}
                    <Button variant="link" disabled={busy !== null} onClick={() => void sendForReview(d.definitionId)}>{t('reportsSendForReview')}</Button>
                    {reports.length > 0 ? (
                      <ul className="u-m-0">
                        {reports.map((r) => (
                          <li key={r.reportId} className="u-fs-13">
                            <Button variant="link" aria-expanded={open === r.reportId} onClick={() => setOpen(open === r.reportId ? null : r.reportId)}>
                              {t('reportsComputedAt', { when: formatDateTime(r.generatedAt) })}
                            </Button>
                            {open === r.reportId ? <ReportView report={r} t={t} /> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}
