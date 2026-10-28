/**
 * ADR 0956 D2 — the multi-touch attribution section. One model at a time with a
 * selector, every model compared beside it, and the org's default model and
 * lookback named on the card. Modelled web credit only: it is never added to the
 * platform-reported conversions in the attribution table above.
 *
 * Renders nothing while the `campaign-intel.multi-touch` sub-toggle is off (the
 * route answers "not enabled", which the client maps to FeatureDisabledError).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice } from '../../ui/Notice.js';
import { SelectField } from '../../ui/Field.js';
import { formatCurrency, formatNumber } from '../../i18n/format.js';
import { minorToMajorString } from '../campaign-brief/budgetUnits.js';
import {
  ATTRIBUTION_MODELS, FeatureDisabledError, getAttributionModels, saveAttributionSettings,
  type AttributionModel, type AttributionModelReport, type ModelCreditRow,
} from './campaignIntelClient.js';

const credit = (n: number): string => formatNumber(n, { maximumFractionDigits: 2 });

function valueText(row: ModelCreditRow): string | null {
  if (row.value.length === 0) return null;
  return row.value.map((v) => formatCurrency(Number(minorToMajorString(v.minor, v.currency)), v.currency)).join(' · ');
}

export function MultiTouchSection({ orgId }: { orgId: string }): JSX.Element | null {
  const { t } = useTranslation('campaign-intel');
  const [report, setReport] = useState<AttributionModelReport | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The model being loaded: the selector shows it at once, the tables are marked busy.
  const [pending, setPending] = useState<AttributionModel | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (model?: AttributionModel) => {
    const mine = ++seq.current;
    setError(null);
    setPending(model ?? null);
    try {
      const r = await getAttributionModels(orgId, model);
      if (mine !== seq.current) return; // a newer load owns the card
      setReport(r);
      setHidden(false);
    } catch (e) {
      if (mine !== seq.current) return;
      if (e instanceof FeatureDisabledError) { setHidden(true); return; }
      // Localized, never a raw server string (UX review).
      setError(t('modelsLoadFailed'));
    } finally {
      if (mine === seq.current) setPending(null);
    }
  }, [orgId, t]);

  useEffect(() => { setReport(null); setSaved(false); void load(); }, [load]);

  const makeDefault = async (): Promise<void> => {
    if (!report) return;
    setSaving(true);
    setError(null);
    try {
      await saveAttributionSettings(orgId, { ...report.settings, defaultModel: report.model }, report.settingsVersion);
      setSaved(true);
      await load(report.model);
    } catch {
      // Covers a stale version (409) and a missing write scope (403) alike.
      setError(t('modelDefaultFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (hidden) return null;
  if (!report) return error ? <Notice variant="error" announce={error}>{error}</Notice> : null;

  const isDefault = report.model === report.settings.defaultModel;
  return (
    <section className="surface-card u-mb-4" aria-labelledby="multi-touch-title" aria-busy={pending !== null}>
      <h2 id="multi-touch-title" className="u-mt-0 u-fs-15">{t('modelsTitle')}</h2>
      <p className="muted u-fs-13 u-mt-0">{t('modelsHint')}</p>
      <div className="u-flex u-items-end u-gap-3 u-flex-wrap u-mb-3">
        <SelectField label={t('modelLabel')} value={pending ?? report.model} onChange={(e) => { const next = ATTRIBUTION_MODELS.find((m) => m === e.target.value); if (!next) return; setSaved(false); void load(next); }}>
          {ATTRIBUTION_MODELS.map((m) => <option key={m} value={m}>{t(`model_${m}`)}</option>)}
        </SelectField>
        {isDefault
          ? <span className="chip chip--muted">{t('modelIsDefault')}</span>
          : <Button variant="quiet" size="sm" loading={saving} onClick={() => void makeDefault()}>{t('modelMakeDefault')}</Button>}
      </div>
      {saved ? <Notice variant="success" announce={t('modelDefaultSaved', { model: t(`model_${report.settings.defaultModel}`) })}>{t('modelDefaultSaved', { model: t(`model_${report.settings.defaultModel}`) })}</Notice> : null}
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      <p className="muted u-fs-13">
        {t('modelSettingsLine', { model: t(`model_${report.settings.defaultModel}`), days: report.settings.lookbackDays, halfLife: report.settings.halfLifeDays })}
        {' '}
        {t('pathCoverage', { contact: formatNumber(report.coverage.contactPaths), session: formatNumber(report.coverage.sessionPaths), none: formatNumber(report.coverage.noTouch) })}
      </p>
      {report.creditedPaths === 0 ? (
        <p className="muted u-fs-13 u-mb-0">{t('modelsEmpty')}</p>
      ) : (
        <>
          <div className="table-scroll table--stack">
            <table className="u-w-full">
              <caption className="sr-only">{t('modelsTableCaption', { model: t(`model_${report.model}`) })}</caption>
              <thead><tr className="muted u-fs-13"><th scope="col" className="u-text-left u-py-2">{t('colCampaign')}</th><th scope="col" className="u-text-right u-py-2">{t('colCredited')}</th><th scope="col" className="u-text-right u-py-2">{t('colCreditedValue')}</th></tr></thead>
              <tbody>
                {[...report.rows, report.unmapped].filter((r) => r.units > 0).map((r) => (
                  <tr key={r.campaignId ?? 'unmapped'}>
                    <td className="u-py-2"><span className="data-stack-label">{t('colCampaign')}</span>{r.campaignId === null ? <span className="muted">{t('modelUnmapped')}</span> : <span className="u-fw-600">{r.name ?? r.campaignId}</span>}</td>
                    <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colCredited')}</span>{credit(r.conversions)}</td>
                    <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colCreditedValue')}</span>{valueText(r) ?? <><span aria-hidden="true">—</span><span className="sr-only">{t('creditedValueNone')}</span></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="u-fs-13 u-mb-2">{t('modelsCompareTitle')}</h3>
          <div className="table-scroll table--stack">
            <table className="u-w-full">
              <caption className="sr-only">{t('modelsCompareTitle')}</caption>
              <thead><tr className="muted u-fs-13"><th scope="col" className="u-text-left u-py-2">{t('colCampaign')}</th>{ATTRIBUTION_MODELS.map((m) => <th key={m} scope="col" className="u-text-right u-py-2">{t(`model_${m}`)}</th>)}</tr></thead>
              <tbody>
                {report.comparison.filter((c) => ATTRIBUTION_MODELS.some((m) => c.byModel[m] > 0)).map((c) => (
                  <tr key={c.campaignId ?? 'unmapped'}>
                    <td className="u-py-2"><span className="data-stack-label">{t('colCampaign')}</span>{c.campaignId === null ? <span className="muted">{t('modelUnmapped')}</span> : <span className="u-fw-600">{c.name ?? c.campaignId}</span>}</td>
                    {ATTRIBUTION_MODELS.map((m) => <td key={m} className="u-text-right u-py-2"><span className="data-stack-label">{t(`model_${m}`)}</span>{credit(c.byModel[m])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
