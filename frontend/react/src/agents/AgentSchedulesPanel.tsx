/**
 * Agent schedules panel (PRD §9 Schedules + §13) — agent-owned scheduled
 * workflows. List with cadence + last-run, edit in place (cadence / workflow),
 * pause/resume, run now, delete, and create from a cadence preset. Backed by
 * the durable scheduler (host/schedulingService.ts).
 *
 * A background scheduler daemon (host/scheduleDaemon.ts) fires these jobs on
 * their wall-clock cadence (and the deterministic tick seam still backs
 * conformance). We show the cadence + the real last-run time; the next-fire
 * instant is computed server-side (`nextFireAt`) from the cron + timezone.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CADENCE_PRESETS, createJob, deleteJob, listJobs, updateJob, triggerJob, type ScheduledJob } from './scheduleClient.js';
import { workflowName } from './roleTemplates.js';
import { relativeTime } from './agentViewModel.js';
import type { RosterEntry } from './rosterClient.js';
import { Notice } from '../ui/Notice.js';

// The browser's IANA zone — stamped on new/edited schedules so the cadence
// reads in the operator's local time (informational in the sample).
const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
})();

/** Human cadence for a stored cron expression — a preset label when it matches
 *  a known cadence, else the raw cron string. */
function cadenceLabel(cronExpr: string): string {
  return CADENCE_PRESETS.find((p) => p.cronExpr === cronExpr)?.label ?? cronExpr;
}

/** Best-effort reverse map cron → preset key (to preselect the edit dropdown). */
function cadenceKey(cronExpr: string): string {
  return CADENCE_PRESETS.find((p) => p.cronExpr === cronExpr)?.key ?? CADENCE_PRESETS[0]!.key;
}

export function AgentSchedulesPanel({ entry }: { entry: RosterEntry }): JSX.Element {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wfId, setWfId] = useState(entry.workflows[0] ?? '');
  const [cadence, setCadence] = useState(CADENCE_PRESETS[0]!.key);
  // The job currently being edited inline (jobId), plus its draft fields.
  const [editing, setEditing] = useState<string | null>(null);
  const [editWf, setEditWf] = useState('');
  const [editCadence, setEditCadence] = useState(CADENCE_PRESETS[0]!.key);

  const refresh = useCallback(async () => {
    try {
      setJobs(await listJobs(entry.rosterId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [entry.rosterId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCreate = async () => {
    if (!wfId) return;
    setError(null);
    const preset = CADENCE_PRESETS.find((p) => p.key === cadence)!;
    try {
      await createJob({
        cronExpr: preset.cronExpr,
        workflowId: wfId,
        rosterId: entry.rosterId,
        agentId: entry.agentRef.agentId,
        metadata: { label: `${workflowName(wfId)} · ${preset.label}` },
        timezone: LOCAL_TZ,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startEdit = (job: ScheduledJob) => {
    setEditing(job.jobId);
    setEditWf(job.workflowId ?? entry.workflows[0] ?? '');
    setEditCadence(cadenceKey(job.cronExpr));
  };

  const onSaveEdit = async (job: ScheduledJob) => {
    const preset = CADENCE_PRESETS.find((p) => p.key === editCadence)!;
    setError(null);
    try {
      await updateJob(job.jobId, {
        cronExpr: preset.cronExpr,
        workflowId: editWf,
        metadata: { ...(job.metadata ?? {}), label: `${workflowName(editWf)} · ${preset.label}` },
        timezone: LOCAL_TZ,
      });
      setEditing(null);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onToggle = async (job: ScheduledJob) => {
    try { await updateJob(job.jobId, { enabled: !job.enabled }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onRunNow = async (job: ScheduledJob) => {
    setNotice(null);
    try {
      const res = await triggerJob(job.jobId);
      setNotice(res.runId ? `Fired — run ${res.runId}.` : 'Fired (no workflow bound).');
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onDelete = async (job: ScheduledJob) => {
    const label = String(job.metadata?.label ?? (job.workflowId ? workflowName(job.workflowId) : job.cronExpr));
    if (!window.confirm(`Delete the schedule “${label}”? This can't be undone.`)) return;
    try { await deleteJob(job.jobId); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice} <Link to="/runs">View runs</Link></Notice> : null}

      {jobs.length === 0 ? (
        <p className="muted">No schedules yet. Create one below so {entry.persona} runs a workflow on a cadence.</p>
      ) : (
        <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1-5 u-mb-4">
          {jobs.map((job) => (
            <li key={job.jobId} className="surface-card u-pad-2-2-5">
              <div className="u-flex u-items-center u-gap-2-5 u-wrap">
                <div className="u-flex-1 u-minw-200">
                  <div className="u-fw-600 u-fs-14 u-flex u-items-center u-gap-1-5">
                    {job.workflowId ? workflowName(job.workflowId) : 'No workflow'}
                    <span className={`chip ${job.enabled ? 'chip--success' : 'chip--muted'}`}>{job.enabled ? 'Active' : 'Paused'}</span>
                  </div>
                  <div className="muted u-fs-12">
                    Runs {cadenceLabel(job.cronExpr)}{job.timezone ? ` · ${job.timezone}` : ''}
                  </div>
                  <div className="muted u-fs-12">
                    {job.lastRunAt
                      ? <>Last run {relativeTime(job.lastRunAt)}{job.lastRunId ? <> · <Link to={`/runs/${job.lastRunId}`}>view run</Link></> : null}</>
                      : 'Not run yet'}
                  </div>
                </div>
                <div className="action-bar u-gap-1">
                  <button type="button" className="secondary btn-sm" onClick={() => (editing === job.jobId ? setEditing(null) : startEdit(job))}>{editing === job.jobId ? 'Cancel' : 'Edit'}</button>
                  <button type="button" className="secondary btn-sm" onClick={() => void onToggle(job)}>{job.enabled ? 'Pause' : 'Resume'}</button>
                  <button type="button" className="secondary btn-sm" onClick={() => void onRunNow(job)}>Run now</button>
                  <button type="button" className="secondary btn-sm" onClick={() => void onDelete(job)}>Delete</button>
                </div>
              </div>

              {editing === job.jobId ? (
                <div className="agentsched-edit-row">
                  <select value={editWf} onChange={(e) => setEditWf(e.target.value)} aria-label="Workflow" className="agentsched-edit-wf">
                    {entry.workflows.length === 0 ? <option value="">Assign a workflow first</option> : null}
                    {entry.workflows.map((w) => <option key={w} value={w}>{workflowName(w)}</option>)}
                  </select>
                  <select value={editCadence} onChange={(e) => setEditCadence(e.target.value)} aria-label="Cadence">
                    {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                  <button type="button" className="primary btn-sm" disabled={!editWf} onClick={() => void onSaveEdit(job)}>Save changes</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="agentsched-create">
        <strong className="u-fs-14">Create a schedule</strong>
        <div className="u-flex u-gap-1-5 u-mt-1-5 u-wrap u-items-center">
          <select value={wfId} onChange={(e) => setWfId(e.target.value)} aria-label="Workflow" className="u-minw-200">
            {entry.workflows.length === 0 ? <option value="">Assign a workflow first</option> : null}
            {entry.workflows.map((w) => <option key={w} value={w}>{workflowName(w)}</option>)}
          </select>
          <select value={cadence} onChange={(e) => setCadence(e.target.value)} aria-label="Cadence">
            {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <button type="button" className="primary" disabled={!wfId} onClick={() => void onCreate()}>Create schedule</button>
        </div>
        <p className="muted u-fs-12 u-mb-0">
          Cadence shown in {LOCAL_TZ}. Schedules fire automatically on this cadence (a background daemon), or immediately with “Run now”.
        </p>
      </div>
    </div>
  );
}
