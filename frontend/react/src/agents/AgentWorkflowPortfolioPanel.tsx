/**
 * Agent workflow portfolio panel (PRD §9 Workflows tab) — the workflows this
 * agent is responsible for, shown as business-friendly cards (no raw ids in
 * the primary surface). Each card shows its REAL trigger state (manual / on a
 * schedule / on the board's trigger lane), assign from the library, run now
 * (with a linked run), or unassign. Warns when a workflow is local-only.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { updateRosterEntry, type RosterEntry } from './rosterClient.js';
import { createRun } from '../client/runsClient.js';
import { listWorkflowSummaries } from '../workflows/workflowsClient.js';
import { ALL_WORKFLOW_OPTIONS, isKnownWorkflow, workflowName, workflowPurpose } from './roleTemplates.js';
import { Notice } from '../ui/Notice.js';
import { AlertIcon, PlayIcon } from '../ui/icons/index.js';
import type { ScheduledJob } from './scheduleClient.js';
import type { KanbanBoard } from '../kanban/kanbanClient.js';

export function AgentWorkflowPortfolioPanel({
  entry,
  jobs = [],
  board,
  onChanged,
}: {
  entry: RosterEntry;
  jobs?: ScheduledJob[];
  board?: KanbanBoard | null;
  onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ workflowId: string; runId: string } | null>(null);
  const [assignId, setAssignId] = useState('');
  // ADR 0163 Phase 6 — the caller's REAL backend workflows (incl. ones created
  // from templates) are assignable, not just the hardcoded role-template options.
  const [mine, setMine] = useState<{ workflowId: string; name: string }[]>([]);
  useEffect(() => {
    void listWorkflowSummaries()
      .then((rows) => setMine(rows.map((r) => ({ workflowId: r.workflowId, name: r.name }))))
      .catch(() => setMine([]));
  }, []);

  const scheduledWorkflowIds = new Set(jobs.filter((j) => j.enabled !== false).map((j) => j.workflowId));
  const boardTriggerWorkflowIds = new Set((board?.columns ?? []).map((c) => c.triggerWorkflowId).filter(Boolean) as string[]);

  const setWorkflows = async (workflows: string[]) => {
    try {
      await updateRosterEntry(entry.rosterId, { workflows });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRunNow = async (workflowId: string) => {
    setRunning(workflowId);
    setError(null);
    setLastRun(null);
    try {
      const res = await createRun({ workflowId, metadata: { manual: { rosterId: entry.rosterId, persona: entry.persona } } });
      setLastRun({ workflowId, runId: res.runId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  // Merge role-template options + the caller's real workflows, deduped by id,
  // excluding already-assigned. (Created ids `wf.*` are disjoint from `tmpl.*`.)
  const assignable = [...ALL_WORKFLOW_OPTIONS, ...mine]
    .filter((w, i, arr) => arr.findIndex((x) => x.workflowId === w.workflowId) === i)
    .filter((w) => !entry.workflows.includes(w.workflowId));
  // Resolve assigned cards against the caller's real workflows first, so a
  // backend workflow isn't mislabeled "local/unknown" (ADR 0163 Phase 6).
  const mineById = new Map(mine.map((m) => [m.workflowId, m.name]));

  return (
    <div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {lastRun ? (
        <Notice variant="success">
          {t('portfolioStarted', { workflow: workflowName(lastRun.workflowId) })}
          <Link to={`/runs/${lastRun.runId}`} className="u-iflex u-items-center u-gap-1">
            <PlayIcon size={12} /> {t('portfolioViewRun')}
          </Link>
        </Notice>
      ) : null}

      {entry.workflows.length === 0 ? (
        <p className="muted">{t('portfolioEmpty', { persona: entry.persona })}</p>
      ) : (
        <>
        <p className="muted u-fs-13 u-mt-0">
          {t('portfolioIntro', { persona: entry.persona, role: entry.label ?? t('portfolioRoleFallback') })}
        </p>
        <div className="card-grid u-mb-4">
          {entry.workflows.map((wfId) => {
            const known = mineById.has(wfId) || isKnownWorkflow(wfId);
            const triggers: Array<{ id: string; label: string }> = [{ id: 'manual', label: t('portfolioTriggerManual') }];
            if (boardTriggerWorkflowIds.has(wfId)) triggers.unshift({ id: 'board', label: t('portfolioTriggerBoard') });
            if (scheduledWorkflowIds.has(wfId)) triggers.unshift({ id: 'schedule', label: t('portfolioTriggerSchedule') });
            return (
              <div key={wfId} className="surface-card">
                <div className="u-fw-600">{mineById.get(wfId) ?? workflowName(wfId)}</div>
                <div className="agentportfolio-purpose">{workflowPurpose(wfId) ?? (known ? '' : t('portfolioLocalDefault'))}</div>
                {!known ? (
                  <div className="u-flex u-gap-1 u-items-center u-fs-12 u-text-warning">
                    <AlertIcon size={13} /> {t('portfolioLocalOnly')}
                  </div>
                ) : null}
                <div className="u-flex u-gap-1 u-wrap">
                  {triggers.map((trg) => (
                    <span key={trg.id} className={`chip ${trg.id === 'schedule' ? 'chip--warning' : trg.id === 'board' ? 'chip--accent' : 'chip--muted'}`}>{trg.label}</span>
                  ))}
                </div>
                <div className="action-bar">
                  <button type="button" className="primary btn-sm" disabled={!known || running === wfId} onClick={() => void onRunNow(wfId)}>
                    {running === wfId ? t('portfolioRunning') : t('portfolioRunNow')}
                  </button>
                  <button type="button" className="secondary btn-sm" onClick={() => void setWorkflows(entry.workflows.filter((w) => w !== wfId))}>
                    {t('portfolioUnassign')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      <div className="agentportfolio-assign">
        <strong className="u-fs-14">{t('portfolioAssignHeading')}</strong>
        <div className="action-bar u-mt-2">
          <select className="ui-input u-minw-240" value={assignId} onChange={(e) => setAssignId(e.target.value)} aria-label={t('portfolioWorkflowToAssign')}>
            <option value="">{t('portfolioChooseWorkflow')}</option>
            {assignable.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
          </select>
          <button type="button" className="primary" disabled={!assignId} onClick={() => { void setWorkflows([...entry.workflows, assignId]); setAssignId(''); }}>
            {t('portfolioAssignWorkflow')}
          </button>
          <Link to="/builder" className="agentportfolio-create-link">{t('portfolioCreateFromTemplate')}</Link>
        </div>
      </div>
    </div>
  );
}
