/**
 * ADR 0889 D9 — turn a real run into a regression case.
 *
 * Capture is OPT-IN per agent: while on, the run and chat lanes record this
 * agent's tool inputs and results (secret-stripped, aged out after 30 days).
 * A captured run can then be appended to an UNLOCKED suite version as a task
 * whose expected trajectory and fixtures come from what the run actually did.
 *
 * Refusals stay where the user acted: a locked version (409) under the suite
 * picker, a refusal about the run (nothing captured, another agent's run, …)
 * on the run's own form, and a server-named task field under the task id. Each
 * reads as a localized sentence keyed on the server's `details.reason`.
 *
 * Grade remediation (ADR 0889 B): turning capture ON asks first and says who
 * can see the records and how long they last (EVUX-9) — including that a run
 * added to a suite keeps its calls there, beyond the 30-day age-out; opening
 * the promote form moves focus into it (EVUX-2); each run links its viewer and
 * shows which lane recorded it and its first call (EVUX-7).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { focusByKey } from './focusKey.js';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../ui/Button.js';
import { Notice } from '../../../ui/Notice.js';
import { CheckboxField, SelectField, TextField } from '../../../ui/Field.js';
import { confirm } from '../../../ui/confirm.js';
import { PlusIcon } from '../../../ui/icons/index.js';
import { useFormat } from '../../../i18n/useFormat.js';
import {
  AgentEvalsRequestError, getCapture, promoteRunToSuite, setCapture,
  type CaptureState, type CapturedRun, type StoredSuite,
} from './agentEvalsClient.js';
import { evalErrorMessage, ruleMessage, serverText } from './evalErrors.js';

export function EvalCaptureSection({
  agentId, persona, suites, canWrite, onSuiteUpdated,
}: {
  agentId: string;
  persona: string;
  suites: StoredSuite[];
  canWrite: boolean;
  /** `taskId` is the task the promote appended. */
  onSuiteUpdated: (saved: StoredSuite, taskId: string | undefined) => void;
}): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const [state, setState] = useState<CaptureState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // The inline promote form replaces its "Add to suite" button; closing it hands
  // focus back to that button rather than dropping it on <body>.
  const returnTo = useRef<string | null>(null);
  const closeForm = (): void => {
    returnTo.current = openRunId;
    setOpenRunId(null);
  };
  useEffect(() => {
    if (openRunId || !returnTo.current) return;
    const key = `promote:${returnTo.current}`;
    returnTo.current = null;
    focusByKey(key);
  }, [openRunId]);

  const load = useCallback(async (): Promise<void> => {
    setReadError(null);
    try {
      setState(await getCapture(agentId));
    } catch (err) {
      setReadError(evalErrorMessage(t, f, err));
    }
  }, [agentId, t, f]);

  useEffect(() => { void load(); }, [load]);

  const onToggle = async (enabled: boolean): Promise<void> => {
    // Turning recording ON stores tool inputs and results other members can
    // read; that is a consent moment. Turning it off needs no confirmation.
    if (enabled && !(await confirm({
      title: t('aeCaptureConfirmTitle', { persona }),
      body: t('aeCaptureConfirmBody'),
      confirmLabel: t('aeCaptureConfirm'),
    }))) return;
    setToggling(true);
    setToggleError(null);
    try {
      const out = await setCapture(agentId, enabled);
      setState((prev) => (prev ? { ...prev, enabled: out.enabled } : prev));
    } catch (err) {
      setToggleError(evalErrorMessage(t, f, err));
    } finally {
      setToggling(false);
    }
  };

  const unlocked = suites.filter((s) => !s.locked);

  return (
    <section className="surface-card" aria-labelledby="ae-capture-title">
      <h2 id="ae-capture-title" className="u-m-0 u-fs-16">{t('aeCaptureTitle')}</h2>
      {readError ? (
        <Notice variant="error" announce={readError}>
          {readError} <Button variant="link" onClick={() => void load()}>{t('retry')}</Button>
        </Notice>
      ) : state === null ? (
        <p className="muted u-fs-13 u-m-0">{t('aeLoading')}</p>
      ) : (
        <>
          <CheckboxField
            label={t('aeCaptureSwitch')}
            help={canWrite ? t('aeCaptureHelp') : t('aeReadOnlyReason')}
            checked={state.enabled}
            disabled={!canWrite || toggling}
            aria-busy={toggling}
            onChange={(e) => void onToggle(e.target.checked)}
            error={toggleError ?? undefined}
          />
          {state.runs.length === 0 ? (
            <p className="muted u-fs-13 u-m-0">{state.enabled ? t('aeCaptureNoRunsOn') : t('aeCaptureNoRunsOff')}</p>
          ) : (
            <>
              <h3 className="u-m-0 u-fs-14">{t('aeCaptureRunsHeading')}</h3>
              <ul className="u-list-plain">
                {state.runs.map((run) => (
                  <li key={run.runId} className="evals-suite-row">
                    <div className="u-flex u-items-center u-gap-2 u-wrap u-min-w-0">
                      <Link className="btn-link u-truncate" to={`/runs/${encodeURIComponent(run.runId)}`} aria-label={t('aeOpenCapturedRun', { runId: run.runId })}>
                        <code dir="ltr" title={run.runId}>{run.runId}</code>
                      </Link>
                      {run.lane ? <span className="chip chip--muted">{t(`aeLane_${run.lane}`)}</span> : null}
                      <span className="chip chip--muted">{t('aeCapturedCalls', { count: run.calls })}</span>
                      <span className="muted u-fs-12">{f.relativeTime(run.lastAt)}</span>
                      {run.inputPreview ? <code className="muted u-fs-12 u-truncate u-w-full" dir="ltr" title={run.inputPreview}>{run.inputPreview}</code> : null}
                    </div>
                    {canWrite && openRunId !== run.runId ? (
                      <Button variant="quiet" size="sm" data-focus-key={`promote:${run.runId}`} onClick={() => setOpenRunId(run.runId)} aria-label={t('aeAddToSuiteLabel', { runId: run.runId })}>
                        <PlusIcon size={14} /> {t('aeAddToSuite')}
                      </Button>
                    ) : null}
                    {openRunId === run.runId ? (
                      <PromoteForm
                        run={run}
                        suites={unlocked}
                        onDone={(saved, taskId) => { closeForm(); onSuiteUpdated(saved, taskId); }}
                        onCancel={closeForm}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

function PromoteForm({
  run, suites, onDone, onCancel,
}: {
  run: CapturedRun;
  suites: StoredSuite[];
  onDone: (saved: StoredSuite, taskId: string | undefined) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  // EVUX-2 — the form replaced the button that had focus; move focus into it.
  const groupRef = useRef<HTMLDivElement>(null);
  useEffect(() => { groupRef.current?.querySelector<HTMLElement>('select, input, button')?.focus(); }, []);
  const [ref, setRef] = useState(suites[0]?.ref ?? '');
  const [taskId, setTaskId] = useState('');
  const [expected, setExpected] = useState('');
  const [busy, setBusy] = useState(false);
  const [suiteError, setSuiteError] = useState<string | null>(null);
  const [taskIdError, setTaskIdError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // A2 contract — `agent_mismatch` may be overridden on purpose; nothing else may.
  const [mismatch, setMismatch] = useState(false);

  const submit = async (overrideTargetAgent = false): Promise<void> => {
    if (!ref) return;
    setBusy(true);
    setSuiteError(null);
    setTaskIdError(null);
    setFormError(null);
    setMismatch(false);
    try {
      const saved = await promoteRunToSuite(ref, {
        fromRunId: run.runId,
        ...(overrideTargetAgent ? { overrideTargetAgent: true } : {}),
        ...(taskId.trim() ? { taskId: taskId.trim() } : {}),
        ...(expected.trim() ? { expectedContains: expected.trim() } : {}),
      });
      const before = new Set(suites.find((s) => s.ref === ref)?.suite.tasks.map((x) => x.taskId) ?? []);
      onDone(saved, saved.suite.tasks.find((x) => !before.has(x.taskId))?.taskId);
    } catch (err) {
      const req = err instanceof AgentEvalsRequestError ? err : null;
      if (req?.status === 409) {
        setSuiteError(t('aePromoteLocked'));
      } else if (req?.reason) {
        // AE-4 — the server says WHY (nothing_captured, agent_mismatch, …); never guess from the field.
        setFormError(evalErrorMessage(t, f, req));
        setMismatch(req.reason === 'agent_mismatch');
      } else if (req?.status === 400 && req.field === 'fromRunId') {
        // An older server sent no reason; its only fromRunId 400 meant "nothing captured".
        setFormError(t('aeReason_nothing_captured'));
      } else if (req?.status === 400 && req.field && /taskId$|^tasks$/.test(req.field)) {
        // A pattern miss or a duplicate id: the validator names `tasks[n].taskId` / `tasks`.
        setTaskIdError(ruleMessage(t, f, req) ?? serverText(req));
      } else {
        setFormError(evalErrorMessage(t, f, err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (suites.length === 0) {
    return (
      <div ref={groupRef} className="evals-promote u-w-full">
        <p className="muted u-fs-13 u-m-0">{t('aePromoteNoUnlocked')}</p>
        <div className="action-bar"><Button variant="quiet" size="sm" onClick={onCancel}>{t('aeCancel')}</Button></div>
      </div>
    );
  }

  return (
    <div ref={groupRef} className="evals-promote u-w-full" role="group" aria-label={t('aeAddToSuiteLabel', { runId: run.runId })}>
      {formError ? (
        <Notice variant="error" announce={formError}>
          {formError}
          {mismatch ? <> <Button variant="link" disabled={busy} onClick={() => void submit(true)}>{t('aePromoteAnyway')}</Button></> : null}
        </Notice>
      ) : null}
      <div className="u-grid u-grid-3 u-gap-3">
        <SelectField label={t('aeSuiteLabel')} value={ref} error={suiteError ?? undefined} onChange={(e) => setRef(e.target.value)}>
          {suites.map((s) => <option key={s.ref} value={s.ref}>{s.ref}</option>)}
        </SelectField>
        <TextField label={t('aePromoteTaskId')} help={t('aePromoteTaskIdHelp')} dir="ltr" spellCheck={false} value={taskId}
          error={taskIdError ?? undefined} onChange={(e) => setTaskId(e.target.value)} />
        <TextField label={t('aePromoteExpected')} help={t('aePromoteExpectedHelp')} value={expected}
          onChange={(e) => setExpected(e.target.value)} />
      </div>
      <div className="action-bar">
        <Button variant="primary" size="sm" loading={busy} onClick={() => void submit()}>{t('aePromoteSubmit')}</Button>
        <Button variant="quiet" size="sm" onClick={onCancel} disabled={busy}>{t('aeCancel')}</Button>
      </div>
    </div>
  );
}
