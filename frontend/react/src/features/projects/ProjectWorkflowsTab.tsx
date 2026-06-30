/**
 * Project workflows tab (ADR 0046) — the project's assigned-workflow portfolio,
 * the project-side sibling of `ProfileWorkflowsTab` / `AgentWorkflowPortfolioPanel`.
 * The pool of workflows the project owns: assign from the library, run now, or
 * unassign. This pool feeds the project's Schedules tab + board trigger lanes.
 * Persisted via `updateWorkflows` (PATCH `/projects/:id`).
 */
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { AlertIcon, PlayIcon, WorkflowIcon } from '../../ui/icons/index.js';
import { ALL_WORKFLOW_OPTIONS, isKnownWorkflow, workflowName, workflowPurpose } from '../../agents/roleTemplates.js';
import { listWorkflowSummaries } from '../../workflows/workflowsClient.js';
import { createRun } from '../../client/runsClient.js';
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
  useEffect(() => {
    void listWorkflowSummaries()
      .then((rows) => setMine(rows.map((r) => ({ workflowId: r.workflowId, name: r.name }))))
      .catch(() => setMine([]));
  }, []);

  const save = async (next: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateWorkflows(projectId, next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRunNow = async (workflowId: string): Promise<void> => {
    setRunning(workflowId);
    setError(null);
    setLastRun(null);
    try {
      const res = await createRun({ workflowId, metadata: { manual: { source: 'project' } } });
      setLastRun({ workflowId, runId: res.runId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  const assignable = [...ALL_WORKFLOW_OPTIONS, ...mine]
    .filter((w, i, arr) => arr.findIndex((x) => x.workflowId === w.workflowId) === i)
    .filter((w) => !workflows.includes(w.workflowId));
  const mineById = new Map(mine.map((m) => [m.workflowId, m.name]));

  return (
    <div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {lastRun ? (
        <Notice variant="success">
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
                  <div className="agentportfolio-purpose">{workflowPurpose(wfId) ?? (known ? '' : t('localWorkflowPurpose'))}</div>
                  {!known ? (
                    <div className="u-flex u-gap-1 u-items-center u-fs-12 u-text-warning">
                      <AlertIcon size={13} /> {t('localOnlyWarning')}
                    </div>
                  ) : null}
                  <div className="action-bar">
                    <button type="button" className="primary btn-sm" disabled={!known || running === wfId} onClick={() => void onRunNow(wfId)}>
                      {running === wfId ? t('running') : t('runNow')}
                    </button>
                    {canWrite ? (
                      <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => void save(workflows.filter((w) => w !== wfId))}>
                        {t('unassign')}
                      </button>
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
          <div className="action-bar u-mt-2">
            <select className="ui-input u-minw-240" value={assignId} onChange={(e) => setAssignId(e.target.value)} aria-label={t('workflowToAssignAria')}>
              <option value="">{t('chooseWorkflow')}</option>
              {assignable.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
            </select>
            <button type="button" className="primary" disabled={!assignId || busy} onClick={() => { void save([...workflows, assignId]); setAssignId(''); }}>
              {t('assignWorkflow')}
            </button>
            <Link to="/builder" className="agentportfolio-create-link">{t('createFromTemplate')}</Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
