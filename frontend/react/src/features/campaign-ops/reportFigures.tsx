/**
 * ADR 0957 D5 — the ONE figures table for a frozen client report, shared by the
 * internal review view (`ClientReportsSection`) and the client's link-only
 * report page (`PublicClientReportView`). "Both modes render the same
 * components": only how the visitor got here differs.
 *
 * A figure with no value reads "Not available", never 0, and every figure
 * carries its source and the source's honesty notes in a disclosure.
 */
import { useTranslation } from 'react-i18next';
import { formatCurrency, formatDateTime, formatNumber } from '../../i18n/format.js';
import type { ReportMetric } from './reportsClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];

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

const METRIC_NAMES = new Set(['spend', 'revenue', 'reportedRevenueRecordCount', 'reportedConversionRecordCount', 'impressions', 'clicks', 'conversions', 'ctr', 'cvr', 'cpc', 'cpa', 'roas', 'unattributedConversions', 'uniqueClicks', 'opens', 'uniqueOpens', 'unsubscribes', 'unsubscribesUnenforced']);
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

/** Every figure in the snapshot, sorted by key, in the `campaign-ops` namespace. */
export function ReportFiguresTable({ metrics, title }: { metrics: Record<string, ReportMetric>; title: string }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const rows = Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b));
  return (
    <table className="data-table">
      <caption className="sr-only">{t('reportsMetricsCaption', { title })}</caption>
      <thead><tr><th scope="col">{t('reportsMetric')}</th><th scope="col">{t('reportsValue')}</th><th scope="col">{t('reportsSource')}</th></tr></thead>
      <tbody>
        {rows.map(([key, m]) => (
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
  );
}
