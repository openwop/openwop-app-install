/**
 * SubjectSchedulesPanel (ADR 0046 follow-on) — the ONE schedule-curation UI for
 * every subject. List a subject's scheduled workflows (cadence + last-run), edit
 * in place (workflow / cadence), pause/resume, optionally run now, delete, and
 * create from a cadence preset. Subject-agnostic: it takes a `client` (CRUD +
 * optional `trigger`), the assignable `workflows` portfolio, and subject-flavored
 * `copy`, so the SAME renderer serves a person (My Profile), an agent (workspace),
 * and a project — the counterpart of <SubjectKnowledgePanel>.
 *
 * `ui/` cohesion: surface-card / chip / StateCard / Notice / ClockIcon; tokens only.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { ClockIcon } from '../ui/icons/index.js';
import { CADENCE_PRESETS } from '../agents/scheduleClient.js';
import { workflowName } from '../agents/roleTemplates.js';
import { useFormat } from '../i18n/useFormat.js';
import i18n from '../i18n/index.js';

/** Cadence preset key → schedules-catalog label key. Keeps the localized label
 *  lookup off the persisted CADENCE_PRESETS (whose `label` is the en fallback). */
const CADENCE_LABEL_KEYS = {
  hourly: 'cadenceHourly',
  daily: 'cadenceDaily',
  weekdays: 'cadenceWeekdays',
  weekly: 'cadenceWeekly',
} as const;

/** Localized cadence label for a preset key (falls back to the preset's label). */
function cadenceKeyLabel(key: string): string {
  const labelKey = (CADENCE_LABEL_KEYS as Record<string, string>)[key];
  return labelKey
    ? i18n.t(`schedules:${labelKey}`)
    : (CADENCE_PRESETS.find((p) => p.key === key)?.label ?? key);
}

/** The browser's IANA zone — stamped on new/edited schedules so the cadence reads
 *  in the operator's local time (informational in the sample). Exported for the
 *  per-subject `copy.helper` text. */
export const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
})();

/** Human cadence for a stored cron expression (localized preset label, else the
 *  raw cron). */
export function cadenceLabel(cronExpr: string): string {
  const preset = CADENCE_PRESETS.find((p) => p.cronExpr === cronExpr);
  return preset ? cadenceKeyLabel(preset.key) : cronExpr;
}
function cadenceKey(cronExpr: string): string {
  return CADENCE_PRESETS.find((p) => p.cronExpr === cronExpr)?.key ?? CADENCE_PRESETS[0]!.key;
}

/** A schedule as the panel renders it — normalized across the three backends. */
export interface SubjectScheduleRow {
  jobId: string;
  cronExpr: string;
  workflowId?: string;
  timezone?: string;
  enabled: boolean;
  lastRunAt?: string;
  lastRunId?: string;
}

/** The subject-agnostic operations the panel drives. */
export interface SubjectSchedulesClient {
  list: () => Promise<SubjectScheduleRow[]>;
  create: (input: { workflowId: string; cronExpr: string; timezone: string }) => Promise<void>;
  update: (jobId: string, patch: { enabled?: boolean; cronExpr?: string; workflowId?: string; timezone?: string }) => Promise<void>;
  remove: (jobId: string) => Promise<void>;
  /** Optional "Run now" — omit on surfaces with no manual trigger (projects). */
  trigger?: (jobId: string) => Promise<{ runId?: string }>;
}

export interface SubjectSchedulesCopy {
  /** No-jobs StateCard body (when workflows ARE assigned). */
  emptyBody: React.ReactNode;
  /** Helper text under the create form. */
  helper: React.ReactNode;
  /** Shown when the subject has no assignable workflows (in place of the form). */
  noWorkflowsHint: React.ReactNode;
}

export function SubjectSchedulesPanel({ client, workflows, copy, readOnly = false }: { client: SubjectSchedulesClient; workflows: string[]; copy: SubjectSchedulesCopy; readOnly?: boolean }): JSX.Element {
  const { t } = useTranslation('schedules');
  const f = useFormat();
  const [jobs, setJobs] = useState<SubjectScheduleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const [wfId, setWfId] = useState(workflows[0] ?? '');
  const [cadence, setCadence] = useState(CADENCE_PRESETS[0]!.key);
  const [editing, setEditing] = useState<string | null>(null);
  const [editWf, setEditWf] = useState('');
  const [editCadence, setEditCadence] = useState(CADENCE_PRESETS[0]!.key);

  const refresh = useCallback(async () => {
    try { setJobs(await client.list()); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onCreate = async (): Promise<void> => {
    if (!wfId) return;
    setError(null);
    const preset = CADENCE_PRESETS.find((p) => p.key === cadence)!;
    try { await client.create({ workflowId: wfId, cronExpr: preset.cronExpr, timezone: LOCAL_TZ }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const startEdit = (job: SubjectScheduleRow): void => {
    setEditing(job.jobId);
    setEditWf(job.workflowId ?? workflows[0] ?? '');
    setEditCadence(cadenceKey(job.cronExpr));
  };

  const onSaveEdit = async (job: SubjectScheduleRow): Promise<void> => {
    const preset = CADENCE_PRESETS.find((p) => p.key === editCadence)!;
    setError(null);
    try { await client.update(job.jobId, { cronExpr: preset.cronExpr, workflowId: editWf, timezone: LOCAL_TZ }); setEditing(null); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onToggle = async (job: SubjectScheduleRow): Promise<void> => {
    try { await client.update(job.jobId, { enabled: !job.enabled }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onRunNow = async (job: SubjectScheduleRow): Promise<void> => {
    if (!client.trigger) return;
    setNotice(null);
    try {
      const res = await client.trigger(job.jobId);
      setNotice(res.runId ? <>{t('firedWithRun')}<Link to={`/runs/${res.runId}`}>{t('viewRun')}</Link>.</> : t('firedNoWorkflow'));
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const onDelete = async (job: SubjectScheduleRow): Promise<void> => {
    const label = job.workflowId ? workflowName(job.workflowId) : job.cronExpr;
    if (!(await confirm({ title: t('deleteConfirm', { label }), danger: true, confirmLabel: t('common:delete') }))) return;
    try { await client.remove(job.jobId); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const noWorkflows = workflows.length === 0;

  return (
    <div>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {notice ? <Notice variant="success">{notice}</Notice> : null}

      {jobs.length === 0 ? (
        <StateCard icon={<ClockIcon />} title={t('noSchedulesTitle')} body={noWorkflows ? copy.noWorkflowsHint : copy.emptyBody} />
      ) : (
        <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1-5 u-mb-4">
          {jobs.map((job) => (
            <li key={job.jobId} className="surface-card u-pad-2-2-5">
              <div className="u-flex u-items-center u-gap-2-5 u-wrap">
                <div className="u-flex-1 u-minw-200">
                  <div className="u-fw-600 u-fs-14 u-flex u-items-center u-gap-1-5">
                    {job.workflowId ? workflowName(job.workflowId) : t('noWorkflow')}
                    <span className={`chip ${job.enabled ? 'chip--success' : 'chip--muted'}`}>{job.enabled ? t('statusActive') : t('statusPaused')}</span>
                  </div>
                  <div className="muted u-fs-12">
                    {job.timezone
                      ? t('runsCadenceWithTz', { cadence: cadenceLabel(job.cronExpr), timezone: job.timezone })
                      : t('runsCadence', { cadence: cadenceLabel(job.cronExpr) })}
                  </div>
                  <div className="muted u-fs-12">
                    {job.lastRunAt
                      ? <>{t('lastRun', { when: f.relativeTime(job.lastRunAt) })}{job.lastRunId ? <> · <Link to={`/runs/${job.lastRunId}`}>{t('viewRun')}</Link></> : null}</>
                      : t('notRunYet')}
                  </div>
                </div>
                {readOnly ? null : (
                  <div className="action-bar u-gap-1">
                    <button type="button" className="secondary btn-sm" onClick={() => (editing === job.jobId ? setEditing(null) : startEdit(job))}>{editing === job.jobId ? t('common:cancel') : t('common:edit')}</button>
                    <button type="button" className="secondary btn-sm" onClick={() => void onToggle(job)}>{job.enabled ? t('pause') : t('resume')}</button>
                    {client.trigger ? <button type="button" className="secondary btn-sm" onClick={() => void onRunNow(job)}>{t('runNow')}</button> : null}
                    <button type="button" className="secondary btn-sm" onClick={() => void onDelete(job)}>{t('common:delete')}</button>
                  </div>
                )}
              </div>

              {editing === job.jobId ? (
                <div className="agentsched-edit-row">
                  <select value={editWf} onChange={(e) => setEditWf(e.target.value)} aria-label={t('workflowLabel')} className="agentsched-edit-wf">
                    {noWorkflows ? <option value="">{t('assignWorkflowFirst')}</option> : null}
                    {workflows.map((w) => <option key={w} value={w}>{workflowName(w)}</option>)}
                  </select>
                  <select value={editCadence} onChange={(e) => setEditCadence(e.target.value)} aria-label={t('cadenceLabel')}>
                    {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{cadenceKeyLabel(p.key)}</option>)}
                  </select>
                  <button type="button" className="primary btn-sm" disabled={!editWf} onClick={() => void onSaveEdit(job)}>{t('saveChanges')}</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : !noWorkflows ? (
        <div className="agentsched-create">
          <strong className="u-fs-14">{t('createHeading')}</strong>
          <div className="u-flex u-gap-1-5 u-mt-1-5 u-wrap u-items-center">
            <select value={wfId} onChange={(e) => setWfId(e.target.value)} aria-label={t('workflowLabel')} className="u-minw-200">
              {workflows.map((w) => <option key={w} value={w}>{workflowName(w)}</option>)}
            </select>
            <select value={cadence} onChange={(e) => setCadence(e.target.value)} aria-label={t('cadenceLabel')}>
              {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{cadenceKeyLabel(p.key)}</option>)}
            </select>
            <button type="button" className="primary" disabled={!wfId} onClick={() => void onCreate()}>{t('createButton')}</button>
          </div>
          <p className="muted u-fs-12 u-mb-0">{copy.helper}</p>
        </div>
      ) : jobs.length > 0 ? (
        // The subject has existing schedules but no assignable workflows left.
        <div className="agentsched-create"><p className="muted u-fs-12 u-mb-0">{copy.noWorkflowsHint}</p></div>
      ) : null}
    </div>
  );
}
