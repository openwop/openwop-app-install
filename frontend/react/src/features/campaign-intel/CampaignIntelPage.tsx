/**
 * Campaign Intelligence page (ADR 0160, Phase 2). Budget recommendations +
 * forecast over the performance store, on the shared ui/ layer, with an "Ask the
 * Analyst" deep-link to the one chat (ADR 0058). NOT a parallel analytics
 * dashboard — recommendations + the agent, the "build ON orchestration" rule.
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SelectField } from '../../ui/Field.js';
import { ActivityIcon, SparklesIcon } from '../../ui/icons/index.js';
import { formatNumber, formatCurrency } from '../../i18n/format.js';
import {
  getBudget, getForecast, listOrgs, FeatureDisabledError, INTELLIGENCE_ANALYST_AGENT,
  type BudgetRecommendation, type CampaignForecast, type OrgRef,
} from './campaignIntelClient.js';

const money = (n: number): string => formatCurrency(n, 'USD', { maximumFractionDigits: 0 });
const roas = (n: number): string => `${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
const pct = (n: number): string => `${formatNumber(n, { maximumFractionDigits: 0 })}%`;

export function CampaignIntelPage(): JSX.Element {
  const { t } = useTranslation('campaign-intel');
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [orgId, setOrgId] = useState('');
  const [budget, setBudget] = useState<BudgetRecommendation | null>(null);
  const [forecasts, setForecasts] = useState<CampaignForecast[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void listOrgs().then((o) => { setOrgs(o); setOrgId((cur) => cur || o[0]?.orgId || ''); }).catch(() => {}); }, []);

  const refresh = useCallback(async (org: string) => {
    if (!org) { setBudget(null); setForecasts(null); return; }
    try { const [b, f] = await Promise.all([getBudget(org), getForecast(org)]); setBudget(b); setForecasts(f); setDisabled(false); }
    catch (e) { if (e instanceof FeatureDisabledError) { setDisabled(true); return; } setError(e instanceof Error ? e.message : 'load failed'); }
  }, []);
  useEffect(() => { void refresh(orgId); }, [orgId, refresh]);

  const askAnalyst = (): void => { void navigate(`/?agent=${encodeURIComponent(INTELLIGENCE_ANALYST_AGENT)}`); };

  if (disabled) {
    return (
      <div>
        <PageHeader eyebrow={t('eyebrow')} title={t('intelTitle')} lede={t('intelLede')} />
        <StateCard icon={<ActivityIcon size={22} />} title={t('intelNotEnabledTitle')} body={t('intelNotEnabledBody')} />
      </div>
    );
  }

  const hasData = budget && (budget.reallocations.length > 0 || (forecasts && forecasts.length > 0));

  return (
    <div>
      <PageHeader eyebrow={t('eyebrow')} title={t('intelTitle')} lede={t('intelLede')}
        actions={orgId ? <button type="button" className="btn-primary btn-sm" onClick={askAnalyst}><SparklesIcon size={13} /> {t('askAnalyst')}</button> : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}

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

          {budget === null ? (
            <StateCard icon={<ActivityIcon size={20} />} title={t('loading')} loading />
          ) : !hasData ? (
            <StateCard icon={<ActivityIcon size={22} />} title={t('intelEmptyTitle')} body={t('intelEmptyBody')}
              action={<button type="button" className="btn-primary btn-sm" onClick={askAnalyst}><SparklesIcon size={13} /> {t('askAnalyst')}</button>} />
          ) : (
            <>
              <section className="surface-card u-mb-4">
                <h3 className="u-mt-0">{t('budgetTitle')}</h3>
                {budget.reallocations.length === 0 ? (
                  <p className="u-text-muted">{budget.note}</p>
                ) : (
                  <>
                    <Notice variant="info">{budget.note} {budget.projectedRoasGain > 0 ? t('projectedGain', { gain: money(budget.projectedRoasGain) }) : ''}</Notice>
                    <table className="u-w-full">
                      <thead><tr className="u-text-muted u-fs-13"><th className="u-text-left u-py-2">{t('colPlatform')}</th><th className="u-text-right u-py-2">{t('colCurrent')}</th><th className="u-text-right u-py-2">{t('colSuggested')}</th><th className="u-text-right u-py-2">{t('colRoas')}</th></tr></thead>
                      <tbody>
                        {budget.reallocations.map((r) => (
                          <tr key={r.platform}>
                            <td className="u-py-2"><span className="chip chip--muted">{t(`platform_${r.platform}`, { defaultValue: r.platform })}</span></td>
                            <td className="u-text-right u-py-2">{money(r.currentSpend)}</td>
                            <td className="u-text-right u-py-2"><span className={r.changeAmount >= 0 ? 'chip chip--success' : 'chip chip--warning'}>{money(r.suggestedSpend)}</span></td>
                            <td className="u-text-right u-py-2">{roas(r.roas)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </section>

              {forecasts && forecasts.length > 0 ? (
                <section className="surface-card">
                  <h3 className="u-mt-0">{t('forecastTitle')}</h3>
                  <ul className="u-list-none u-m-0 u-p-0">
                    {forecasts.map((f) => (
                      <li key={`${f.platform}-${f.campaignName}`} className="u-flex u-items-center u-gap-3 u-py-2 u-flex-wrap">
                        <span className="u-fw-600">{f.campaignName}</span>
                        <span className="chip chip--muted">{t(`platform_${f.platform}`, { defaultValue: f.platform })}</span>
                        {f.creativeFatigue.detected ? <span className="chip chip--warning">{t('fatigueFlag', { drop: pct(f.creativeFatigue.dropPercent) })}</span> : <span className="chip chip--success">{t('healthy')}</span>}
                        <span className="u-fs-13 u-text-muted u-ml-auto">{t('projectionLabel', { spend: money(f.projection.projectedSpend), conv: formatNumber(f.projection.projectedConversions), days: f.projection.days })}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
