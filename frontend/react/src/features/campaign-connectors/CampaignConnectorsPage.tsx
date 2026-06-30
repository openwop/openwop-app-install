/**
 * Campaign Performance page (ADR 0159, Phase 3). Import ad-platform CSV exports
 * onto a unified metric schema and see KPI rollups per platform, on the shared ui/
 * cohesion layer. A distinct ad-metrics domain (spend/ROAS), NOT page analytics
 * (ADR 0018) — composed honestly, not forked. Live OAuth sync is honest-off.
 *
 * @see docs/adr/0159-campaign-studio-connectors-performance.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { Modal } from '../../ui/Modal.js';
import { TextareaField, SelectField } from '../../ui/Field.js';
import { ActivityIcon, PlusIcon } from '../../ui/icons/index.js';
import { formatNumber, formatCurrency } from '../../i18n/format.js';
import {
  importCsv, getKpi, listOrgs, AD_PLATFORMS, FeatureDisabledError,
  type KpiSummary, type AdPlatform, type ImportResult, type OrgRef,
} from './campaignConnectorsClient.js';

type TFn = ReturnType<typeof useTranslation>['t'];
const fmt = (n: number): string => formatNumber(Math.round(n));
const money = (n: number): string => formatCurrency(n, 'USD', { maximumFractionDigits: 0 });
const roas = (n: number): string => `${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;

export function CampaignConnectorsPage(): JSX.Element {
  const { t } = useTranslation('campaign-connectors');
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [orgId, setOrgId] = useState('');
  const [kpi, setKpi] = useState<KpiSummary | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);

  useEffect(() => { void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || o[0]?.orgId || ''); }).catch(() => {}); }, []);

  const refresh = useCallback(async (org: string) => {
    if (!org) { setKpi(null); return; }
    try { setKpi(await getKpi(org)); setDisabled(false); }
    catch (e) { if (e instanceof FeatureDisabledError) { setDisabled(true); return; } setError(e instanceof Error ? e.message : 'load failed'); }
  }, []);
  useEffect(() => { void refresh(orgId); }, [orgId, refresh]);

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')} />
        <StateCard icon={<ActivityIcon size={22} />} title={t('notEnabledTitle')} body={t('notEnabledBody')} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} lede={t('lede')}
        actions={orgId ? <button type="button" className="btn-primary btn-sm" onClick={() => setImportOpen(true)}><PlusIcon size={13} /> {t('importCsv')}</button> : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}
      {lastImport ? (
        <Notice variant={lastImport.invalid > 0 ? 'warning' : 'success'}>
          {t('importedSummary', { imported: lastImport.imported, deduped: lastImport.deduped, invalid: lastImport.invalid })}
        </Notice>
      ) : null}

      {orgs.length === 0 ? (
        <StateCard icon={<ActivityIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
      ) : (
        <>
          {orgs.length > 1 ? (
            <div className="u-mb-4">
              <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
              </SelectField>
            </div>
          ) : null}

          {kpi === null ? (
            <StateCard icon={<ActivityIcon size={20} />} title={t('loading')} loading />
          ) : kpi.recordCount === 0 ? (
            <StateCard icon={<ActivityIcon size={22} />} title={t('emptyTitle')} body={t('emptyBody')}
              action={<button type="button" className="btn-primary btn-sm" onClick={() => setImportOpen(true)}><PlusIcon size={13} /> {t('importCsv')}</button>} />
          ) : (
            <>
              <div className="u-flex u-gap-3 u-mb-4 u-flex-wrap">
                <KpiCard label={t('kpiSpend')} value={money(kpi.totals.spend)} t={t} />
                <KpiCard label={t('kpiImpressions')} value={fmt(kpi.totals.impressions)} t={t} />
                <KpiCard label={t('kpiClicks')} value={fmt(kpi.totals.clicks)} t={t} />
                <KpiCard label={t('kpiConversions')} value={fmt(kpi.totals.conversions)} t={t} />
                <KpiCard label={t('kpiRevenue')} value={money(kpi.totals.revenue)} t={t} />
                <KpiCard label={t('kpiRoas')} value={roas(kpi.totals.roas)} t={t} />
              </div>

              <section className="surface-card">
                <h3 className="u-mt-0">{t('byPlatformTitle')}</h3>
                <table className="u-w-full">
                  <thead>
                    <tr className="u-text-muted u-fs-13">
                      <th className="u-text-left u-py-2">{t('colPlatform')}</th>
                      <th className="u-text-right u-py-2">{t('kpiSpend')}</th>
                      <th className="u-text-right u-py-2">{t('kpiClicks')}</th>
                      <th className="u-text-right u-py-2">{t('kpiConversions')}</th>
                      <th className="u-text-right u-py-2">{t('kpiRoas')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kpi.byPlatform.map((p) => (
                      <tr key={p.platform}>
                        <td className="u-py-2"><span className="chip chip--muted">{t(`platform_${p.platform}`, { defaultValue: p.platform })}</span></td>
                        <td className="u-text-right u-py-2">{money(p.spend)}</td>
                        <td className="u-text-right u-py-2">{fmt(p.clicks)}</td>
                        <td className="u-text-right u-py-2">{fmt(p.conversions)}</td>
                        <td className="u-text-right u-py-2">{roas(p.roas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {kpi.dateRange ? <p className="u-fs-13 u-text-muted u-mt-3">{t('dateRange', { start: kpi.dateRange.start, end: kpi.dateRange.end, count: kpi.recordCount })}</p> : null}
              </section>
            </>
          )}
        </>
      )}

      {importOpen ? (
        <ImportModal t={t} orgId={orgId}
          onClose={() => setImportOpen(false)}
          onDone={async (r) => { setImportOpen(false); setLastImport(r); await refresh(orgId); }}
          onError={setError} />
      ) : null}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string; t: TFn }): JSX.Element {
  return (
    <div className="surface-card u-flex-1">
      <div className="u-fs-13 u-text-muted">{label}</div>
      <div className="u-fw-600 u-fs-18">{value}</div>
    </div>
  );
}

function ImportModal({ t, orgId, onClose, onDone, onError }: { t: TFn; orgId: string; onClose: () => void; onDone: (r: ImportResult) => void; onError: (m: string) => void }): JSX.Element {
  const [csv, setCsv] = useState('');
  const [platform, setPlatform] = useState<AdPlatform>('google');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try { onDone(await importCsv(orgId, csv, platform)); }
    catch (e) { onError(e instanceof Error ? e.message : 'import failed'); setBusy(false); }
  };
  return (
    <Modal label={t('importCsv')} onClose={onClose} showClose>
      <h2 className="u-mt-0">{t('importCsv')}</h2>
      <p className="u-text-muted">{t('importHint')}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (csv.trim() && !busy) void submit(); }}>
        <SelectField label={t('defaultPlatform')} value={platform} onChange={(e) => setPlatform(e.target.value as AdPlatform)}>
          {AD_PLATFORMS.map((p) => <option key={p} value={p}>{t(`platform_${p}`, { defaultValue: p })}</option>)}
        </SelectField>
        <TextareaField label={t('csvLabel')} help={t('csvHelp')} value={csv} rows={8} onChange={(e) => setCsv(e.target.value)} required />
        <div className="action-bar u-flex u-gap-2 u-justify-end">
          <button type="button" className="secondary btn-sm" onClick={onClose}>{t('common:cancel')}</button>
          <button type="submit" className="btn-primary btn-sm" disabled={!csv.trim() || busy}>{t('import')}</button>
        </div>
      </form>
    </Modal>
  );
}
