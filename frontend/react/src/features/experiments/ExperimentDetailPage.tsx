/**
 * One experiment (ADR 0949 P2b), at its own URL (`/experiments/:id?org=`).
 *
 *   draft     → the plan builder (live sample size from the power calculator),
 *               save, and LOCK (a confirm: after it nothing in the plan moves);
 *   locked    → launch (a confirm: it changes what visitors see) or delete;
 *   running   → stop / abandon, and the results;
 *   stopped   → abandon, and the results.
 *
 * Results use Decide vocabulary only: a verdict, an always-valid range per arm
 * and the gates that must be met before any call. There is no "significant"
 * flag anywhere. A legacy test is read-only here and links to where it lives.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import { useFeatureAccess } from '../../featureToggles/FeatureAccessContext.js';
import { useFormat } from '../../i18n/useFormat.js';
import { listPages, listVersions } from '../cms/cmsClient.js';
import {
  ExperimentsRequestError, deleteExperiment, getExperiment, getGates, getResults, lockPlan, powerCalc, reallocate, transition, updateExperiment,
  type DecideResults, type Experiment, type OptimizeConfig, type OptimizeResults, type PlanInput,
} from './experimentsClient.js';
import { ExperimentStatusChip } from './ExperimentStatusChip.js';
import { OptimizeConfigForm, OptimizeResultsPanel } from './OptimizePanel.js';
import { GateChecklist, type GateReport } from './GateChecklist.js';

/** The plan form holds percentages as the user types them. */
interface PlanForm { metric: string; baselinePct: string; mdePts: string; alpha: string; power: string; fdrQ: string; minDays: string; maxDays: string }

const DEFAULT_FORM: PlanForm = { metric: 'conversion', baselinePct: '10', mdePts: '2', alpha: '0.05', power: '0.8', fdrQ: '0.05', minDays: '7', maxDays: '30' };

/** A rate as an editable percentage, rounded off float noise (0.1 → 10, not 10.000000000000002). */
const asPct = (r: number): number => Math.round(r * 1e6) / 1e4;

function formFromPlan(p: PlanInput | undefined): PlanForm {
  if (!p) return DEFAULT_FORM;
  return {
    metric: p.primaryMetric.name, baselinePct: String(asPct(p.baselineRate)), mdePts: String(asPct(p.mde)),
    alpha: String(p.alpha), power: String(p.power), fdrQ: String(p.fdrQ), minDays: String(p.minDays), maxDays: String(p.maxDays),
  };
}

function planFromForm(f: PlanForm): PlanInput {
  return {
    primaryMetric: { kind: 'conversion', name: f.metric.trim() || 'conversion' }, guardrails: [],
    baselineRate: Number(f.baselinePct) / 100, mde: Number(f.mdePts) / 100,
    alpha: Number(f.alpha), power: Number(f.power), fdrQ: Number(f.fdrQ),
    minDays: Number(f.minDays), maxDays: Number(f.maxDays),
  };
}

export function ExperimentDetailPage(): JSX.Element {
  const { t } = useTranslation('experiments');
  const { t: tc } = useTranslation('common');
  const fmt = useFormat();
  const { experimentId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const orgId = searchParams.get('org') ?? '';
  const access = useFeatureAccess('experiments');

  const [exp, setExp] = useState<Experiment | null | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [allResults, setResults] = useState<DecideResults | OptimizeResults | null>(null);
  // Decide and Optimize results never share a view (ADR 0949 D2).
  const results = allResults && allResults.mode === 'decide' ? allResults : null;
  const optimizeResults = allResults && allResults.mode === 'optimize' ? allResults : null;
  const [resultsError, setResultsError] = useState<string | null>(null);
  /** ADR 0950 P0 — the promotion gates (Decide only); `failed` when unreadable. */
  const [gates, setGates] = useState<GateReport | 'failed' | null>(null);
  const [form, setForm] = useState<PlanForm>(DEFAULT_FORM);
  /** The live sample size: a number, `invalid` (the server refused the inputs) or `failed` (it could not be reached). */
  const [sample, setSample] = useState<number | 'invalid' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  /** What each arm's `ref` shows, in words (a version or a page title); a ref
   *  the lookup could not name falls back to the id. */
  const [refLabels, setRefLabels] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!orgId || !experimentId) { setExp(null); return; }
    setLoadFailed(false);
    try {
      const e = await getExperiment(orgId, experimentId);
      setExp(e);
      setForm(formFromPlan(e.plan ?? e.planDraft));
      if (e.startedAt && !e.legacy) {
        try { setResults(await getResults(orgId, experimentId)); setResultsError(null); }
        catch (err) { setResultsError(err instanceof Error ? err.message : t('resultsFailed')); }
        if (e.mode === 'decide') setGates(await getGates(orgId, experimentId).catch((): 'failed' => 'failed'));
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) setExp(null); else { setExp(undefined); setLoadFailed(true); }
    }
  }, [orgId, experimentId, t]);
  useEffect(() => { if (access.enabled) void load(); }, [access.enabled, load]);
  const kind = exp?.surface.kind;
  const target = exp?.surface.ref;
  useEffect(() => {
    if (!kind || !target || !orgId) return;
    const name = (pairs: Array<[string, string]>): void => setRefLabels(Object.fromEntries(pairs));
    if (kind === 'cms.page') {
      void listVersions(orgId, target).then((vs) => name(vs.map((v) => [v.versionId, t('versionOption', { n: fmt.number(v.version), title: v.snapshot.title })])), () => undefined);
    } else {
      void listPages(orgId).then((ps) => name(ps.map((p) => [p.pageId, p.title])), () => undefined);
    }
  }, [kind, target, orgId, t, fmt]);

  // Live sample size while the plan is being edited (a pure server calculation).
  const isOptimize = exp?.mode === 'optimize';
  const editable = !!exp && !exp.legacy && !isOptimize && exp.status === 'draft' && !exp.plan;
  useEffect(() => {
    if (!editable || !orgId) return;
    const p = planFromForm(form);
    const timer = setTimeout(() => {
      void powerCalc(orgId, { baselineRate: p.baselineRate, mde: p.mde, alpha: p.alpha, power: p.power })
        .then(setSample, (err: unknown) => setSample(err instanceof ExperimentsRequestError && err.status === 400 ? 'invalid' : 'failed'));
    }, 300);
    return () => clearTimeout(timer);
  }, [editable, orgId, form]);

  const act = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  }, [load, t]);

  const saveConfig = (config: OptimizeConfig): void => { void act(() => updateExperiment(orgId, experimentId, { optimize: config }), t('configSaved')); };
  const reallocateNow = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await reallocate(orgId, experimentId);
      toast.success(r.outcome === 'appended' ? t('reallocated', { epoch: fmt.number(r.epoch) }) : r.outcome === 'too_soon' ? t('reallocateTooSoon') : t('reallocateExisting'));
      await load();
    } catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };
  const savePlan = (): void => { void act(() => updateExperiment(orgId, experimentId, { plan: planFromForm(form) }), t('planSaved')); };
  const lock = async (): Promise<void> => {
    if (!(await confirm({ title: t('lockConfirmTitle'), body: t('lockConfirmBody'), confirmLabel: t('lockPlan') }))) return;
    void act(() => lockPlan(orgId, experimentId, planFromForm(form)), t('planLocked'));
  };
  const launch = async (): Promise<void> => {
    if (!(await confirm({ title: t('launchConfirmTitle'), body: t('launchConfirmBody'), confirmLabel: t('launch') }))) return;
    void act(() => transition(orgId, experimentId, 'launch'), t('launched'));
  };
  const stopIt = async (): Promise<void> => {
    if (!(await confirm({ title: t('stopConfirmTitle'), body: t('stopConfirmBody'), confirmLabel: t('stop') }))) return;
    void act(() => transition(orgId, experimentId, 'stop'), t('stopped'));
  };
  const abandonIt = async (): Promise<void> => {
    if (!(await confirm({ title: t('abandonConfirmTitle'), body: t('abandonConfirmBody'), confirmLabel: t('abandon'), danger: true }))) return;
    void act(() => transition(orgId, experimentId, 'abandon'), t('abandoned'));
  };
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: t('deleteConfirmTitle'), confirmLabel: t('delete'), danger: true }))) return;
    setBusy(true);
    try { await deleteExperiment(orgId, experimentId); toast.success(t('deleted')); setExp(null); }
    catch (e) { toast.error(e instanceof Error ? e.message : t('actionFailed')); }
    finally { setBusy(false); }
  };

  const back = <Link to={`/experiments${orgId ? `?org=${encodeURIComponent(orgId)}` : ''}`}>{t('backToList')}</Link>;
  const pct = useCallback((r: number) => fmt.percent(r, { maximumFractionDigits: 2 }), [fmt]);
  const pts = useCallback((d: number) => `${d >= 0 ? '+' : ''}${fmt.number(d * 100, { maximumFractionDigits: 2 })}`, [fmt]);
  const verdictText = useMemo(() => {
    if (!results) return '';
    const v = results.verdict;
    if (v.kind === 'winner') return t('verdict_winner', { arm: v.arm });
    if (v.kind === 'insufficient_data') return t(`verdict_insufficient_${v.reason ?? 'no_units'}`);
    return t(`verdict_${v.kind}`);
  }, [results, t]);

  if (access.loading || exp === undefined && !loadFailed) {
    return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('loading')} /><SkeletonRows rows={4} columns={['40%', '20%', '20%', '20%']} /></section>;
  }
  if (!access.enabled) {
    return <section className="u-grid u-gap-4"><PageHeader eyebrow={t('eyebrow')} title={t('title')} /><StateCard title={t('notEnabledTitle')} body={t('notEnabledBody')} /></section>;
  }
  if (loadFailed) {
    return <section className="u-grid u-gap-4">{back}<StateCard announce title={tc('loadFailedTitle')} body={tc('loadFailedBody')} action={<Button variant="secondary" onClick={() => void load()}>{tc('retry')}</Button>} /></section>;
  }
  if (exp === null || exp === undefined) {
    return <section className="u-grid u-gap-4">{back}<StateCard title={t('notFoundTitle')} body={t('notFoundBody')} /></section>;
  }

  const field = (k: keyof PlanForm, label: string, help?: string): JSX.Element => (
    <label className="u-grid u-gap-1">
      <span className="u-label-sm">{label}</span>
      <input inputMode="decimal" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} disabled={!editable} />
      {help ? <span className="u-label-sm muted">{help}</span> : null}
    </label>
  );

  return (
    <section className="u-grid u-gap-4">
      {back}
      <PageHeader eyebrow={t('eyebrow')} title={exp.name} lede={exp.hypothesis || undefined} />
      <div className="action-bar">
        <ExperimentStatusChip experiment={exp} />
        <span className="chip">{t(exp.surface.kind === 'funnel.step' ? 'surfaceFunnelStep' : 'surfaceCmsPage')}</span>
      </div>

      {exp.legacy ? <Notice variant="info">{t('legacyNotice')}</Notice> : null}

      <div className="surface-card u-p-4 u-grid u-gap-2">
        <h2 className="u-m-0">{t('armsTitle')}</h2>
        <table className="data-table">
          <caption className="sr-only">{t('armsTitle')}</caption>
          <thead><tr><th scope="col">{t('colArm')}</th><th scope="col">{t('colContent')}</th><th scope="col">{t('colWeight')}</th></tr></thead>
          <tbody>{exp.arms.map((a, i) => (
            <tr key={a.key}><td>{a.key}{i === 0 ? ` (${t('control')})` : ''}</td><td>{a.ref ? (refLabels[a.ref] ?? <code>{a.ref}</code>) : t('liveContent')}</td><td>{fmt.percent(a.weight / 100)}</td></tr>
          ))}</tbody>
        </table>
      </div>

      {/* Remount on every server change, so the form never shows stale settings. */}
      {!exp.legacy && isOptimize ? <OptimizeConfigForm key={exp.updatedAt} experiment={exp} busy={busy} onSaveConfig={saveConfig} /> : null}

      {!exp.legacy && !isOptimize ? (
        <form className="surface-card u-p-4 surface-form" aria-label={t('planTitle')} onSubmit={(e) => { e.preventDefault(); savePlan(); }}>
          <h2 className="u-m-0">{t('planTitle')}</h2>
          {exp.plan ? <p className="u-label-sm muted u-m-0">{t('planLockedAt', { when: fmt.dateTime(exp.plan.lockedAt) })}</p> : <p className="u-label-sm muted u-m-0">{t('planLede')}</p>}
          {field('metric', t('fieldMetric'), t('fieldMetricHelp'))}
          {field('baselinePct', t('fieldBaseline'), t('fieldBaselineHelp'))}
          {field('mdePts', t('fieldMde'), t('fieldMdeHelp'))}
          {field('alpha', t('fieldAlpha'))}
          {field('power', t('fieldPower'))}
          {field('fdrQ', t('fieldFdr'), t('fieldFdrHelp'))}
          {field('minDays', t('fieldMinDays'), t('fieldMinDaysHelp'))}
          {field('maxDays', t('fieldMaxDays'))}
          <p className="u-m-0" aria-live="polite">
            {exp.plan
              ? t('sampleLocked', { n: fmt.number(exp.plan.minSamplePerArm) })
              : typeof sample === 'number' ? t('sampleNeeded', { n: fmt.number(sample) }) : sample === 'failed' ? t('sampleFailed') : sample === 'invalid' ? t('sampleInvalid') : ''}
          </p>
          {editable ? (
            <span className="action-bar">
              <Button type="submit" variant="secondary" disabled={busy}>{t('savePlan')}</Button>
              <Button type="button" variant="primary" disabled={busy || typeof sample !== 'number'} onClick={() => void lock()}>{t('lockPlan')}</Button>
            </span>
          ) : null}
        </form>
      ) : null}

      {!exp.legacy ? (
        <span className="action-bar">
          {exp.status === 'draft' && (exp.plan || (isOptimize && exp.optimize)) ? <Button variant="primary" disabled={busy} onClick={() => void launch()}>{t('launch')}</Button> : null}
          {exp.status === 'draft' && !exp.startedAt ? <Button variant="quiet" disabled={busy} onClick={() => void remove()}>{t('delete')}</Button> : null}
          {exp.status === 'running' ? <Button variant="secondary" disabled={busy} onClick={() => void stopIt()}>{t('stop')}</Button> : null}
          {exp.status === 'running' || exp.status === 'stopped' ? <Button variant="quiet" disabled={busy} onClick={() => void abandonIt()}>{t('abandon')}</Button> : null}
        </span>
      ) : null}

      {resultsError ? <Notice variant="error" announce={resultsError}>{resultsError}</Notice> : null}
      {!isOptimize && gates ? (
        <div className="surface-card u-p-4 u-grid u-gap-2">
          <span className="action-bar">
            <h2 className="u-m-0">{t('gatesTitle')}</h2>
            <Button variant="quiet" disabled={busy} onClick={() => void load()}>{t('refreshGates')}</Button>
          </span>
          <p className="u-label-sm muted u-m-0">{t('gatesLede')}</p>
          {gates === 'failed' ? <Notice variant="error" announce={t('gatesFailed')}>{t('gatesFailed')}</Notice> : <GateChecklist report={gates} />}
        </div>
      ) : null}
      {isOptimize ? <OptimizeResultsPanel experiment={exp} results={optimizeResults} busy={busy} onReallocate={() => void reallocateNow()} onRefresh={() => void load()} /> : null}
      {results ? (
        <div className="surface-card u-p-4 u-grid u-gap-2">
          <span className="action-bar">
            <h2 className="u-m-0">{t('resultsTitle')}</h2>
            <Button variant="quiet" disabled={busy} onClick={() => void load()}>{t('refreshResults')}</Button>
          </span>
          {results.verdict.kind === 'srm_halt' ? <Notice variant="warning">{t('srmHaltNotice')}</Notice> : null}
          {results.coverage.status === 'partial' ? <Notice variant="warning">{t('coverageNotice')}</Notice> : null}
          <p className="u-m-0"><strong>{t('verdictLabel')}</strong> {verdictText}</p>
          <p className="u-label-sm muted u-m-0">
            {t('gatesLine', { days: fmt.number(results.gates.daysElapsed), minDays: fmt.number(results.gates.minDays), smallest: fmt.number(results.gates.smallestArm), minSample: fmt.number(results.gates.minSamplePerArm) })}
          </p>
          <table className="data-table">
            <caption>{t('captionResults')}</caption>
            <thead><tr>
              <th scope="col">{t('colArm')}</th><th scope="col">{t('colVisitors')}</th><th scope="col">{t('colConversions')}</th>
              <th scope="col">{t('colRate')}</th><th scope="col">{t('colLift')}</th><th scope="col">{t('colRange')}</th>
            </tr></thead>
            <tbody>{results.arms.map((a, i) => (
              <tr key={a.key}>
                <td>{a.key}{i === 0 ? ` (${t('control')})` : ''}</td>
                <td>{fmt.number(a.units)}</td>
                <td>{fmt.number(a.conversions)}</td>
                <td>{pct(a.rate)}</td>
                <td>{a.delta !== undefined ? t('liftPts', { v: pts(a.delta) }) : '—'}</td>
                <td>{a.confidenceSequence && Number.isFinite(a.confidenceSequence[0]) ? t('rangePts', { lo: pts(a.confidenceSequence[0]), hi: pts(a.confidenceSequence[1]) }) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="u-label-sm muted u-m-0">{t('rangeHelp', { level: fmt.percent(1 - (exp.plan?.alpha ?? 0.05)) })}</p>
          <p className="u-label-sm muted u-m-0">{t('computedAt', { when: fmt.dateTime(results.computedAt) })}</p>
        </div>
      ) : null}
    </section>
  );
}
