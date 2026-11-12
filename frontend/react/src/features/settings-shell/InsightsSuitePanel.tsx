/**
 * Settings → AI → "Insights & Drafting" (ADR 1102 D10, `INS91-9`).
 *
 * Before this panel the suite's weekly schedule could be armed only by a
 * hand-written authenticated PUT: no screen read or wrote it. The panel edits the
 * one door (`/insights-suite/config`) and says the two things the door decides:
 * WHO the schedule runs as (the person who saves it, D4) and that the anniversary
 * trigger cannot be armed (D6). Lazy-loaded by the settings registry, so nothing
 * here reaches the entry chunk. The component sits in the settings shell because
 * its copy does (the shell's namespace); its data client is the feature's own
 * (`features/insights-suite/insightsSuiteClient.ts`).
 *
 * Every refusal the door can give carries a closed `reason`; the panel words it
 * itself, so a Spanish reader never sees the server's developer English.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Notice, StateCard } from '../../ui/index.js';
import { confirm } from '../../ui/confirm.js';
import { toast } from '../../ui/toast.js';
import {
  getInsightsSuite, saveInsightsSuite, InsightsSuiteSaveError, type InsightsSuiteState,
} from '../insights-suite/insightsSuiteClient.js';

/** Cron weekday numbers, Monday first. */
const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
/** `M H * * D` — the shape this panel writes and can show as a day and a time. */
const SIMPLE_CRON = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;
/** The door's own BigQuery project-id rule (`insights-suite/routes.ts`). */
const PROJECT_ID = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

type FieldKey = 'schedule' | 'project' | 'businessUnit';
const FIELD_OF: Record<string, FieldKey> = {
  scheduleCron: 'schedule',
  scheduleTimezone: 'schedule',
  'planSource.projectId': 'project',
  businessUnit: 'businessUnit',
  businessUnits: 'businessUnit',
};
/** The door's closed `reason`s, each with the sentence this panel says instead. */
const REASON_KEY: Record<string, string> = {
  invalid_cron: 'insights_errCron',
  schedule_horizon_exceeded: 'insights_errCronNeverFires',
  invalid_timezone: 'insights_errTimezone',
  invalid_project_id: 'insights_errProject',
  project_required: 'insights_projectRequired',
  too_long: 'insights_errTooLong',
  one_business_unit: 'insights_errOneBusinessUnit',
  both_spellings: 'insights_errOneBusinessUnit',
  jobid_conflict: 'insights_errJobIdConflict',
};
/** Reasons that are about the moment, not the value: shown for the form, never on a field. */
const FORM_REASONS: Record<string, string> = {
  write_contention: 'insights_errBusy',
  jobid_conflict: 'insights_errJobIdConflict',
};
/** The element each field's error belongs to, for moving focus to the first one.
 *  A kept custom cron hides the day and time, so its errors land on the button
 *  that reveals them. */
const FIELD_INPUT: Record<FieldKey, string> = { schedule: 'insights-time', project: 'insights-project', businessUnit: 'insights-bu' };
const focusSoon = (id: string): void => { setTimeout(() => document.getElementById(id)?.focus(), 0); };

function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Every zone, labelled with its current UTC offset, the browser's and UTC first.
 *  `null` when the runtime cannot list zones (the panel falls back to a text field). */
function timeZoneOptions(current: string, locale: string): Array<{ id: string; label: string }> | null {
  let all: string[];
  try {
    all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  } catch { all = []; }
  if (all.length === 0) return null;
  const head = [...new Set([current, browserTimeZone(), 'UTC'])];
  const ids = [...head, ...all.filter((z) => !head.includes(z))];
  const now = new Date();
  return ids.map((id) => {
    let offset = '';
    try {
      offset = new Intl.DateTimeFormat(locale, { timeZone: id, timeZoneName: 'shortOffset' })
        .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch { offset = ''; }
    const name = id.replace(/_/g, ' ');
    return { id, label: offset ? `${name} (${offset})` : name };
  });
}

export function InsightsSuitePanel(): JSX.Element {
  // The copy lives in this page's lazy `settings-shell` namespace under
  // `insights_*` (a new feature namespace would add an eager loader entry).
  const { t, i18n } = useTranslation('settings-shell');
  const [state, setState] = useState<InsightsSuiteState | null | undefined>(undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [day, setDay] = useState<number>(1);
  const [time, setTime] = useState('06:00');
  const [tz, setTz] = useState(browserTimeZone);
  const [customCron, setCustomCron] = useState<string | null>(null);
  const [project, setProject] = useState('');
  const [businessUnit, setBusinessUnit] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** `afterSave`: a reload that fails right after a good save keeps the form and
   *  says so, instead of replacing the panel with a load-failure card. */
  const load = useCallback((afterSave = false): void => {
    if (!afterSave) setLoadFailed(false);
    getInsightsSuite()
      .then((s) => {
        setState(s);
        const c = s?.config;
        if (!c) return;
        setEnabled(Boolean(c.scheduleCron));
        const m = c.scheduleCron ? SIMPLE_CRON.exec(c.scheduleCron) : null;
        if (m) {
          setDay(Number(m[3]));
          setTime(`${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}`);
          setCustomCron(null);
        } else {
          setCustomCron(c.scheduleCron ?? null);
        }
        if (c.scheduleTimezone) setTz(c.scheduleTimezone);
        setProject(c.planSource?.projectId ?? '');
        setBusinessUnit(c.businessUnit ?? '');
      })
      .catch(() => { if (afterSave) setFormError('insights_reloadFailed'); else setLoadFailed(true); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const dayNames = useMemo(() => {
    // 2024-01-01 was a Monday; cron day d (0 = Sunday) is that date + ((d + 6) % 7).
    const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' });
    return new Map(DAYS.map((d) => [d, fmt.format(new Date(Date.UTC(2024, 0, 1 + ((d + 6) % 7))))]));
  }, [i18n.language]);
  const zones = useMemo(() => timeZoneOptions(tz, i18n.language), [tz, i18n.language]);

  if (loadFailed) {
    return <StateCard announce title={t('insights_loadFailed')} body={t('insights_loadFailedBody')} action={<Button size="sm" onClick={() => load()}>{t('insights_retry')}</Button>} />;
  }
  if (state === undefined) return <StateCard loading title={t('insights_loading')} />;
  if (state === null) return <StateCard announce title={t('insights_unavailableTitle')} body={t('insights_unavailableBody')} action={<Button variant="secondary" size="sm" onClick={() => load()}>{t('insights_retry')}</Button>} />;

  const readOnly = !state.canWrite;
  const takingOver = state.runsAsYou === false;
  const savedCron = state.config?.scheduleCron;

  const clearError = (key: FieldKey): void => setErrors((x) => ({ ...x, [key]: undefined }));
  /** Place field errors and move focus to the first, so the person lands on it. */
  const showFieldErrors = (next: Partial<Record<FieldKey, string>>, serverField?: string): void => {
    setErrors(next);
    const first = (['schedule', 'project', 'businessUnit'] as const).find((k) => next[k]);
    if (!first) return;
    if (first === 'schedule' && customCron) focusSoon('insights-replace');
    else if (serverField === 'scheduleTimezone') focusSoon('insights-tz');
    else focusSoon(FIELD_INPUT[first]);
  };
  // Only a schedule that exists can be stopped (the round-3 UX re-grade).
  const turningOff = takingOver && !enabled && Boolean(savedCron);

  const onSave = async (): Promise<void> => {
    setErrors({});
    setFormError(null);
    // Checked here first, with the door's own rules, so the common slips are
    // answered without a round trip; the door still decides.
    const local: Partial<Record<FieldKey, string>> = {};
    if (enabled && !customCron && !/^\d{2}:\d{2}$/.test(time)) local.schedule = t('insights_timeRequired');
    if (enabled && !project.trim()) local.project = t('insights_projectRequired');
    else if (project.trim() && !PROJECT_ID.test(project.trim())) local.project = t('insights_errProject');
    if (Object.keys(local).length > 0) { showFieldErrors(local); return; }
    if (takingOver) {
      const ok = await confirm(turningOff
        ? { title: t('insights_turnOffTitle'), body: t('insights_turnOffBody'), confirmLabel: t('insights_turnOffConfirm'), danger: true }
        : { title: t('insights_takeOverTitle'), body: t('insights_takeOverBody'), confirmLabel: t('insights_takeOverConfirm'), danger: true });
      if (!ok) return;
    }
    const [hh, mm] = time.split(':').map((n) => Number(n));
    setBusy(true);
    try {
      await saveInsightsSuite({
        // A stored custom cron is kept unless the person picks a day and time.
        ...(enabled ? { scheduleCron: customCron ?? `${mm} ${hh} * * ${day}`, scheduleTimezone: tz } : {}),
        ...(project.trim() ? { planSource: { projectId: project.trim() } } : {}),
        ...(businessUnit.trim() ? { businessUnit: businessUnit.trim() } : {}),
        ...(takingOver ? { takeOver: true } : {}),
      });
      toast.success(enabled ? t('insights_saved') : t('insights_savedOff'));
      load(true);
    } catch (e) {
      if (!(e instanceof InsightsSuiteSaveError)) { setFormError('insights_saveFailed'); return; }
      if (e.reason === 'principal_conflict') { setFormError('insights_errPrincipalConflict'); load(true); return; }
      if (e.status === 403) { setFormError('insights_errNoPermission'); return; }
      if (e.reason && FORM_REASONS[e.reason]) { setFormError(FORM_REASONS[e.reason]!); return; }
      const sentence = e.reason && REASON_KEY[e.reason] ? t(REASON_KEY[e.reason]!) : null;
      const field = e.field ? FIELD_OF[e.field] : undefined;
      if (field) showFieldErrors({ [field]: sentence ?? t('insights_errFieldRefused') }, e.field);
      else setFormError('insights_saveFailed');
    } finally {
      setBusy(false);
    }
  };

  const fieldProps = (key: FieldKey, hint?: string) => ({
    'aria-invalid': errors[key] !== undefined,
    'aria-describedby': [hint, `insights-${key}-err`].filter(Boolean).join(' '),
    disabled: readOnly || busy,
  });

  return (
    <div className="u-grid u-gap-3">
      <p>{t('insights_hint')}</p>
      {readOnly ? <Notice variant="info">{t('insights_readOnly')}</Notice> : null}
      {takingOver
        ? <Notice variant="warning"><span id="insights-runs-as">{readOnly ? t('insights_runsAsOtherReadOnly') : turningOff ? t('insights_runsAsOtherOff') : t('insights_runsAsOther')}</span></Notice>
        : savedCron ? <p className="u-label-sm u-text-muted">{t('insights_runsAsYou')}</p> : null}
      {savedCron && !state.scheduleArmed ? <Notice variant="warning">{readOnly ? t('insights_notRunningReadOnly') : t('insights_notRunning')}</Notice> : null}
      {formError ? <Notice variant={formError === 'insights_reloadFailed' ? 'warning' : 'error'} announce={t(formError)}>{t(formError)}</Notice> : null}

      <label className="action-bar">
        <input type="checkbox" checked={enabled} disabled={readOnly || busy} onChange={(e) => { setEnabled(e.target.checked); clearError('schedule'); }} />
        {t('insights_enabledLabel')}
      </label>

      {enabled ? (
        <fieldset className="u-grid u-gap-2">
          <legend className="u-label-sm">{t('insights_whenLegend')}</legend>
          {customCron ? (
            <>
              <p className="u-label-sm u-text-muted">{t('insights_customCron', { cron: customCron })}</p>
              <span className="action-bar">
                <Button id="insights-replace" size="sm" disabled={readOnly || busy} onClick={() => { setCustomCron(null); focusSoon('insights-day'); }}>{t('insights_replaceSchedule')}</Button>
              </span>
            </>
          ) : (
          <>
          <div className="cv-editor__field">
            <label htmlFor="insights-day" className="u-label-sm">{t('insights_dayLabel')}</label>
            <select id="insights-day" className="cv-editor__input" value={day} onChange={(e) => { setDay(Number(e.target.value)); setCustomCron(null); clearError('schedule'); }} {...fieldProps('schedule')}>
              {DAYS.map((d) => <option key={d} value={d}>{dayNames.get(d)}</option>)}
            </select>
          </div>
          <div className="cv-editor__field">
            <label htmlFor="insights-time" className="u-label-sm">{t('insights_timeLabel')}</label>
            <input id="insights-time" type="time" required className="cv-editor__input" value={time} onChange={(e) => { setTime(e.target.value); setCustomCron(null); clearError('schedule'); }} {...fieldProps('schedule')} />
          </div>
          </>
          )}
          <div className="cv-editor__field">
            <label htmlFor="insights-tz" className="u-label-sm">{t('insights_timezoneLabel')}</label>
            {zones ? (
              <select id="insights-tz" className="cv-editor__input" value={tz} onChange={(e) => { setTz(e.target.value); clearError('schedule'); }} {...fieldProps('schedule')}>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
              </select>
            ) : (
              <input id="insights-tz" className="cv-editor__input" value={tz} spellCheck={false} onChange={(e) => { setTz(e.target.value); clearError('schedule'); }} {...fieldProps('schedule')} />
            )}
          </div>
          <span id="insights-schedule-err" role="alert" className="cv-editor__field-error">{errors.schedule ?? ''}</span>
        </fieldset>
      ) : null}

      <div className="cv-editor__field">
        <label htmlFor="insights-project" className="u-label-sm">{t('insights_projectLabel')}</label>
        <input id="insights-project" className="cv-editor__input" value={project} placeholder="acme-analytics" autoComplete="off" spellCheck={false} aria-required={enabled} onChange={(e) => { setProject(e.target.value); clearError('project'); }} {...fieldProps('project', 'insights-project-hint')} />
        <span id="insights-project-hint" className="u-label-sm u-text-muted">{enabled ? t('insights_projectHintRequired') : t('insights_projectHint')}</span>
        <span id="insights-project-err" role="alert" className="cv-editor__field-error">{errors.project ?? ''}</span>
      </div>
      <div className="cv-editor__field">
        <label htmlFor="insights-bu" className="u-label-sm">{t('insights_buLabel')}</label>
        <input id="insights-bu" className="cv-editor__input" value={businessUnit} maxLength={120} onChange={(e) => { setBusinessUnit(e.target.value); clearError('businessUnit'); }} {...fieldProps('businessUnit', 'insights-bu-hint')} />
        <span id="insights-bu-hint" className="u-label-sm u-text-muted">{t('insights_buHint')}</span>
        <span id="insights-businessUnit-err" role="alert" className="cv-editor__field-error">{errors.businessUnit ?? ''}</span>
      </div>

      {/* Natively `disabled`, with the reason as its description. An
          `aria-disabled` control that swallows its own click was tried and could
          still be ticked; a control that LOOKS settable is the worse failure. */}
      <label className="action-bar">
        <input type="checkbox" checked={false} disabled readOnly aria-describedby="insights-anniversary-note" />
        {t('insights_anniversaryLabel')}
      </label>
      <p id="insights-anniversary-note" className="u-label-sm u-text-muted">{t('insights_anniversaryUnavailable')}</p>

      {readOnly ? null : (
        <span className="action-bar">
          <Button variant="primary" size="sm" disabled={busy} aria-describedby={takingOver ? 'insights-runs-as' : undefined} onClick={() => void onSave()}>
            {busy ? t('insights_saving') : turningOff ? t('insights_turnOffSave') : takingOver ? t('insights_takeOverSave') : t('insights_save')}
          </Button>
        </span>
      )}
    </div>
  );
}
