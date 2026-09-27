/**
 * Campaign Intelligence page (ADR 0160, Phase 2). Budget recommendations +
 * forecast over the performance store, on the shared ui/ layer, with an "Ask the
 * Analyst" deep-link to the one chat (ADR 0058). NOT a parallel analytics
 * dashboard — recommendations + the agent, the "build ON orchestration" rule.
 *
 * @see docs/adr/0160-campaign-studio-intelligence.md
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { scrollBehavior } from '../../ui/motion.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { TextField, SelectField } from '../../ui/Field.js';
import { ActivityIcon, SparklesIcon, ArrowUpIcon, ArrowDownIcon, CheckIcon, AlertIcon, BanIcon, MailIcon } from '../../ui/icons/index.js';
import { formatNumber, formatCurrency, formatDate, formatDateTime } from '../../i18n/format.js';
import {
  getBudget,
  getAnomalies,
  type Anomaly, getForecast, getAttribution, getPacing, listOrgs, FeatureDisabledError, INTELLIGENCE_ANALYST_AGENT,
  type BudgetRecommendation, type CampaignForecast, type OrgRef, type AttributionReport, type PacingReport,
  planBudget, type BudgetPlanDto,
} from './campaignIntelClient.js';

// CMPUX-15: currency is threaded from the read model (per-row for attribution +
// pacing, report-level otherwise) — no hardcoded USD.
const money = (n: number, currency: string): string => formatCurrency(n, currency, { maximumFractionDigits: 0 });
const roas = (n: number): string => `${formatNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
const pct = (n: number): string => `${formatNumber(n, { maximumFractionDigits: 0 })}%`;

/** FU-UX-4: the `~` approximation glyph carries meaning with no accessible
 *  equivalent — render it via i18n with an sr-only "approximately …" mirror,
 *  the same treatment as the page's sr-only em-dash fallback. `sentenceKey`
 *  (a `{{value}}`-parameterized key) wraps the value in a full sentence so
 *  word order stays localizable. */
function Approx({ value, sentenceKey }: { value: string; sentenceKey?: string }): JSX.Element {
  const { t } = useTranslation('campaign-intel');
  const visible = t('approxValue', { value });
  const spoken = t('approxValueAria', { value });
  return (
    <>
      <span aria-hidden="true">{sentenceKey ? t(sentenceKey, { value: visible }) : visible}</span>
      <span className="sr-only">{sentenceKey ? t(sentenceKey, { value: spoken }) : spoken}</span>
    </>
  );
}

export function CampaignIntelPage(): JSX.Element {
  const { t } = useTranslation('campaign-intel');
  const { t: tc } = useTranslation('common');
  // ADR 0357 P1 — the goal-based planner form ("$X → N conversions").
  const [goalBudget, setGoalBudget] = useState('');
  const [goalConversions, setGoalConversions] = useState('');
  const [goalDays, setGoalDays] = useState('90');
  const [plan, setPlan] = useState<BudgetPlanDto | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  // CS-UX-1: the planner's failure is surfaced inline (and cleared on the next
  // attempt) instead of silently blanking the result.
  const [planError, setPlanError] = useState<string | null>(null);
  const runPlan = async (): Promise<void> => {
    if (!orgId) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const r = await planBudget(orgId, {
        totalBudgetMinor: Math.round(Number(goalBudget) * 100),
        targetConversions: Math.floor(Number(goalConversions)),
        horizonDays: Math.floor(Number(goalDays)) || 90,
      });
      setPlan(r.plan);
    } catch (e) { setPlan(null); setPlanError(e instanceof Error && e.message ? e.message : t('planFailed')); }
    finally { setPlanBusy(false); }
  };
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [orgs, setOrgs] = useState<OrgRef[]>([]);
  const [orgsFailed, setOrgsFailed] = useState(false);
  // Deep-link spine (Phase 3): a campaign.pacing notification lands here with
  // ?org=&campaign= — honor the org one-shot and scroll to + highlight the row.
  const [orgId, setOrgId] = useState(() => searchParams.get('org') ?? '');
  const focusCampaign = searchParams.get('campaign');
  const focusRef = useRef<HTMLLIElement | null>(null);
  const [budget, setBudget] = useState<BudgetRecommendation | null>(null);
  const [forecasts, setForecasts] = useState<CampaignForecast[] | null>(null);
  const [attribution, setAttribution] = useState<AttributionReport | null>(null);
  const [pacing, setPacing] = useState<PacingReport | null>(null);
  // R3 CI-SP-8 remainder — the anomaly detector (ADR 0357 P2), built-but-
  // unreachable until now. null = not loaded/failed (named in sectionsFailed).
  const [anomalies, setAnomalies] = useState<Anomaly[] | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CI-R2-1 — the noOrg claim below must never ride a failed orgs read
  // (the BRAND-R2-1 shape, fixed cluster-wide this round).
  useEffect(() => { void listOrgs().then((o) => { setOrgs(o); setOrgsFailed(false); setOrgId((cur) => (cur && o.some((x) => x.orgId === cur)) ? cur : (o[0]?.orgId || '')); }).catch(() => setOrgsFailed(true)); }, []);
  // Scroll to AND focus the deep-linked row so keyboard/SR users land on it, not
  // the top of the document (grade-ux DL-UX-2). The row is tabIndex=-1 below.
  useEffect(() => { if (focusCampaign && focusRef.current) { focusRef.current.scrollIntoView({ block: 'center', behavior: scrollBehavior() }); focusRef.current.focus({ preventScroll: true }); } }, [focusCampaign, pacing]);

  // R2 CI-SP-1/2 — a real load phase (a failed budget read used to leave the
  // `budget === null` loading card up FOREVER, hiding sections whose reads
  // succeeded), and a per-invocation guard: the OLD org's slower batch could
  // resolve last and put org A's money under org B's name. All five states
  // reset on entry so the previous org's figures never display mid-switch
  // (the dashboard's own useOrgResource discipline).
  const [phase, setPhase] = useState<'idle' | 'loading' | 'done'>('idle');
  const refreshSeq = useRef(0);
  const refresh = useCallback(async (org: string) => {
    const seq = ++refreshSeq.current;
    setBudget(null); setForecasts(null); setAttribution(null); setPacing(null); setAnomalies(null); setError(null);
    if (!org) { setPhase('idle'); return; }
    setPhase('loading');
    // CI-G2 — four INDEPENDENT reports. `Promise.all` rejected the whole batch on
    // any one failure, so a single flaky sub-report left every section blank (all
    // four states stay null) behind one error line. Settle them separately: each
    // section renders what it has, and only the ones that actually failed are
    // reported missing.
    const [b, f, a, p, an] = await Promise.allSettled([getBudget(org), getForecast(org), getAttribution(org), getPacing(org), getAnomalies(org)]);
    if (seq !== refreshSeq.current) return; // a newer refresh owns the screen
    // The toggle gate is a property of the FEATURE, not of one report — any
    // report answering "disabled" disables the page, as before.
    const reasons = [b, f, a, p, an].flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (reasons.some((e) => e instanceof FeatureDisabledError)) { setDisabled(true); return; }
    setDisabled(false);
    setBudget(b.status === 'fulfilled' ? b.value : null);
    setForecasts(f.status === 'fulfilled' ? f.value : null);
    setAttribution(a.status === 'fulfilled' ? a.value : null);
    setPacing(p.status === 'fulfilled' ? p.value : null);
    setAnomalies(an.status === 'fulfilled' ? an.value : null);
    const failed = ([['budgetTitle', b], ['forecastTitle', f], ['attributionTitle', a], ['pacingTitle', p], ['anomaliesTitle', an]] as const)
      .filter(([, r]) => r.status === 'rejected')
      .map(([k]) => t(k));
    setError(failed.length > 0 ? t('sectionsFailed', { sections: failed.join(', ') }) : null);
    setPhase('done');
  }, [t]);
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

  // R2 CI-SP-1 — data presence no longer requires the BUDGET read to have
  // succeeded (its failure used to present three healthy sections as absent).
  const hasData = (budget && budget.reallocations.length > 0) || (forecasts && forecasts.length > 0) || (attribution && attribution.rows.length > 0) || (pacing && pacing.rows.length > 0);
  // CMPUX-15: a page-level display currency for the org-wide sections (budget
  // reallocation + forecast) that carry no per-row currency; attribution +
  // pacing rows use their own per-row currency below.
  const displayCurrency = attribution?.currency ?? 'USD';
  // CI-G1 — when the org's campaigns span several currencies the report-level
  // `currency` is a neutral DEFAULT, not a fact about this org, and there is no
  // FX — so these org-wide sums are not in any single currency. Labelling them
  // `$` states something false; an unlabelled figure plus a note does not.
  // R2 CI-SP-4 — the mixed flag rides ONLY the attribution report: when that
  // read FAILS, the currency is UNKNOWN, not single — guessing an arbitrary
  // pacing row's currency re-labelled the mixed org's figures, resurrecting
  // the exact defect round 1 fixed. Unknown renders unlabelled too.
  const currencyMixed = attribution?.currencyMixed === true;
  const currencyUnknown = attribution === null;
  const unlabelled = currencyMixed || currencyUnknown;
  // R2 CI-SP-9 — the honest "data through" marker: the newest spend date the
  // attribution lineage actually saw (per-row on the wire; max across rows).
  const latestSpendDate = (attribution?.rows ?? [])
    .map((r) => r.lineage?.latestSpendDate)
    .filter((d): d is string => typeof d === 'string')
    .sort()
    .at(-1) ?? null;
  const orgMoney = (n: number): string =>
    unlabelled ? formatNumber(n, { maximumFractionDigits: 0 }) : money(n, displayCurrency);
  // R2 CI-SP-5 (display half) — the planner lane mints "minor" as major×100
  // regardless of currency (store spend carries no currency — CI-SP-13), so the
  // display must divide by the SAME 100, not the ISO exponent: the old
  // formatCurrencyMinor branch showed JPY planner figures 100× too large while
  // the mixed branch two characters away divided by 100. One convention, both
  // branches, mint-consistent.
  const orgMoneyMinor = (minor: number): string =>
    unlabelled ? formatNumber(minor / 100, { maximumFractionDigits: 0 }) : money(minor / 100, displayCurrency);

  return (
    <div data-walkthrough="campaign-intelligence.page">
      <PageHeader eyebrow={t('eyebrow')} title={t('intelTitle')} lede={t('intelLede')}
        actions={orgId ? <Button variant="primary" size="sm" onClick={askAnalyst}><SparklesIcon size={13} /> {t('askAnalyst')}</Button> : undefined} />
      {error ? <Notice variant="error">{error}</Notice> : null}

      {orgs.length === 0 ? (
        orgsFailed ? (
          <StateCard announce icon={<ActivityIcon size={22} />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
        ) : (
        <StateCard icon={<ActivityIcon size={22} />} title={t('noOrgTitle')} body={t('noOrgBody')} />
        )
      ) : (
        <>
          {orgs.length > 1 ? (
            <div className="u-mb-4">
              <SelectField label={t('fieldOrg')} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.name}</option>)}
              </SelectField>
            </div>
          ) : null}

          {phase !== 'done' ? (
            <StateCard icon={<ActivityIcon size={20} />} title={t('loading')} loading />
          ) : (
            <>
              {/* CI-G1 — say why the org-wide figures carry no currency symbol.
                  R2 CI-SP-13 — the note now also covers the RECOMMENDATIONS'
                  validity (they compare across currencies unconverted). */}
              {currencyMixed ? <Notice variant="info">{t('currencyMixedNote')} {t('currencyMixedRecsNote')}</Notice> : null}
              {/* R2 CI-SP-9 — data freshness: the store is the daily-sync/CSV
                  lane, so "computed now" can still be days-old data. Say what
                  the numbers run through, and offer a real refresh. */}
              {(attribution ?? pacing) ? (
                <p className="muted u-fs-13 u-mt-0">
                  {latestSpendDate ? <>{t('dataThrough', { date: formatDate(latestSpendDate) })} · </> : null}
                  {t('computedAtLabel', { when: formatDateTime((attribution ?? pacing)!.computedAt) })}
                  {' '}<Button variant="link" className="u-fs-13" onClick={() => void refresh(orgId)}>{tc('retry')}</Button>
                </p>
              ) : null}
              {/* R2 CI-SP-12 — a pacing alert deep-link can outlive its campaign;
                  landing silently on a page that neither shows it nor explains
                  its absence reads as a broken link. */}
              {focusCampaign && pacing && !pacing.rows.some((r) => r.campaignId === focusCampaign) ? (
                <Notice variant="info">{t('focusCampaignGone')}</Notice>
              ) : null}
              {/* ADR 0357 P1 — goal-based planning: deterministic math, labeled
                  confidence. CS-UX-16: rendered regardless of `hasData` so a
                  data-less org still discovers the planner — submitting without
                  history returns the localized no-history note inline. */}
              <section className="surface-card u-mb-4">
                <h2 className="u-mt-0 u-fs-15">{t('goalTitle')}</h2>
                {/* CS-UX-10: a real form so Enter in any field submits the plan. */}
                <form className="u-flex u-gap-2 u-wrap u-items-end" onSubmit={(e) => { e.preventDefault(); void runPlan(); }}>
                  {/* CI-G3 — the budget is entered in MAJOR units and the planner
                      is the one place on this page a figure is authored rather
                      than reported; the help slot is where that belongs. */}
                  <TextField label={t('goalBudget')} help={t('goalBudgetHelp')} type="number" min="1"
                    value={goalBudget} onChange={(e) => setGoalBudget(e.target.value)} placeholder="50000" />
                  <TextField label={t('goalConversions')} type="number" min="1"
                    value={goalConversions} onChange={(e) => setGoalConversions(e.target.value)} placeholder="500" />
                  <TextField label={t('goalDays')} help={t('goalDaysHelp')} type="number" min="7"
                    value={goalDays} onChange={(e) => setGoalDays(e.target.value)} />
                  <Button variant="primary" type="submit" disabled={planBusy || !goalBudget || !goalConversions}>{planBusy ? t('common:loading') : t('goalPlan')}</Button>
                </form>
                {planError ? <Notice variant="error">{planError}</Notice> : null}
                {plan ? (
                  <div className="u-grid u-gap-1 u-mt-2">
                    <div className="u-flex u-gap-2 u-items-center">
                      <span className={`chip ${plan.verdict === 'feasible' ? 'chip--success' : plan.verdict === 'stretch' ? 'chip--warning' : 'chip--danger'}`}>{t(`verdict_${plan.verdict}`)}</span>
                      <span className="u-label-sm"><Approx value={formatNumber(plan.expectedConversions)} sentenceKey="goalExpected" /></span>
                      <span className="u-label-sm">{t('goalConfidence', { level: t(`confidence_${plan.confidence}`) })}</span>
                    </div>
                    {/* POLISH-1: render from the structured noteCode (localized ×4);
                        the raw English `note` is only the fallback for a plan from
                        an older backend that carries no code. */}
                    {plan.noteCode ? (
                      // FU-UX-2/3: an unknown noteCode from a newer backend must
                      // fall back to the server prose, not render the literal
                      // i18n key — and the structured params interpolate.
                      <p className="muted u-fs-13 u-m-0">{t(`planNote_${plan.noteCode}`, { defaultValue: plan.note ?? '', ...plan.noteParams })}</p>
                    ) : plan.note ? (
                      <p className="muted u-fs-13 u-m-0">{plan.note}</p>
                    ) : null}
                    {plan.platforms.length > 0 ? (
                      <ul className="u-m-0">
                        {plan.platforms.map((pl) => (
                          <li key={pl.platform} className="u-fs-13">{pl.platform}: {orgMoneyMinor(pl.allocationMinor)} → <Approx value={formatNumber(pl.expectedConversions)} /> {t('goalConvUnit')}</li>
                        ))}
                      </ul>
                    ) : null}
                    {/* CS-UX-16: the weekly pacing the plan already computes —
                        budget + expected-conversion share per week. */}
                    {plan.pacing.length > 0 ? (
                      <div>
                        <h3 className="u-fs-13 u-mt-2 u-mb-1">{t('pacingWeeksTitle')}</h3>
                        <div className="table-scroll table--stack">
                          <table className="u-w-full">
                            <thead><tr className="muted u-fs-13"><th scope="col" className="u-text-left u-py-2">{t('colWeek')}</th><th scope="col" className="u-text-right u-py-2">{t('colWeekBudget')}</th><th scope="col" className="u-text-right u-py-2">{t('colWeekExpected')}</th></tr></thead>
                            <tbody>
                              {plan.pacing.map((w) => (
                                <tr key={w.week} className="u-fs-13">
                                  <td className="u-py-2"><span className="data-stack-label">{t('colWeek')}</span>{t('weekLabel', { week: w.week })}</td>
                                  <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colWeekBudget')}</span>{orgMoneyMinor(w.budgetMinor)}</td>
                                  <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colWeekExpected')}</span>{typeof w.expectedConversions === 'number' ? <Approx value={formatNumber(w.expectedConversions)} /> : <><span aria-hidden="true">—</span><span className="sr-only">{t('valueUnavailable')}</span></>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {!hasData ? (
                // R2 CI-SP-1 — "Not enough data yet" is a claim about the DATA;
                // it must never ride failed reads (three rejections used to
                // render as an empty-data assertion). With failures present the
                // sectionsFailed notice above is the honest story.
                error ? null : (
                <StateCard icon={<ActivityIcon size={22} />} title={t('intelEmptyTitle')} body={t('intelEmptyBody')}
                  action={<Button variant="primary" size="sm" onClick={askAnalyst}><SparklesIcon size={13} /> {t('askAnalyst')}</Button>} />
                )
              ) : (
                <>
              {budget ? (
              <section className="surface-card u-mb-4">
                <h2 className="u-mt-0 u-fs-15">{t('budgetTitle')}</h2>
                {budget.reallocations.length === 0 ? (
                  // R2 CI-SP-3 — localized from the structured code; the raw
                  // English prose is only the older-backend fallback.
                  <p className="muted">{budget.noteCode ? t(`budgetNote_${budget.noteCode}`, { defaultValue: budget.note, shift: orgMoney(budget.noteParams?.shift ?? 0), from: budget.noteParams?.from ?? '', to: budget.noteParams?.to ?? '' }) : budget.note}</p>
                ) : (
                  <>
                    <Notice variant="info">{budget.noteCode ? t(`budgetNote_${budget.noteCode}`, { defaultValue: budget.note, shift: orgMoney(budget.noteParams?.shift ?? 0), from: budget.noteParams?.from ?? '', to: budget.noteParams?.to ?? '' }) : budget.note} {budget.projectedRoasGain > 0 ? t('projectedGain', { gain: orgMoney(budget.projectedRoasGain) }) : ''}</Notice>
                    <div className="table-scroll table--stack">
                    <table className="u-w-full">
                      <thead><tr className="muted u-fs-13"><th scope="col" className="u-text-left u-py-2">{t('colPlatform')}</th><th scope="col" className="u-text-right u-py-2">{t('colCurrent')}</th><th scope="col" className="u-text-right u-py-2">{t('colSuggested')}</th><th scope="col" className="u-text-right u-py-2">{t('colRoas')}</th></tr></thead>
                      <tbody>
                        {budget.reallocations.map((r) => (
                          <tr key={r.platform}>
                            <td className="u-py-2"><span className="data-stack-label">{t('colPlatform')}</span><span className="chip chip--muted">{t(`platform_${r.platform}`, { defaultValue: r.platform })}</span></td>
                            <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colCurrent')}</span>{orgMoney(r.currentSpend)}</td>
                            <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colSuggested')}</span><span role="img" className={r.changeAmount >= 0 ? 'chip chip--success' : 'chip chip--warning'} aria-label={r.changeAmount >= 0 ? t('spendIncreaseLabel', { amount: orgMoney(r.suggestedSpend) }) : t('spendDecreaseLabel', { amount: orgMoney(r.suggestedSpend) })}>{r.changeAmount >= 0 ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />} {orgMoney(r.suggestedSpend)}</span></td>
                            <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colRoas')}</span>{roas(r.roas)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </>
                )}
              </section>
              ) : null}

              {pacing && pacing.rows.length > 0 ? (
                <section className="surface-card u-mb-4">
                  <h2 className="u-mt-0 u-fs-15">{t('pacingTitle')}</h2>
                  <ul className="u-list-none u-m-0 u-p-0">
                    {pacing.rows.map((r) => {
                      const focused = r.campaignId === focusCampaign;
                      return (
                      <li key={r.campaignId} ref={focused ? focusRef : undefined} tabIndex={focused ? -1 : undefined} aria-current={focused ? 'location' : undefined} className={`u-flex u-items-center u-gap-3 u-py-2 u-flex-wrap${focused ? ' is-deeplink-focus' : ''}`}>
                        <span className="u-fw-600">{r.name}</span>
                        <span className={r.band === 'over' ? 'chip chip--danger' : r.band === 'warning' ? 'chip chip--warning' : 'chip chip--success'}>
                          {r.band === 'over' ? <BanIcon size={12} /> : r.band === 'warning' ? <AlertIcon size={12} /> : <CheckIcon size={12} />}
                          {' '}{t(`pacingBand_${r.band}`)} · {pct(r.spentPct)}
                        </span>
                        {/* R2 CI-SP-8 — the projection was computed, typed, and
                            rendered nowhere. */}
                        <span className="u-fs-13 muted u-ml-auto">{t('pacingSpendOfBudget', { spend: money(r.spend, r.currency), budget: money(r.budget, r.currency) })}{typeof r.projectedMonthlySpend === 'number' ? ` · ${t('pacingProjected', { amount: money(r.projectedMonthlySpend, r.currency) })}` : ''}</span>
                      </li>
                    );})}
                  </ul>
                  {pacing.unplanned > 0 ? <p className="muted u-fs-13 u-mb-0">{t('pacingUnplanned', { count: pacing.unplanned })}</p> : null}
                </section>
              ) : null}

              {/* R3 CI-SP-8 remainder — the ADR 0357 P2 anomaly detector,
                  built-but-unreachable until now. Renders only when anomalies
                  EXIST — a clean scan renders nothing (the section would
                  otherwise assert an empty claim over a maybe-thin series);
                  a FAILED read is already named by sectionsFailed above. */}
              {anomalies && anomalies.length > 0 ? (
                <section className="surface-card u-mb-4">
                  <h2 className="u-mt-0 u-fs-15">{t('anomaliesTitle')}</h2>
                  <p className="muted u-fs-13 u-mt-0">{t('anomaliesLede')}</p>
                  <ul className="u-list-none u-m-0 u-p-0">
                    {anomalies.slice(0, 20).map((a) => (
                      <li key={`${a.platform}-${a.campaignName}-${a.metric}-${a.date}`} className="u-flex u-items-center u-gap-3 u-py-2 u-flex-wrap">
                        <span className="u-fw-600">{a.campaignName}</span>
                        <span className="chip chip--muted">{a.platform}</span>
                        <span className={a.direction === 'spike' ? 'chip chip--warning' : 'chip chip--danger'}>
                          {a.direction === 'spike' ? <AlertIcon size={12} /> : <BanIcon size={12} />}
                          {' '}{t(`anomaly_${a.direction}`, { metric: t(`anomalyMetric_${a.metric}`) })}
                        </span>
                        <span className="u-fs-13 muted u-ml-auto">{t('anomalyDetail', { date: a.date, z: formatNumber(a.z, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) })}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {attribution && attribution.rows.length > 0 ? (
                <section className="surface-card u-mb-4">
                  <h2 className="u-mt-0 u-fs-15">{t('attributionTitle')}</h2>
                  <p className="muted u-fs-13 u-mt-0">{t('attributionHint')}</p>
                  <div className="table-scroll table--stack">
                  <table className="u-w-full">
                    <thead><tr className="muted u-fs-13"><th scope="col" className="u-text-left u-py-2">{t('colCampaign')}</th><th scope="col" className="u-text-right u-py-2">{t('colSpend')}</th><th scope="col" className="u-text-right u-py-2">{t('colPlatformConv')}</th><th scope="col" className="u-text-right u-py-2">{t('colWebConv')}</th><th scope="col" className="u-text-right u-py-2">{t('colCpa')}</th></tr></thead>
                    <tbody>
                      {attribution.rows.map((r) => (
                        <tr key={r.campaignId}>
                          <td className="u-py-2"><span className="data-stack-label">{t('colCampaign')}</span><span className="u-fw-600">{r.name}</span>{r.emailEngagement ? <span className="chip chip--muted u-ml-2"><MailIcon size={12} aria-hidden="true" /> <span aria-hidden="true">{t('emailRollup', { opens: formatNumber(r.emailEngagement.opens), clicks: formatNumber(r.emailEngagement.clicks) })}</span><span className="sr-only">{t('emailRollupAria', { opens: formatNumber(r.emailEngagement.opens), clicks: formatNumber(r.emailEngagement.clicks) })}</span></span> : null}</td>
                          <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colSpend')}</span>{money(r.spend, r.currency)}</td>
                          <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colPlatformConv')}</span>{formatNumber(r.platformConversions)}</td>
                          <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colWebConv')}</span>{formatNumber(r.webConversions)}</td>
                          <td className="u-text-right u-py-2"><span className="data-stack-label">{t('colCpa')}</span>{r.webConversions > 0 ? money(r.attributedCpa, r.currency) : <><span aria-hidden="true">—</span><span className="sr-only">{t('cpaNotApplicable')}</span></>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  {attribution.unattributedConversions > 0 ? <p className="muted u-fs-13 u-mb-0">{t('unattributed', { count: attribution.unattributedConversions })}</p> : null}
                </section>
              ) : null}

              {forecasts && forecasts.length > 0 ? (
                <section className="surface-card">
                  <h2 className="u-mt-0 u-fs-15">{t('forecastTitle')}</h2>
                  <ul className="u-list-none u-m-0 u-p-0">
                    {forecasts.map((f) => (
                      <li key={`${f.platform}-${f.campaignName}`} className="u-flex u-items-center u-gap-3 u-py-2 u-flex-wrap">
                        <span className="u-fw-600">{f.campaignName}</span>
                        <span className="chip chip--muted">{t(`platform_${f.platform}`, { defaultValue: f.platform })}</span>
                        {f.creativeFatigue.detected ? <span className="chip chip--warning"><AlertIcon size={12} /> {t('fatigueFlag', { drop: pct(f.creativeFatigue.dropPercent) })}</span> : <span className="chip chip--success"><CheckIcon size={12} /> {t('healthy')}</span>}
                        <span className="u-fs-13 muted u-ml-auto">{t('projectionLabel', { spend: orgMoney(f.projection.projectedSpend), conv: formatNumber(f.projection.projectedConversions), days: f.projection.days })}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
