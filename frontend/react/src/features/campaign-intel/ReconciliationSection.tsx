/**
 * ADR 0956 D6 — ROAS reconciliation: each platform's own claims beside what the
 * site measured, per campaign and platform, with the sustained-inflation flag
 * and the overlap when several platforms claim the same conversions. The two
 * figures are never added together.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { AlertIcon } from '../../ui/icons/index.js';
import { formatCurrency, formatNumber } from '../../i18n/format.js';
import { FeatureDisabledError, getReconciliation, type ReconciliationReport, type ReconciliationRow } from './campaignIntelClient.js';

const num = (n: number): string => formatNumber(n, { maximumFractionDigits: 2 });
const roas = (n: number | null): string | null => (n === null ? null : `${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`);

function Dash({ sr }: { sr: string }): JSX.Element {
  return <><span aria-hidden="true">—</span><span className="sr-only">{sr}</span></>;
}

function InflationCell({ row }: { row: ReconciliationRow }): JSX.Element {
  const { t } = useTranslation('campaign-intel');
  const i = row.inflation;
  if (i.flagged) return <span className="chip chip--warning"><AlertIcon size={12} aria-hidden="true" /> {i.measuredZero ? t('reconNoSiteConversions') : t('reconInflated', { ratio: num(i.ratio ?? 0) })}</span>;
  if (i.measuredZero) return <span className="chip chip--muted">{t('reconNoSiteConversions')}</span>;
  if (i.ratio === null) return <Dash sr={t('reconNoClaims')} />;
  return <span>{t('reconRatio', { ratio: num(i.ratio) })}{i.daysAbove > 0 ? <span className="muted u-fs-13"> · {t('reconDaysAbove', { days: i.daysAbove, of: 7 })}</span> : null}</span>;
}

export function ReconciliationSection({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-intel');
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setReport(null); setFailed(false);
    getReconciliation(orgId)
      .then((r) => { if (live) setReport(r); })
      .catch((e: unknown) => { if (live && !(e instanceof FeatureDisabledError)) setFailed(true); });
    return () => { live = false; };
  }, [orgId]);

  if (failed) return <Notice variant="error" announce={t('reconLoadFailed')}>{t('reconLoadFailed')}</Notice>;
  if (!report || (report.rows.length === 0 && report.overlap.length === 0)) return null;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="recon-title">
      <h2 id="recon-title" className="u-mt-0 u-fs-15">{t('reconTitle')}</h2>
      <p className="muted u-fs-13 u-mt-0">{t('reconHint', { model: t(`model_${report.model}`), threshold: num(report.threshold), days: report.sustainDays })}</p>
      {report.overlap.some((o) => o.overlap > 0) ? (
        <ul className="u-list-none u-m-0 u-p-0 u-mb-3">
          {report.overlap.filter((o) => o.overlap > 0).map((o) => (
            <li key={o.campaignId} className="u-fs-13 u-py-1">
              <span className="u-fw-600">{o.campaignName}</span>{' '}
              {t('reconOverlapLine', { claims: num(o.platformClaims), measured: num(o.measured), overlap: num(o.overlap) })}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="table-scroll table--stack">
        <table className="u-w-full">
          <caption className="sr-only">{t('reconTitle')}</caption>
          <thead>
            <tr className="muted u-fs-13">
              <th scope="col" className="u-text-left u-py-2">{t('colCampaign')}</th>
              <th scope="col" className="u-text-left u-py-2">{t('reconColPlatform')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('colSpend')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('reconColReported')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('reconColMeasured')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('reconColReportedRoas')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('reconColMeasuredRoas')}</th>
              <th scope="col" className="u-text-left u-py-2">{t('reconColInflation')}</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={`${r.campaignId}-${r.platform}`}>
                <td className="u-py-2"><span className="data-stack-label">{t('colCampaign')}</span><span className="u-fw-600">{r.campaignName}</span></td>
                <td className="u-py-2"><span className="data-stack-label">{t('reconColPlatform')}</span>{t(`platform_${r.platform}`, { defaultValue: r.platform })}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colSpend')}</span>{formatCurrency(r.spend, r.currency, { maximumFractionDigits: 0 })}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('reconColReported')}</span>{num(r.reportedConversions)}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('reconColMeasured')}</span>{num(r.measuredConversions)}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('reconColReportedRoas')}</span>{roas(r.reportedRoas) ?? <Dash sr={t(r.reportedRevenue === null ? 'reconReportedRoasNoRevenue' : 'reconRoasNoSpend')} />}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('reconColMeasuredRoas')}</span>{roas(r.measuredRoas) ?? <Dash sr={t(r.spend > 0 ? 'reconMeasuredRoasNoValue' : 'reconRoasNoSpend')} />}</td>
                <td className="u-py-2"><span className="data-stack-label">{t('reconColInflation')}</span><InflationCell row={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted u-fs-13 u-mb-0">{t('reconCalibrationNote')}</p>
    </section>
  );
}
