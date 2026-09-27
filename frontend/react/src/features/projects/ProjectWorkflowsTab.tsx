/**
 * Project workflows tab (ADR 0046) — the project's assigned-workflow portfolio,
 * the project-side sibling of `ProfileWorkflowsTab` / `AgentWorkflowPortfolioPanel`.
 * The pool of workflows the project owns: assign from the library, run now, or
 * unassign. This pool feeds the project's Schedules tab + board trigger lanes.
 * Persisted via `updateWorkflows` (PATCH `/projects/:id`).
 */
import type { RunConfigurable } from '@openwop/openwop';
import { Button } from '../../ui/Button.js';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { AlertIcon, PlayIcon, WorkflowIcon } from '../../ui/icons/index.js';
import { ALL_WORKFLOW_OPTIONS, isKnownWorkflow, workflowName, workflowPurpose } from '../../agents/roleTemplates.js';
import { listWorkflowSummaries, getWorkflowRunInputs, type RunVariable } from '../../workflows/workflowsClient.js';
import { RunInputsDialog } from '../../ui/RunInputsForm.js';
import { createRun } from '../../client/runsClient.js';
import { classifyHttpError } from '../../client/classifyHttpError.js';
import { loadErrorMessage } from '../../client/loadErrorMessage.js';
import { updateWorkflows, type Project } from './projectsClient.js';

export function ProjectWorkflowsTab({ projectId, workflows, canWrite, onSaved }: { projectId: string; workflows: string[]; canWrite: boolean; onSaved: (p: Project) => void }): JSX.Element {
  const { t } = useTranslation('projects');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ workflowId: string; runId: string } | null>(null);
  const [assignId, setAssignId] = useState('');
  const [busy, setBusy] = useState(false);
  // ADR 0163 Phase 6 — the caller's real backend workflows are assignable too.
  const [mine, setMine] = useState<{ workflowId: string; name: string }[]>([]);
  // PRJ-G2 — when this read failed, `mine` stayed `[]`, so every assigned
  // workflow that is not a built-in was judged `known === false`. That rendered
  // a "local only" WARNING (a false claim that the workflow does not exist on
  // the backend) AND disabled its Run button. A transient outage both lied about
  // the portfolio and removed the ability to use it.
  const [mineFailed, setMineFailed] = useState(false);
  useEffect(() => {
    void listWorkflowSummaries()
      .then((rows) => { setMine(rows.map((r) => ({ workflowId: r.workflowId, name: r.name }))); setMineFailed(false); })
      .catch(() => { setMine([]); setMineFailed(true); });
  }, []);

  const save = async (next: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateWorkflows(projectId, next));
    } catch (err) {
      setError(loadErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  };

  const mineById = new Map(mine.map((m) => [m.workflowId, m.name]));

  // Prompt to collect a workflow's declared run inputs (Phase 4). Non-null while the
  // dialog is open for a specific workflow.
  const [runPrompt, setRunPrompt] = useState<{ workflowId: string; name: string; variables: RunVariable[] } | null>(null);

  // Create the run with the supplied inputs (empty for a zero-input workflow) and
  // surface the "view run" link. Shared by the direct path and the dialog.
  const doRun = async (workflowId: string, inputs: Record<string, unknown>, configurable?: RunConfigurable): Promise<void> => {
    setRunning(workflowId);
    setError(null);
    setLastRun(null);
    try {
      const res = await createRun({ workflowId, inputs, metadata: { manual: { source: 'project' } }, ...(configurable ? { configurable } : {}) });
      setLastRun({ workflowId, runId: res.runId });
      setRunPrompt(null);
    } catch (err) {
      // ADR 0482 (ux-1) — a budget-exhausted 429 gets the honest localized
      // budget sentence instead of the raw SDK message.
      setError(classifyHttpError(err).kind === 'budget-exhausted'
        ? t('common:errorBudgetExhausted')
        : loadErrorMessage(t, err));
    } finally {
      setRunning(null);
    }
  };

  const onRunNow = async (workflowId: string): Promise<void> => {
    setError(null);
    setLastRun(null);
    // Read the declared run-input contract; if the workflow asks for inputs, collect
    // them first. A fetch failure (e.g. a built-in role template with no stored def)
    // degrades to a plain run rather than blocking.
    let variables: RunVariable[] = [];
    setRunning(workflowId);
    try {
      variables = await getWorkflowRunInputs(workflowId);
    } catch {
      variables = [];
    } finally {
      setRunning(null);
    }
    if (variables.length > 0) {
      setRunPrompt({ workflowId, name: mineById.get(workflowId) ?? workflowName(workflowId), variables });
      return;
    }
    await doRun(workflowId, {});
  };

  const assignable = [...ALL_WORKFLOW_OPTIONS, ...mine]
    .filter((w, i, arr) => arr.findIndex((x) => x.workflowId === w.workflowId) === i)
    .filter((w) => !workflows.includes(w.workflowId));

  return (
    <div>
      {error && !runPrompt ? <Notice variant="error">{error}</Notice> : null}
      {lastRun ? (
        <Notice variant="success" announce={t('runStarted', { name: workflowName(lastRun.workflowId) })}>
          {t('runStarted', { name: workflowName(lastRun.workflowId) })}{' '}
          <Link to={`/runs/${lastRun.runId}`} className="u-iflex u-items-center u-gap-1">
            <PlayIcon size={12} /> {t('viewRun')}
          </Link>
        </Notice>
      ) : null}

      {workflows.length === 0 ? (
        <StateCard icon={<WorkflowIcon />} title={t('noWorkflowsTitle')} body={canWrite ? t('noWorkflowsBodyWrite') : t('noWorkflowsBodyRead')} />
      ) : (
        <>
          <p className="muted u-fs-13 u-mt-0">
            <Trans i18nKey="workflowsPortfolioIntro" ns="projects" components={{ 0: <strong />, 1: <strong /> }} />
          </p>
          <div className="card-grid u-mb-4">
            {workflows.map((wfId) => {
              const known = mineById.has(wfId) || isKnownWorkflow(wfId);
              return (
                <div key={wfId} className="surface-card">
                  <div className="u-fw-600">{mineById.get(wfId) ?? workflowName(wfId)}</div>
                  <div className="agentportfolio-purpose">{workflowPurpose(wfId) ?? (known || mineFailed ? '' : t('localWorkflowPurpose'))}</div>
                  {/* Unverifiable is NOT the same as local-only. When the summary
                      read failed we do not know either way, so we say that
                      instead of asserting the workflow is missing. */}
                  {!known && mineFailed ? (
                    <div className="u-flex u-gap-1 u-items-center u-fs-12 muted">
                      <AlertIcon size={13} /> {t('workflowsUnverified')}
                    </div>
                  ) : !known ? (
                    <div className="u-flex u-gap-1 u-items-center u-fs-12 u-text-warning">
                      <AlertIcon size={13} /> {t('localOnlyWarning')}
                    </div>
                  ) : null}
                  <div className="action-bar">
                    {/* Left ENABLED when the read failed: a run that turns out to
                        be impossible reports a real error, which is strictly
                        better than a dead button justified by a guess.

                        ADR 0608 D8 (`CPU-3`) — but PRE-GATED on `canWrite` now.
                        `FEATURES.md:189` names `workflows` in the set the FE
                        "pre-gates … instead of affordances that 403", and this
                        control was the one place that claim was FALSE: a read-only
                        member was offered a live, write-shaped action. It is not
                        even the shown-then-403 case — `createRun` is authorized by
                        the generic `runs:create` scope, entirely outside the
                        project ACL, so the run would actually START. */}
                    {canWrite ? (
                      <Button variant="primary" size="sm" disabled={(!known && !mineFailed) || running === wfId} onClick={() => void onRunNow(wfId)}>
                        {running === wfId ? t('running') : t('runNow')}
                      </Button>
                    ) : null}
                    {canWrite ? (
                      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void save(workflows.filter((w) => w !== wfId))}>
                        {t('unassign')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {canWrite ? (
        <div className="agentportfolio-assign">
          <strong className="u-fs-14">{t('assignWorkflowHeading')}</strong>
          {/* UX_UPGRADE-projects R2 (PRJ2-M2) — the SAME failed read PRJ-G2
              closed above still silently truncates this picker. `assignable`
              is `[...ALL_WORKFLOW_OPTIONS, ...mine]`, and with `mine === []`
              the dropdown offers exactly the in-tree role templates: every
              workflow the user actually BUILT is gone, with a full-looking
              list and no disclosure. Round 1 fixed how the failure reads in
              the portfolio above and left the picker asserting completeness. */}
          {mineFailed ? (
            <Notice variant="warning" announce={t('assignListIncomplete')}>{t('assignListIncomplete')}</Notice>
          ) : null}
          <div className="action-bar u-mt-2">
            <select className="ui-input u-minw-240" value={assignId} onChange={(e) => setAssignId(e.target.value)} aria-label={t('workflowToAssignAria')}>
              <option value="">{t('chooseWorkflow')}</option>
              {assignable.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
            </select>
            <Button variant="primary" disabled={!assignId || busy} onClick={() => { void save([...workflows, assignId]); setAssignId(''); }}>
              {t('assignWorkflow')}
            </Button>
            <Link to="/builder" className="agentportfolio-create-link">{t('createFromTemplate')}</Link>
          </div>
        </div>
      ) : null}

      {runPrompt ? (
        <RunInputsDialog
          workflowName={runPrompt.name}
          variables={runPrompt.variables}
          busy={running === runPrompt.workflowId}
          error={error}
          onRun={(inputs, configurable) => void doRun(runPrompt.workflowId, inputs, configurable)}
          onCancel={() => { setError(null); setRunPrompt(null); }}
        />
      ) : null}
    </div>
  );
}
