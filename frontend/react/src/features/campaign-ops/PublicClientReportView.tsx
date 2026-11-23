/**
 * ADR 0957 D5 (P2) — the client's page for a published report, rendered by the
 * sharing viewer for a `client_report` link (`/shared/:token`). Link-only mode:
 * no app chrome and no navigation to anything outside this one report.
 *
 * It renders the SAME figures table as the agency's review view
 * (`ReportFiguresTable`), from the frozen snapshot the server sent: no figure is
 * computed here, a missing figure reads "Not available" (never 0), and each
 * figure keeps its source and honesty notes. The server re-checks the link on
 * every request, so a revoked, expired or withdrawn report never reaches here.
 */
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../i18n/format.js';
import { ReportFiguresTable } from './reportFigures.js';
import type { ReportMetric } from './reportsClient.js';

interface PublicReport {
  title?: string;
  clientName?: string;
  recipientName?: string;
  periodStart?: string;
  periodEnd?: string;
  publishedAt?: string | null;
  snapshotHash?: string;
  snapshot?: { metrics?: Record<string, ReportMetric> };
}

const COLUMN = { maxWidth: '52rem' } as const;

export function PublicClientReportView({ resource }: { resource: Record<string, unknown> }): JSX.Element {
  const { t } = useTranslation('campaign-ops');
  const r = resource as unknown as PublicReport;
  const title = r.title ?? '';
  const metrics = r.snapshot?.metrics ?? {};
  return (
    <article className="u-p-4 u-mx-auto page-enter" style={COLUMN}>
      <header className="u-flex u-flex-col u-gap-2 u-mb-4">
        <h1 className="u-m-0">{title}</h1>
        <p className="muted u-m-0">
          {t('reportsPublicFor', { client: r.clientName ?? '' })}
          {r.periodStart && r.periodEnd ? <> · {t('reportsPeriodRange', { start: r.periodStart, end: r.periodEnd })}</> : null}
        </p>
        {r.publishedAt ? <p className="muted u-fs-13 u-m-0">{t('reportsPublicPublishedAt', { when: formatDateTime(r.publishedAt) })}</p> : null}
      </header>
      {Object.keys(metrics).length > 0
        ? <ReportFiguresTable metrics={metrics} title={title} />
        : <p className="muted">{t('reportsPublicEmpty')}</p>}
      <p className="muted u-fs-13 u-mt-4">{t('reportsPublicFinePrint')}</p>
    </article>
  );
}
