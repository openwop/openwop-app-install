/**
 * ADR 0956 D6 — AdMap: each published ad, the page or funnel step its landing
 * link opens, the variant it carries, and the sessions and conversions credited
 * to it. Per-ad spend and clicks wait for an ad-level metric grain; the
 * message-match score waits for ADR 0933 content rules. Both are said, not
 * estimated.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { formatNumber } from '../../i18n/format.js';
import { FeatureDisabledError, getAdMap, type AdMapReport, type AdMapRow } from './campaignIntelClient.js';

function Landing({ row }: { row: AdMapRow }): JSX.Element {
  const { t } = useTranslation('campaign-intel');
  const l = row.landing;
  if (l.kind === 'cms_page') {
    return (
      <span>
        <span className="u-fw-600">{l.title}</span> <span className="muted u-fs-13">/{l.slug}</span>
        {l.funnelSteps.map((s) => <span key={`${s.funnelId}-${s.stepId}`} className="chip chip--muted u-ml-2">{t('admapFunnelStep', { funnel: s.funnelName })}</span>)}
      </span>
    );
  }
  if (l.kind === 'external') return <span>{t('admapExternal', { host: l.host })}</span>;
  return <span className="muted">{t(`admapUnresolved_${l.reason}`)}</span>;
}

export function AdMapSection({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-intel');
  const [report, setReport] = useState<AdMapReport | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setReport(null); setFailed(false);
    getAdMap(orgId)
      .then((r) => { if (live) setReport(r); })
      .catch((e: unknown) => { if (live && !(e instanceof FeatureDisabledError)) setFailed(true); });
    return () => { live = false; };
  }, [orgId]);

  if (failed) return <Notice variant="error" announce={t('admapLoadFailed')}>{t('admapLoadFailed')}</Notice>;
  if (!report || report.rows.length === 0) return null;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="admap-title">
      <h2 id="admap-title" className="u-mt-0 u-fs-15">{t('admapTitle')}</h2>
      <p className="muted u-fs-13 u-mt-0">{t('admapHint', { model: t(`model_${report.model}`) })}</p>
      {report.ledgerCapped ? <Notice variant="warning">{t('admapLedgerCapped')}</Notice> : null}
      <div className="table-scroll table--stack">
        <table className="u-w-full">
          <caption className="sr-only">{t('admapTitle')}</caption>
          <thead>
            <tr className="muted u-fs-13">
              <th scope="col" className="u-text-left u-py-2">{t('admapColAd')}</th>
              <th scope="col" className="u-text-left u-py-2">{t('colCampaign')}</th>
              <th scope="col" className="u-text-left u-py-2">{t('admapColLanding')}</th>
              <th scope="col" className="u-text-left u-py-2">{t('admapColVariant')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('admapColSessions')}</th>
              <th scope="col" className="u-text-right u-py-2">{t('admapColConversions')}</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={`${r.platform}-${r.platformAdId}`}>
                <td className="u-py-2"><span className="data-stack-label">{t('admapColAd')}</span>{t(`platform_${r.platform}`, { defaultValue: r.platform })} <span className="muted u-fs-13">{r.adRef ?? r.platformAdId}</span></td>
                <td className="u-py-2"><span className="data-stack-label">{t('colCampaign')}</span>{r.campaignName ?? <span className="muted">{t('admapNoCampaign')}</span>}</td>
                <td className="u-py-2"><span className="data-stack-label">{t('admapColLanding')}</span><Landing row={r} /></td>
                <td className="u-py-2"><span className="data-stack-label">{t('admapColVariant')}</span>{r.variantKey ?? <><span aria-hidden="true">—</span><span className="sr-only">{t('admapNoVariant')}</span></>}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('admapColSessions')}</span>{r.landingSessions === null ? t('valueUnavailable') : formatNumber(r.landingSessions)}</td>
                <td className="u-text-right u-py-2"><span className="data-stack-label">{t('admapColConversions')}</span>{r.conversions === null ? t('valueUnavailable') : formatNumber(r.conversions, { maximumFractionDigits: 2 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted u-fs-13 u-mb-0">
        {t('admapTrackingNote')}{' '}
        {t('admapGrainNote')}{report.unplacedLegacyRows > 0 ? ` ${t('admapLegacyRows', { count: report.unplacedLegacyRows })}` : ''}
      </p>
    </section>
  );
}
