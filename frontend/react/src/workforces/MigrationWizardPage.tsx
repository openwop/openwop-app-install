/**
 * Workflow Migration journey wizard (EP1 MG-0). Walks a company through
 * rebuilding one workflow as a governed Workforce across six stages. RFC-free
 * stages are functional; Shadow & Prove is a marked stub (needs the shadow-run
 * contract); Cut Over reuses the MG-6 graduated-cutover control.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { ArrowLeftIcon, ArrowRightIcon, BuildingIcon, CheckIcon, XIcon } from '../ui/icons/index.js';
import {
  getMigrationJourney,
  getWorkforce,
  getWorkforceGovernance,
  getWorkforceShadow,
  patchMigrationJourney,
  runWorkforceEval,
  updateWorkforceStatus,
  EvalNotEnabledError,
  type MigrationJourney,
  type MigrationStageKey,
  type ShadowEvalSummary,
  type Workforce,
  type WorkforceEvalSummary,
  type WorkforceGovernance,
  type WorkforceStatus,
} from '../client/workforcesClient.js';
import { formatPercent } from '../i18n/format.js';

const STAGES: { key: MigrationStageKey; titleKey: string; blurbKey: string; rfcGated?: boolean }[] = [
  { key: 'target', titleKey: 'stageTargetTitle', blurbKey: 'stageTargetBlurb' },
  { key: 'assess', titleKey: 'stageAssessTitle', blurbKey: 'stageAssessBlurb' },
  { key: 'map-data', titleKey: 'stageMapDataTitle', blurbKey: 'stageMapDataBlurb' },
  { key: 'map-boundaries', titleKey: 'stageMapBoundariesTitle', blurbKey: 'stageMapBoundariesBlurb' },
  { key: 'shadow-prove', titleKey: 'stageShadowProveTitle', blurbKey: 'stageShadowProveBlurb', rfcGated: true },
  { key: 'cut-over', titleKey: 'stageCutOverTitle', blurbKey: 'stageCutOverBlurb' },
];

function pct(n: number): string {
  return formatPercent(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function MigrationWizardPage(): JSX.Element {
  const { t } = useTranslation('workforces');
  const { workforceId = '' } = useParams();
  const [wf, setWf] = useState<Workforce | null>(null);
  const [journey, setJourney] = useState<MigrationJourney | null>(null);
  const [governance, setGovernance] = useState<WorkforceGovernance | null>(null);
  const [shadow, setShadow] = useState<ShadowEvalSummary | null>(null);
  const [evalResult, setEvalResult] = useState<WorkforceEvalSummary | null>(null);
  const [evalState, setEvalState] = useState<'idle' | 'running' | 'unavailable'>('idle');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);

  const runEval = async (): Promise<void> => {
    setEvalState('running');
    try {
      setEvalResult(await runWorkforceEval(workforceId));
      setEvalState('idle');
    } catch (err) {
      if (err instanceof EvalNotEnabledError) setEvalState('unavailable');
      else {
        setEvalState('idle');
        setStageError(err instanceof Error ? err.message : t('evalFailed'));
      }
    }
  };

  // editable form state
  const [target, setTarget] = useState({ workflowId: '', targetOutcome: '' });
  const [dataManifest, setDataManifest] = useState({ dataSources: '', sensitivity: '', approvalModel: '' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getWorkforce(workforceId),
      getMigrationJourney(workforceId).catch(() => null),
      getWorkforceGovernance(workforceId).catch(() => null),
      getWorkforceShadow(workforceId).catch(() => null),
    ])
      .then(([w, j, g, s]) => {
        if (cancelled) return;
        setWf(w);
        setJourney(j);
        setGovernance(g);
        setShadow(s);
        if (j?.target) setTarget(j.target);
        else if (w) setTarget({ workflowId: w.workflowCatalog[0] ?? '', targetOutcome: w.purpose.statement });
        if (j?.dataManifest) setDataManifest(j.dataManifest);
        setError(null);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workforceId]);

  async function save(patch: Parameters<typeof patchMigrationJourney>[1], advance = true): Promise<void> {
    setBusy(true);
    setStageError(null);
    try {
      const updated = await patchMigrationJourney(workforceId, patch);
      setJourney(updated);
      if (advance) setActive((a) => Math.min(a + 1, STAGES.length - 1));
    } catch (e: unknown) {
      setStageError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const back = <Link to={`/workforces/${encodeURIComponent(workforceId)}`} className="chip"><ArrowLeftIcon size={13} /> {t('backToWorkforce')}</Link>;

  if (loading) {
    return <div><PageHeader eyebrow={t('migrationEyebrow')} title={t('loadingTitle')} actions={back} /><Skeleton height={140} /></div>;
  }
  if (error || !wf || !journey) {
    return (
      <div>
        <PageHeader eyebrow={t('migrationEyebrow')} title={t('couldNotLoad')} actions={back} />
        {!wf && !error ? (
          <StateCard icon={<BuildingIcon />} title={t('workforceNotFound')} body={t('noWorkforceNamed', { id: workforceId })} action={back} />
        ) : (
          <Notice variant="error">{error ?? t('unknownError')}</Notice>
        )}
      </div>
    );
  }

  const stage = STAGES[active]!;
  const status = (k: MigrationStageKey): string => journey.stageStatus[k];
  const markDone = (k: MigrationStageKey, advance = true): Promise<void> => save({ stageStatus: { [k]: 'done' } }, advance);

  return (
    <div>
      <PageHeader
        eyebrow={t('migrationJourneyEyebrow')}
        title={t('migrateTitle', { name: wf.name })}
        lede={t('migrationLede')}
        actions={back}
      />

      {/* Stepper */}
      <div className="action-bar u-gap-1-5 u-wrap u-mb-4">
        {STAGES.map((s, i) => {
          const done = status(s.key) === 'done';
          const cls = i === active ? 'chip chip--accent' : done ? 'chip chip--success' : 'chip chip--muted';
          return (
            <button key={s.key} type="button" className={`${cls} u-border-none u-cursor-pointer`} onClick={() => setActive(i)}>
              {done ? <CheckIcon size={12} /> : `${i + 1}.`} {t(s.titleKey)}
            </button>
          );
        })}
      </div>

      <section className="surface-card">
        <h3 className="u-mt-0">{t('stageHeading', { n: active + 1, title: t(stage.titleKey) })}</h3>
        <p className="muted u-mt-0">{t(stage.blurbKey)}</p>

        {stage.key === 'target' ? (
          <div className="migwiz-form-grid">
            <label>{t('targetWorkflow')}
              <select value={target.workflowId} onChange={(e) => setTarget({ ...target, workflowId: e.target.value })} className="u-block u-w-full">
                {wf.workflowCatalog.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>
            <label>{t('targetOutcome')}
              <textarea value={target.targetOutcome} onChange={(e) => setTarget({ ...target, targetOutcome: e.target.value })} rows={2} className="u-block u-w-full" />
            </label>
            <div className="action-bar">
              <button type="button" className="btn" disabled={busy || !target.workflowId} onClick={() => void save({ target, stageStatus: { target: 'done' } })}>{t('saveAndContinue')}</button>
            </div>
          </div>
        ) : null}

        {stage.key === 'assess' ? (
          <div>
            <ul className="migwiz-assess-list">
              {([
                ['assessHasSupervisor', wf.agents.some((a) => a.role === 'supervisor')],
                ['assessHasWorkers', wf.agents.some((a) => a.role === 'worker')],
                ['assessHasGovernance', wf.agents.some((a) => a.role === 'governance')],
                ['assessBoundaries', wf.decisionBoundaries.auto.length + wf.decisionBoundaries.review.length > 0],
                ['assessPurpose', Boolean(wf.purpose.statement) && wf.purpose.policyTags.length > 0],
              ] as const).map(([labelKey, ok]) => (
                <li key={labelKey}>
                  <span className={`chip ${ok ? 'chip--success' : 'chip--danger'}`}>{ok ? t('assessReady') : t('assessMissing')}</span> {t(labelKey)}
                </li>
              ))}
            </ul>
            <button type="button" className="btn" disabled={busy} onClick={() => void markDone('assess')}>{t('markAssessed')}</button>
          </div>
        ) : null}

        {stage.key === 'map-data' ? (
          <div className="migwiz-form-grid">
            <label>{t('dataSources')}<input value={dataManifest.dataSources} onChange={(e) => setDataManifest({ ...dataManifest, dataSources: e.target.value })} placeholder={t('dataSourcesPlaceholder')} className="u-block u-w-full" /></label>
            <label>{t('sensitivity')}<input value={dataManifest.sensitivity} onChange={(e) => setDataManifest({ ...dataManifest, sensitivity: e.target.value })} placeholder={t('sensitivityPlaceholder')} className="u-block u-w-full" /></label>
            <label>{t('approvalModel')}<input value={dataManifest.approvalModel} onChange={(e) => setDataManifest({ ...dataManifest, approvalModel: e.target.value })} placeholder={t('approvalModelPlaceholder')} className="u-block u-w-full" /></label>
            <div className="action-bar">
              <button type="button" className="btn" disabled={busy} onClick={() => void save({ dataManifest, stageStatus: { 'map-data': 'done' } })}>{t('saveAndContinue')}</button>
            </div>
          </div>
        ) : null}

        {stage.key === 'map-boundaries' ? (
          <div>
            <p>{t('boundariesIntro')}</p>
            <div className="action-bar u-gap-2 u-wrap u-mb-2">
              {wf.decisionBoundaries.auto.map((n) => <span key={n} className="chip chip--success">{t('boundaryAuto', { node: n })}</span>)}
              {wf.decisionBoundaries.review.map((n) => <span key={n} className="chip chip--warning">{t('boundaryReview', { node: n })}</span>)}
            </div>
            <button type="button" className="btn" disabled={busy} onClick={() => void save({ boundaries: wf.decisionBoundaries, stageStatus: { 'map-boundaries': 'done' } })}>{t('confirmBoundaries')}</button>
          </div>
        ) : null}

        {stage.key === 'shadow-prove' ? (
          <div>
            <p className="muted u-mt-0">
              {t('shadowEvalIntroLead')} <strong>{t('shadowEvalLiveShadow')}</strong> {t('shadowEvalIntroMid')} <code>EvalSummary</code>. {t('shadowEvalIntroTail')}
            </p>

            {/* Real eval RUN (RFC 0081 §C): dispatches the supervisor over the suite. */}
            <div className="surface-card u-p-3 u-mb-3">
              <div className="action-bar u-justify-between u-gap-3 u-wrap">
                <strong className="u-fs-14">{t('runLiveShadowEval')}</strong>
                <button type="button" className="btn" disabled={evalState === 'running'} onClick={() => void runEval()}>
                  {evalState === 'running' ? t('evalRunning') : evalResult ? t('evalReRun') : t('evalRun')}
                </button>
              </div>
              {evalState === 'unavailable' ? (
                <Notice variant="info">{t('evalUnavailableLead')}<code>agents.evalSuite</code>{t('evalUnavailableTail')}</Notice>
              ) : evalResult ? (
                <>
                  <div className="action-bar migwiz-eval-summary">
                    <span className={`chip ${evalResult.passed ? 'chip--success' : 'chip--warning'}`}>{evalResult.passed ? t('evalPassed') : t('evalBelowBar')}</span>
                    <span className="chip">{t('evalScore', { score: pct(evalResult.aggregateScore) })}</span>
                    <span className="chip chip--muted">{t('evalTasks', { passed: evalResult.passedCount, total: evalResult.taskCount })}</span>
                    <span className="chip chip--muted">{evalResult.suiteId}</span>
                  </div>
                  <ul className="u-m-0 u-fs-13">
                    {evalResult.tasks.map((t) => (
                      <li key={t.taskId}>
                        <span className={`chip ${t.passed ? 'chip--success' : 'chip--danger'} migwiz-task-chip`}>{t.passed ? <CheckIcon size={12} /> : <XIcon size={12} />}</span>
                        {t.taskId}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="muted u-fs-14 u-mbox-t1-5">
                  {t('evalIdleHelpLead')} <code>invoice-exception</code> {t('evalIdleHelpTail')}
                </p>
              )}
            </div>

            {!shadow || shadow.status === 'pending' ? (
              <Notice variant="info">{t('shadowNoEvidence')}</Notice>
            ) : (
              <>
                <div className="action-bar u-gap-3 u-wrap u-mb-2">
                  <span className={`chip ${shadow.passed ? 'chip--success' : 'chip--warning'}`}>{shadow.passed ? t('evalPassed') : t('evalBelowBar')}</span>
                  <span className="chip">{t('shadowScore', { score: pct(shadow.aggregateScore) })}</span>
                  <span className="chip">{t('shadowOverride', { rate: pct(shadow.overrideRate) })}</span>
                  <span className="chip chip--muted">{t('shadowDivergences', { count: shadow.divergenceCount })}</span>
                </div>
                {shadow.findings.length > 0 ? (
                  <details>
                    <summary className="u-cursor-pointer">{t('divergenceFindings', { count: shadow.findings.length })}</summary>
                    <ul className="u-mbox-t2 u-fs-13 u-tabular">
                      {shadow.findings.slice(0, 10).map((d) => (
                        <li key={d.key}>{t('divergenceFindingRow', { key: d.key.slice(0, 16), agentDigest: d.agentDigest.slice(0, 20), baselineDigest: d.baselineDigest.slice(0, 20) })}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            )}
            {(() => {
              const proven = evalResult?.passed || (shadow != null && shadow.status !== 'pending');
              return (
                <button
                  type="button"
                  className="btn u-mt-2"
                  disabled={busy || !proven}
                  title={!proven ? t('markProvenGatedTitle') : undefined}
                  onClick={() => void markDone('shadow-prove')}
                >
                  {t('markProven')}
                </button>
              );
            })()}
          </div>
        ) : null}

        {stage.key === 'cut-over' ? (
          <div>
            <div className="action-bar u-gap-2 u-wrap u-items-center u-mb-2">
              <span className="chip chip--accent">{t('cutOverNow', { status: wf.status })}</span>
              {(['shadow', 'piloting', 'production'] as const).filter((s) => s !== wf.status).map((s) => {
                const gatedOut = s === 'production' && governance?.autonomy.currentTier !== 'auto';
                return (
                  <button
                    key={s}
                    type="button"
                    className="btn"
                    disabled={busy || gatedOut}
                    title={gatedOut ? t('cutOverGatedTitle') : undefined}
                    onClick={() => {
                      setBusy(true); setStageError(null);
                      updateWorkforceStatus(workforceId, s as WorkforceStatus)
                        .then((u) => { setWf(u); if (u.status === 'production') void markDone('cut-over', false); })
                        .catch((e: unknown) => setStageError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setBusy(false));
                    }}
                  ><ArrowRightIcon size={13} /> {t('cutOverTo', { status: s })}</button>
                );
              })}
            </div>
            <div className="muted u-fs-14">
              {t('cutOverNote')}
            </div>
          </div>
        ) : null}

        {stageError ? <Notice variant="error">{stageError}</Notice> : null}

        <div className="action-bar u-mt-4 u-justify-between">
          <button type="button" className="btn" disabled={active === 0} onClick={() => setActive((a) => Math.max(a - 1, 0))}><ArrowLeftIcon size={13} /> {t('stepperBack')}</button>
          <button type="button" className="btn" disabled={active === STAGES.length - 1} onClick={() => setActive((a) => Math.min(a + 1, STAGES.length - 1))}>{t('stepperSkip')} <ArrowRightIcon size={13} /></button>
        </div>
      </section>
    </div>
  );
}
