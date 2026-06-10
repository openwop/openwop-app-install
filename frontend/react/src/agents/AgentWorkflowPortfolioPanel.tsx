/**
 * Agent workflow portfolio panel (PRD §9 Workflows tab) — the workflows this
 * agent is responsible for, shown as business-friendly cards (no raw ids in
 * the primary surface). Each card shows its REAL trigger state (manual / on a
 * schedule / on the board's trigger lane), assign from the library, run now
 * (with a linked run), or unassign. Warns when a workflow is local-only.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { updateRosterEntry, type RosterEntry } from './rosterClient.js';
import { createRun } from '../client/runsClient.js';
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
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ workflowId: string; runId: string } | null>(null);
  const [assignId, setAssignId] = useState('');

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

  const assignable = ALL_WORKFLOW_OPTIONS.filter((w) => !entry.workflows.includes(w.workflowId));

  return (
    <div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {lastRun ? (
        <Notice variant="success">
          Started {workflowName(lastRun.workflowId)} ·{' '}
          <Link to={`/runs/${lastRun.runId}`} className="u-iflex u-items-center u-gap-1">
            <PlayIcon size={12} /> View run
          </Link>
        </Notice>
      ) : null}

      {entry.workflows.length === 0 ? (
        <p className="muted">No workflows assigned yet. Assign one from the library below so {entry.persona} has work to do.</p>
      ) : (
        <>
        <p className="muted u-fs-13 u-mt-0">
          These workflows make up {entry.persona}'s <strong>{entry.label ?? 'role'}</strong> portfolio — the work this
          role owns. Each card explains what it does and how it's triggered.
        </p>
        <div className="card-grid u-mb-4">
          {entry.workflows.map((wfId) => {
            const known = isKnownWorkflow(wfId);
            const triggers: string[] = ['Manual'];
            if (boardTriggerWorkflowIds.has(wfId)) triggers.unshift('Task board');
            if (scheduledWorkflowIds.has(wfId)) triggers.unshift('Schedule');
            return (
              <div key={wfId} className="surface-card">
                <div className="u-fw-600">{workflowName(wfId)}</div>
                <div className="agentportfolio-purpose">{workflowPurpose(wfId) ?? (known ? '' : 'Local workflow — assigned to this agent.')}</div>
                {!known ? (
                  <div className="u-flex u-gap-1 u-items-center u-fs-12 u-text-warning">
                    <AlertIcon size={13} /> Local-only — register on the host before it can run from a board or schedule.
                  </div>
                ) : null}
                <div className="u-flex u-gap-1 u-wrap">
                  {triggers.map((t) => (
                    <span key={t} className={`chip ${t === 'Schedule' ? 'chip--warning' : t === 'Task board' ? 'chip--accent' : 'chip--muted'}`}>{t}</span>
                  ))}
                </div>
                <div className="action-bar">
                  <button type="button" className="primary btn-sm" disabled={!known || running === wfId} onClick={() => void onRunNow(wfId)}>
                    {running === wfId ? 'Running…' : 'Run now'}
                  </button>
                  <button type="button" className="secondary btn-sm" onClick={() => void setWorkflows(entry.workflows.filter((w) => w !== wfId))}>
                    Unassign
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      <div className="agentportfolio-assign">
        <strong className="u-fs-14">Assign a workflow</strong>
        <div className="action-bar u-mt-2">
          <select className="ui-input u-minw-240" value={assignId} onChange={(e) => setAssignId(e.target.value)} aria-label="Workflow to assign">
            <option value="">Choose a workflow from the library…</option>
            {assignable.map((w) => <option key={w.workflowId} value={w.workflowId}>{w.name}</option>)}
          </select>
          <button type="button" className="primary" disabled={!assignId} onClick={() => { void setWorkflows([...entry.workflows, assignId]); setAssignId(''); }}>
            Assign workflow
          </button>
          <Link to="/builder" className="agentportfolio-create-link">Create from template</Link>
        </div>
      </div>
    </div>
  );
}
