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
import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { Link } from 'react-router-dom';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { AlertIcon, ClockIcon } from '../ui/icons/index.js';
import { CADENCE_PRESETS } from '../agents/scheduleClient.js';
import { workflowName } from '../agents/roleTemplates.js';
import { useFormat } from '../i18n/useFormat.js';
import i18n from '../i18n/index.js';
import { writeErrorMessage } from '../lib/writeAccess.js';
import { readErrorDetail } from '../client/errorEnvelope.js';
import { featureStoreHref } from '../featureToggles/lockedTargets.js';

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
/** The edit select's value for a stored cadence: its preset key, or `KEEP` for
 *  anything the presets cannot express (a one-shot, an 08:00 chat-created cron).
 *  This used to fall back to the FIRST preset, so saving an edit that touched
 *  only the workflow silently rewrote the cadence to Hourly (`SCTUX-5`). */
const KEEP_CADENCE = 'keep';
function cadenceKey(cronExpr: string): string {
  return CADENCE_PRESETS.find((p) => p.cronExpr === cronExpr)?.key ?? KEEP_CADENCE;
}

/** The backend's one-shot sentinel (`ONE_SHOT_CRON`, ADR 0309) — a spent
 *  one-shot (no `nextFireAt`, has `lastRunAt`) reads "Completed", not
 *  "won't fire". */
const ONE_SHOT_CRON = 'once';

/** A schedule as the panel renders it — normalized across the three backends. */
export interface SubjectScheduleRow {
  jobId: string;
  cronExpr: string;
  workflowId?: string;
  timezone?: string;
  enabled: boolean;
  lastRunAt?: string;
  lastRunId?: string;
  /** GEN-PRJ-1 — a fire that consumed its slot and produced NO run. The daemon
   *  records these (`recordJobSkipped`); a row type without a slot for them
   *  regenerated the dead-schedule blindness the assistant lane fixed (ADR 0491
   *  "log the SURFACING") on every consumer of this panel. ABSENT ⇒ nothing to
   *  say (older backends simply show no line). */
  lastSkippedAt?: string;
  /** Wire value — validated against the known reasons at render time. */
  lastSkipReason?: string;
  /** Epoch-ms of the next computed fire; ABSENT ⇒ won't fire (unparseable
   *  cadence, ADR 0313 D3) or a spent one-shot. Surfaces omitting it (older
   *  backends) simply show no chip. */
  nextFireAt?: number;
  /** ADR 0815 D4 — the server paused this job because the member it ran as was
   *  removed from the workspace. Resuming it makes the resumer its owner, and
   *  "Run now" is refused until then. ABSENT on every other paused job. */
  pausedReason?: 'acting_member_removed';
  /** ADR 0820 §7 — the plan no longer includes the owning feature, so the
   *  server skips (never fails) each fire and resumes it by itself once access
   *  returns. Computed per read. ABSENT otherwise. */
  planLapsed?: { featureId: string };
}

/** GEN-PRJ-1 — reason code → catalog key (REUSES the assistant lane's copy).
 *  A `Record` so a new reason code on the wire is a compile-time prompt here;
 *  the runtime arm below covers the wire (an unknown code must neither
 *  fabricate a diagnosis nor go silent — the WF-COS-4 round-2 lesson). */
const SKIP_REASON_KEY: Record<'budget' | 'workflow-unresolved' | 'dispatch-error' | 'feature-disabled' | 'plan-lapsed' | 'actor-inactive' | 'agent-paused' | 'policy-denied' | 'awaiting-approval', string> = {
  budget: 'agents:recurringSkipBudget',
  'workflow-unresolved': 'agents:recurringSkipUnresolved',
  'dispatch-error': 'agents:recurringSkipDispatch',
  'feature-disabled': 'agents:recurringSkipFeatureDisabled',
  'plan-lapsed': 'agents:recurringSkipPlanLapsed',
  'actor-inactive': 'agents:recurringSkipActorInactive',
  'agent-paused': 'agents:recurringSkipAgentPaused',
  'policy-denied': 'agents:recurringSkipPolicyDenied',
  'awaiting-approval': 'agents:recurringSkipAwaitingApproval',
};
/** ADR 0787 D6 — the cadence has no FURTHER slot inside the horizon. Not a
 *  "did not run" (that fire may well have run): it is rendered as its own chip,
 *  never through the skipped-fire line. */
const NO_NEXT_FIRE = 'no-next-fire';
function skipReasonKey(reason: string | undefined): string {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(SKIP_REASON_KEY, reason)) {
    return SKIP_REASON_KEY[reason as keyof typeof SKIP_REASON_KEY];
  }
  // Adversarial-review F6 — absent ≠ unrecognized: an unmapped wire value means
  // a reason WAS recorded; saying "no reason was recorded" would assert absence
  // where the truth is "recorded but not understood".
  return reason === undefined ? 'agents:recurringSkipUnknown' : 'agents:recurringSkipUnrecognized';
}

/** The subject-agnostic operations the panel drives. */
export interface SubjectSchedulesClient {
  list: () => Promise<SubjectScheduleRow[]>;
  create: (input: { workflowId: string; cronExpr: string; timezone: string }) => Promise<void>;
  /** `row` is the schedule as the panel last read it, so a wrapper can relabel
   *  from the fields the patch did NOT change (the patch carries only changes). */
  update: (jobId: string, patch: { enabled?: boolean; cronExpr?: string; workflowId?: string; timezone?: string }, row?: SubjectScheduleRow) => Promise<void>;
  remove: (jobId: string) => Promise<void>;
  /** Optional "Run now" — omit on surfaces with no manual trigger (projects). */
  trigger?: (jobId: string) => Promise<{ runId?: string; skipped?: string }>;
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
  const { t: tc } = useTranslation('common');
  const f = useFormat();
  // `null` = not read yet. This was `[]`, which is also what a successful empty read
  // returns, so "No schedules yet" rendered on the very first paint — before the list
  // had been asked for — and again if the read failed. Shared by three subjects
  // (projects, profiles, agents), so both defects were shipped three times.
  const [jobs, setJobs] = useState<SubjectScheduleRow[] | null>(null);
  const [jobsFailed, setJobsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A notice carries the text to ANNOUNCE separately: it mounts with its text
  // already inside, and a live region that arrives complete announces nothing.
  const [notice, setNotice] = useState<{ variant: 'success' | 'warning'; node: React.ReactNode; text: string } | null>(null);
  // In-flight guard: a double click created two schedules or fired twice. The
  // REF is the guard (two clicks in one frame both see the pre-render state);
  // the state only drives `disabled`.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [wfId, setWfId] = useState(workflows[0] ?? '');
  const [cadence, setCadence] = useState(CADENCE_PRESETS[0]!.key);
  const [editing, setEditing] = useState<string | null>(null);
  const [editWf, setEditWf] = useState('');
  const [editCadence, setEditCadence] = useState(CADENCE_PRESETS[0]!.key);

  const refresh = useCallback(async () => {
    setJobsFailed(false);
    try { setJobs(await client.list()); }
    catch (err) { setJobs([]); setJobsFailed(true); setError(writeErrorMessage(t, err)); }
  }, [client, t]);

  /** Run one write: clear stale messages, guard against a double submit, and
   *  say what failed in words (a 403 is "no permission", a 400 is the server's
   *  own sentence) — never the raw transport string. */
  const act = async (key: string, work: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setError(null);
    setNotice(null);
    try { await work(); }
    catch (err) {
      // ADR 0815 D6 — the pause refusal in our words, never the server's English.
      const body = (err as { body?: unknown } | null)?.body;
      if (readErrorDetail(body, 'reason') === 'acting_member_removed') {
        setError(t(readErrorDetail(body, 'recreate') === true ? 'pausedRecreate' : 'pausedReownNeeded'));
      } else setError(writeErrorMessage(t, err));
    }
    finally { inFlight.current = false; setBusy(null); }
  };

  useEffect(() => { void refresh(); }, [refresh]);

  const onCreate = async (): Promise<void> => {
    if (!wfId) return;
    const preset = CADENCE_PRESETS.find((p) => p.key === cadence)!;
    await act('create', async () => { await client.create({ workflowId: wfId, cronExpr: preset.cronExpr, timezone: LOCAL_TZ }); await refresh(); });
  };

  const startEdit = (job: SubjectScheduleRow): void => {
    setEditing(job.jobId);
    setEditWf(job.workflowId ?? workflows[0] ?? '');
    setEditCadence(cadenceKey(job.cronExpr));
  };

  const onSaveEdit = async (job: SubjectScheduleRow): Promise<void> => {
    // Send ONLY what the edit changed (`SCTUX-5`): an untouched cadence stays the
    // stored cron, and the stored time zone is never replaced by this browser's.
    // A NEW preset reads in the schedule's own zone when it has one.
    const patch: { cronExpr?: string; workflowId?: string; timezone?: string } = {};
    if (editWf && editWf !== job.workflowId) patch.workflowId = editWf;
    const preset = editCadence === KEEP_CADENCE ? undefined : CADENCE_PRESETS.find((p) => p.key === editCadence);
    if (preset && preset.cronExpr !== job.cronExpr) {
      patch.cronExpr = preset.cronExpr;
      if (!job.timezone) patch.timezone = LOCAL_TZ;
    }
    if (Object.keys(patch).length === 0) { setEditing(null); return; }
    await act(`edit:${job.jobId}`, async () => { await client.update(job.jobId, patch, job); setEditing(null); await refresh(); });
  };

  const onToggle = async (job: SubjectScheduleRow): Promise<void> => {
    // ADR 0815 D4 — resuming a job paused because its member left RE-OWNS it;
    // say so before it happens, never silently.
    if (!job.enabled && job.pausedReason === 'acting_member_removed'
        && !(await confirm({ title: t('resumeReownTitle'), body: t('resumeReownBody'), confirmLabel: t('resumeReownConfirm') }))) return;
    await act(`toggle:${job.jobId}`, async () => { await client.update(job.jobId, { enabled: !job.enabled }, job); await refresh(); });
  };

  const onRunNow = async (job: SubjectScheduleRow): Promise<void> => {
    const trigger = client.trigger;
    if (!trigger) return;
    await act(`run:${job.jobId}`, async () => {
      const res = await trigger(job.jobId);
      if (res.runId) {
        setNotice({ variant: 'success', node: <>{t('firedWithRunLink')} <Link to={`/runs/${res.runId}`}>{t('viewRun')}</Link></>, text: t('firedWithRunLink') });
      } else if (res.skipped) {
        // ADR 0787 D5 — the server says WHY no run started; "no workflow bound"
        // was the only thing this used to say, for every reason.
        const text = t('runNowSkipped', { reason: t(skipReasonKey(res.skipped)) });
        setNotice({ variant: 'warning', node: text, text });
      } else {
        setNotice({ variant: 'success', node: t('firedNoWorkflow'), text: t('firedNoWorkflow') });
      }
      await refresh();
    });
  };

  const onDelete = async (job: SubjectScheduleRow): Promise<void> => {
    const label = job.workflowId ? workflowName(job.workflowId) : job.cronExpr;
    if (!(await confirm({ title: t('deleteConfirm', { label }), danger: true, confirmLabel: t('common:delete') }))) return;
    await act(`delete:${job.jobId}`, async () => { await client.remove(job.jobId); await refresh(); });
  };

  const noWorkflows = workflows.length === 0;

  return (
    <div>
      {error ? <Notice variant="error" announce={error}>{error}</Notice> : null}
      {notice ? <Notice variant={notice.variant} announce={notice.text}>{notice.node}</Notice> : null}

      {jobs === null ? (
        <StateCard icon={<ClockIcon />} title={tc('loading')} loading />
      ) : jobsFailed ? (
        // Above the empty branch: below it, `[]` selects the instruction first and this
        // is decorative. The error Notice at the top says WHAT failed; this stops the
        // page also asserting there is nothing scheduled.
        <StateCard announce icon={<ClockIcon />} title={tc('loadFailedTitle')} body={tc('loadFailedBody')} />
      ) : jobs.length === 0 ? (
        <StateCard icon={<ClockIcon />} title={t('noSchedulesTitle')} body={noWorkflows ? copy.noWorkflowsHint : copy.emptyBody} />
      ) : (
        <ul className="u-list-none u-m-0 u-p-0 u-flex u-flex-col u-gap-1-5 u-mb-4">
          {jobs.map((job) => (
            <li key={job.jobId} className="surface-card u-pad-2-2-5">
              <div className="u-flex u-items-center u-gap-2-5 u-wrap">
                <div className="u-flex-1 u-minw-200">
                  <div className="u-fw-600 u-fs-14 u-flex u-items-center u-gap-1-5">
                    {job.workflowId ? workflowName(job.workflowId) : t('noWorkflow')}
                    {job.planLapsed
                      ? <span className="chip chip--warning"><AlertIcon size={11} aria-hidden /> {t('statusPlanLapsed')}</span>
                      : <span className={`chip ${job.enabled ? 'chip--success' : 'chip--muted'}`}>{job.enabled ? t('statusActive') : t('statusPaused')}</span>}
                    {!job.enabled && job.pausedReason === 'acting_member_removed'
                      ? <span id={`paused-${job.jobId}`} className="chip chip--warning"><AlertIcon size={11} aria-hidden /> {t('pausedOwnerLeft')}</span>
                      : null}
                    {/* ADR 0313 D3 — a silent schedule must SAY it's silent: an
                        enabled row with no computed next fire either spent its
                        one-shot (done) or its cadence didn't parse (inert). */}
                    {job.enabled && job.nextFireAt === undefined ? (
                      job.cronExpr === ONE_SHOT_CRON && job.lastRunAt
                        ? <span className="chip chip--muted">{t('oneShotDone')}</span>
                        : job.lastSkipReason === NO_NEXT_FIRE
                          // ADR 0787 D6 — it parsed; there is just no future time.
                          ? <span className="chip chip--warning"><AlertIcon size={11} aria-hidden /> {t('cadenceExhausted')}</span>
                          : <span className="chip chip--warning"><AlertIcon size={11} aria-hidden /> {t('wontFire')}</span>
                    ) : null}
                  </div>
                  <div className="muted u-fs-12">
                    {job.timezone
                      ? t('runsCadenceWithTz', { cadence: cadenceLabel(job.cronExpr), timezone: job.timezone })
                      : t('runsCadence', { cadence: cadenceLabel(job.cronExpr) })}
                  </div>
                  {/* ADR 0820 §7 — the computed lapse pause: every fire is skipped
                      (never failed) until the plan includes the feature again,
                      and then it resumes by itself. */}
                  {job.planLapsed ? (
                    <div className="u-fs-12 u-text-warning">
                      {t('planLapsedHint')} <Link to={featureStoreHref(job.planLapsed.featureId)}>{t('planLapsedLink')}</Link>
                    </div>
                  ) : null}
                  {job.enabled && !job.planLapsed && job.nextFireAt !== undefined ? (
                    <div className="muted u-fs-12" title={f.dateTime(new Date(job.nextFireAt).toISOString())}>
                      {t('nextRun', { when: f.relativeTime(new Date(job.nextFireAt).toISOString()) })}
                    </div>
                  ) : null}
                  <div className="muted u-fs-12">
                    {job.lastRunAt
                      ? <>{t('lastRun', { when: f.relativeTime(job.lastRunAt) })}{job.lastRunId ? <> · <Link to={`/runs/${job.lastRunId}`}>{t('viewRun')}</Link></> : null}</>
                      : t('notRunYet')}
                  </div>
                  {/* GEN-PRJ-1 — a fire that consumed its slot and produced NO
                      run. Without this line a typo'd workflow id read as a
                      healthy schedule forever ("Not run yet", nextFireAt
                      advancing) on all three consumers of this panel. */}
                  {job.lastSkippedAt && job.lastSkipReason !== NO_NEXT_FIRE && !job.planLapsed ? (
                    <div className="u-fs-12 u-text-warning">
                      {t('agents:recurringSkipped', { when: f.relativeTime(job.lastSkippedAt), reason: t(skipReasonKey(job.lastSkipReason)) })}
                    </div>
                  ) : null}
                </div>
                {readOnly ? null : (
                  <div className="action-bar u-gap-1">
                    <Button variant="secondary" size="sm" onClick={() => (editing === job.jobId ? setEditing(null) : startEdit(job))}>{editing === job.jobId ? t('common:cancel') : t('common:edit')}</Button>
                    <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void onToggle(job)}>{job.enabled ? t('pause') : t('resume')}</Button>
                    {client.trigger ? <Button variant="secondary" size="sm" disabled={busy !== null || job.pausedReason === 'acting_member_removed'} title={job.pausedReason === 'acting_member_removed' ? t('pausedOwnerLeftRunNow') : undefined} aria-describedby={job.pausedReason === 'acting_member_removed' ? `paused-${job.jobId}` : undefined} onClick={() => void onRunNow(job)}>{t('runNow')}</Button> : null}
                    <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void onDelete(job)}>{t('common:delete')}</Button>
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
                    {cadenceKey(job.cronExpr) === KEEP_CADENCE ? <option value={KEEP_CADENCE}>{t('keepCadence', { cadence: cadenceLabel(job.cronExpr) })}</option> : null}
                    {CADENCE_PRESETS.map((p) => <option key={p.key} value={p.key}>{cadenceKeyLabel(p.key)}</option>)}
                  </select>
                  <Button variant="primary" size="sm" disabled={!editWf || busy !== null} onClick={() => void onSaveEdit(job)}>{t('saveChanges')}</Button>
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
            <Button variant="primary" disabled={!wfId || busy !== null} onClick={() => void onCreate()}>{t('createButton')}</Button>
          </div>
          <p className="muted u-fs-12 u-mb-0">{copy.helper}</p>
        </div>
      ) : (jobs?.length ?? 0) > 0 ? (
        // The subject has existing schedules but no assignable workflows left.
        <div className="agentsched-create"><p className="muted u-fs-12 u-mb-0">{copy.noWorkflowsHint}</p></div>
      ) : null}
    </div>
  );
}
