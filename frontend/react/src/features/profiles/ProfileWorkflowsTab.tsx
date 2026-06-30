/**
 * Assigned-workflows tab (ADR 0025) — the human's workflow portfolio, the
 * user-side mirror of an agent's `AgentWorkflowPortfolioPanel`. The set the
 * human (or their assistant) runs: assign from the library, run now (with a
 * linked run), unassign. Persisted on the profile via `setMyWorkflows`.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { AlertIcon, PlayIcon, WorkflowIcon } from '../../ui/icons/index.js';
import { ALL_WORKFLOW_OPTIONS, isKnownWorkflow, workflowName, workflowPurpose } from '../../agents/roleTemplates.js';
import { createRun } from '../../client/runsClient.js';
import { setMyWorkflows, type Profile } from './profilesClient.js';

export function ProfileWorkflowsTab({ workflows, onSaved }: { workflows: string[]; onSaved: (p: Profile) => void }): JSX.Element {
  const { t } = useTranslation('profiles');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ workflowId: string; runId: string } | null>(null);
  const [assignId, setAssignId] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await setMyWorkflows(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRunNow = async (workflowId: string) => {
    setRunning(workflowId);
    setError(null);
    setLastRun(null);
    try {
      const res = await createRun({ workflowId, metadata: { manual: { source: 'profile' } } });
      setLastRun({ workflowId, runId: res.runId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  const assignable = ALL_WORKFLOW_OPTIONS.filter((w) => !workflows.includes(w.workflowId));

  return (
    <div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {lastRun ? (
        <Notice variant="success">
          {t('workflowStarted', { name: workflowName(lastRun.workflowId) })}
          <Link to={`/runs/${lastRun.runId}`} className="u-iflex u-items-center u-gap-1">
            <PlayIcon size={12} /> {t('viewRunAction')}
          </Link>
        </Notice>
      ) : null}

      {workflows.length === 0 ? (
        <StateCard icon={<WorkflowIcon />} title={t('noWorkflowsTitle')} body={t('noWorkflowsBody')} />
      ) : (
        <>
          <p className="muted u-fs-13 u-mt-0">
            <Trans t={t} i18nKey="workflowsPortfolioLead" components={{ 0: <strong /> }} />
          </p>
          <div className="card-grid u-mb-4">
            {workflows.map((wfId) => {
              const known = isKnownWorkflow(wfId);
              return (
                <div key={wfId} className="surface-card">
                  <div className="u-fw-600">{workflowName(wfId)}</div>
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
                    <button type="button" className="secondary btn-sm" disabled={busy} onClick={() => void save(workflows.filter((w) => w !== wfId))}>
                      {t('unassign')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="agentportfolio-assign">
        <strong className="u-fs-14">{t('assignAWorkflow')}</strong>
        <div className="action-bar u-mt-2">
          <select className="ui-input u-minw-240" value={assignId} onChange={(e) => setAssignId(e.target.value)} aria-label={t('workflowToAssignLabel')}>
            <option value="">{t('chooseWorkflow')}</option>
            {assignable.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
          </select>
          <button type="button" className="primary" disabled={!assignId || busy} onClick={() => { void save([...workflows, assignId]); setAssignId(''); }}>
            {t('assignWorkflow')}
          </button>
          <Link to="/builder" className="agentportfolio-create-link">{t('createFromTemplate')}</Link>
        </div>
      </div>
    </div>
  );
}
