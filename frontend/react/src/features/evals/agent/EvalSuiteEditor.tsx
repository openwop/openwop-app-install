/**
 * The eval suite editor (ADR 0889 D8 / P6): a structured form for the common
 * case and a JSON view for everything, over ONE draft.
 *
 * The server is the validator (closed-world, `400 validation_error` naming
 * `details.field`). This editor never re-implements those rules; it places the
 * server's verdict next to the control that owns the field, and falls back to
 * a notice naming the field when no control owns it (or in the JSON view).
 *
 * A suite version some run has referenced is LOCKED (a baseline must compare
 * like with like). Editing one offers "Save as new version", which bumps the
 * patch number and writes a new ref; the locked version is left untouched.
 *
 * Grade remediation (ADR 0889 B):
 *  - EVUX-1 — a save that MEANS a new ref (New suite, a changed id/version, Save
 *    as version N) sends `?create=true`, so it can never overwrite an existing
 *    suite; a `suite_exists` 409 (or a ref already in the list) is recovered with
 *    the same "Save as version N" action the locked flow uses;
 *  - EVUX-5 — unsaved edits are guarded: Cancel, in-app links, tab switches (via
 *    `onDirtyChange`) and browser exits all ask first;
 *  - EVUX-6 — after a refusal, focus moves to the first invalid control;
 *  - AE-1/AE-2 — numbers read in the user's locale; refusals read as localized
 *    sentences (`evalErrors.ts`), the server's English only as a last resort.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../ui/Button.js';
import { Notice } from '../../../ui/Notice.js';
import { TextField, TextareaField, SelectField, CheckboxField } from '../../../ui/Field.js';
import { PlusIcon, TrashIcon, LockIcon, CodeIcon, ListIcon } from '../../../ui/icons/index.js';
import { useFormat } from '../../../i18n/useFormat.js';
import { getFormatLocale } from '../../../i18n/format.js';
import { useUnsavedRouteGuard } from '../../../ui/useUnsavedChangesWarning.js';
import {
  putEvalSuite, AgentEvalsRequestError,
  type AgentEvalSuite, type EvalCapability, type StoredSuite, type GoldenStrategy, type PassRule, type TrajectoryMatchMode,
} from './agentEvalsClient.js';
import {
  draftFromSuite, emptyDraft, emptyTask, nextFreeVersion, suiteFromDraft, DraftParseError,
  type ExpectedKind, type SuiteDraft, type TaskDraft,
} from './suiteDraft.js';
import { evalErrorMessage, isLockedConflict, isSuiteExists, ruleMessage, serverText } from './evalErrors.js';

/** `message` is already localized; `inline` is the shorter form shown under the owning control. */
interface FieldErr { field: string | undefined; message: string; inline?: string }

/** True when the server's field path is `prefix` or nested under it. */
function under(field: string | undefined, prefix: string): boolean {
  return !!field && (field === prefix || field.startsWith(`${prefix}.`) || field.startsWith(`${prefix}[`));
}

/** Server paths a form control renders inline; anything else goes to the notice. */
const SUITE_FIELDS = ['suiteId', 'version', 'thresholds.passScore', 'trials.count', 'trials.k', 'trials.passRule'];
// Exactly the prefixes a TaskEditor control renders — a bare `tasks[n].expected`
// (e.g. "kind trajectory must not carry match") has no owner and goes to the notice.
const TASK_FIELD_RE = /^tasks\[\d+\]\.(taskId|input|expected\.match|expected\.rubric|expected\.trajectory|fixtures)(\.|\[|$)/;

function jsonIdVersion(text: string): { suiteId: string; version: string } {
  try {
    const o = JSON.parse(text) as { suiteId?: unknown; version?: unknown };
    return { suiteId: typeof o.suiteId === 'string' ? o.suiteId.trim() : '', version: typeof o.version === 'string' ? o.version.trim() : '' };
  } catch { return { suiteId: '', version: '' }; }
}

export function EvalSuiteEditor({
  agentId, initial, knownRefs, capability, onSaved, onCancel, onDirtyChange,
}: {
  agentId: string;
  initial: StoredSuite | null;
  /** Every ref the panel lists (tenant AND pack), for the collision pre-check. */
  knownRefs: ReadonlySet<string>;
  capability: EvalCapability | null;
  onSaved: (saved: StoredSuite) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const locale = getFormatLocale();
  const [draft, setDraft] = useState<SuiteDraft>(() => (initial ? draftFromSuite(initial.suite, locale) : emptyDraft(agentId, knownRefs, locale)));
  const [view, setView] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<FieldErr | null>(null);
  // Locked either because the list said so, or because the server refused (409).
  const [locked, setLocked] = useState(Boolean(initial?.locked));
  // The ref a create collided with (`suite_exists`); the recovery offers the next free version.
  const [existsRef, setExistsRef] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // The id + version as currently edited, from whichever view is active.
  const idVer = view === 'json' ? jsonIdVersion(json) : { suiteId: draft.suiteId.trim(), version: draft.version.trim() };
  const draftRef = `${idVer.suiteId}@${idVer.version}`;
  const editingLockedRef = locked && initial?.ref === draftRef;
  const collided = existsRef !== null && existsRef === draftRef;
  const offerNextVersion = editingLockedRef || collided;
  const nextVersion = nextFreeVersion(idVer.suiteId, idVer.version, knownRefs);

  // EVUX-5 — report unsaved edits to the tab host, and guard in-app links + browser exits.
  const confirmLeave = useUnsavedRouteGuard(dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const cancel = async (): Promise<void> => { if (await confirmLeave()) onCancel(); };

  const setSuite = (patch: Partial<SuiteDraft>): void => { setDirty(true); setDraft((d) => ({ ...d, ...patch })); };
  const setTask = (i: number, patch: Partial<TaskDraft>): void => {
    setDirty(true);
    setDraft((d) => ({ ...d, tasks: d.tasks.map((task, j) => (j === i ? { ...task, ...patch } : task)) }));
  };

  const fieldError = (prefix: string): string | undefined => (err && under(err.field, prefix) ? err.inline ?? err.message : undefined);
  const inlineOwned = !!err?.field && view === 'form' && (SUITE_FIELDS.includes(err.field) || TASK_FIELD_RE.test(err.field));

  // EVUX-6 — a refusal the form places inline moves focus to the first invalid control.
  useEffect(() => {
    if (!err) return;
    const first = sectionRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!first) return;
    first.focus();
    first.scrollIntoView?.({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [err]);

  /** The suite as currently edited, from whichever view is active. */
  const currentSuite = (): AgentEvalSuite => {
    if (view === 'json') {
      try { return JSON.parse(json) as AgentEvalSuite; } catch { throw new DraftParseError('suite', t('aeJsonInvalid')); }
    }
    return suiteFromDraft(draft, locale);
  };

  const switchView = (next: 'form' | 'json'): void => {
    if (next === view) return;
    setErr(null);
    try {
      if (next === 'json') {
        setJson(JSON.stringify(suiteFromDraft(draft, locale), null, 2));
      } else {
        setDraft(draftFromSuite(JSON.parse(json) as AgentEvalSuite, locale));
      }
      setView(next);
    } catch (e) {
      setErr(e instanceof DraftParseError ? { field: e.field, message: t('aeJsonInvalid') } : { field: 'suite', message: t('aeJsonInvalid') });
    }
  };

  const conflictExists = (ref: string, version: string): void => {
    setExistsRef(ref);
    setErr({ field: 'version', message: t('aeReason_suite_exists', { version }) });
  };

  const save = async (asNewVersion: boolean): Promise<void> => {
    setErr(null);
    let suite: AgentEvalSuite;
    try {
      suite = currentSuite();
    } catch (e) {
      setErr(e instanceof DraftParseError ? { field: e.field, message: t('aeJsonInvalid') } : { field: undefined, message: String(e) });
      return;
    }
    if (asNewVersion) {
      suite = { ...suite, version: nextFreeVersion(suite.suiteId, suite.version, knownRefs) };
      setDraft((d) => ({ ...d, version: suite.version }));
      if (view === 'json') setJson(JSON.stringify(suite, null, 2));
    }
    const ref = `${suite.suiteId}@${suite.version}`;
    // Only an edit that keeps its own ref may overwrite; anything else is a create.
    const create = asNewVersion || !initial || initial.ref !== ref;
    // Best-effort pre-check against what this panel lists — the server's
    // `?create=true` refusal is the real guard against a concurrent writer.
    if (create && knownRefs.has(ref)) { conflictExists(ref, suite.version); return; }
    setSaving(true);
    try {
      const saved = await putEvalSuite(suite, { create });
      setDirty(false);
      onDirtyChange?.(false);
      onSaved(saved);
    } catch (e) {
      if (isSuiteExists(e)) {
        conflictExists(ref, suite.version);
      } else if (isLockedConflict(e)) {
        setLocked(true);
        setExistsRef(ref);
        setErr({ field: undefined, message: t('aeLockedConflict') });
      } else if (e instanceof AgentEvalsRequestError && e.reason === 'pack_suite_ref') {
        // A pack the agent ships owns this ref; the id itself must change.
        setErr({ field: 'suiteId', message: evalErrorMessage(t, f, e) });
      } else if (e instanceof AgentEvalsRequestError && e.status === 400) {
        setErr({ field: e.field, message: evalErrorMessage(t, f, e), inline: ruleMessage(t, f, e) ?? serverText(e) });
      } else {
        setErr({ field: undefined, message: evalErrorMessage(t, f, e) });
      }
    } finally {
      setSaving(false);
    }
  };

  const maxTrials = capability?.trials?.maxTrials;
  // Only a capability that was READ and lacks trials says "runs each task once";
  // an unread one (null) makes no claim.
  const trialsKnownOff = capability !== null && !capability.trials;
  const trialsOn = Number(draft.trialsCount) > 1;

  return (
    <section ref={sectionRef} className="surface-card" aria-labelledby="ae-editor-title">
      <div className="u-flex u-items-center u-justify-between u-gap-3 u-wrap">
        <h2 id="ae-editor-title" className="u-m-0 u-fs-16">{initial ? t('aeEditSuite') : t('aeNewSuite')}</h2>
        <div className="segmented" role="group" aria-label={t('aeEditorViewLabel')}>
          <Button variant="primary" aria-pressed={view === 'form'} onClick={() => switchView('form')}>
            <ListIcon size={14} /> {t('aeViewForm')}
          </Button>
          <Button variant="primary" aria-pressed={view === 'json'} onClick={() => switchView('json')}>
            <CodeIcon size={14} /> {t('aeViewJson')}
          </Button>
        </div>
      </div>

      {editingLockedRef ? (
        <Notice variant="warning">
          <span className="u-iflex u-items-center u-gap-1"><LockIcon size={14} /> {t('aeLockedBody', { next: nextVersion })}</span>
        </Notice>
      ) : null}

      {err && !inlineOwned ? (
        <Notice variant="error" announce={err.message}>
          {err.field ? <><code dir="ltr">{err.field}</code> </> : null}{err.inline ?? err.message}
        </Notice>
      ) : null}

      {view === 'json' ? (
        <TextareaField
          label={t('aeJsonLabel')}
          help={t('aeJsonHelp')}
          className="u-mono"
          rows={22}
          spellCheck={false}
          dir="ltr"
          value={json}
          onChange={(e) => { setDirty(true); setJson(e.target.value); }}
        />
      ) : (
        <div className="u-flex u-flex-col u-gap-4">
          <div className="u-grid u-grid-2 u-gap-3">
            <TextField label={t('aeSuiteId')} help={t('aeSuiteIdHelp')} required dir="ltr" spellCheck={false} value={draft.suiteId}
              error={fieldError('suiteId')} onChange={(e) => setSuite({ suiteId: e.target.value })} />
            <TextField label={t('aeVersion')} help={t('aeVersionHelp')} required dir="ltr" value={draft.version}
              error={fieldError('version')} onChange={(e) => setSuite({ version: e.target.value })} />
            <TextField label={t('aePassScore')} help={t('aePassScoreHelp')} inputMode="decimal" value={draft.passScore}
              error={fieldError('thresholds.passScore')} onChange={(e) => setSuite({ passScore: e.target.value })} />
            <TextField label={t('aeTrialsCount')} help={maxTrials ? t('aeTrialsCountHelp', { max: maxTrials }) : trialsKnownOff ? t('aeTrialsUnsupported') : t('aeTrialsCountHelpGeneric')}
              inputMode="numeric" value={draft.trialsCount} disabled={trialsKnownOff && !trialsOn}
              error={fieldError('trials.count')} onChange={(e) => setSuite({ trialsCount: e.target.value })} />
            {trialsOn ? (
              <>
                <TextField label={t('aeTrialsK')} help={t('aeTrialsKHelp')} inputMode="numeric" value={draft.trialsK}
                  error={fieldError('trials.k')} onChange={(e) => setSuite({ trialsK: e.target.value })} />
                <SelectField label={t('aePassRule')} help={t('aePassRuleHelp')} value={draft.passRule}
                  error={fieldError('trials.passRule')} onChange={(e) => setSuite({ passRule: e.target.value as PassRule })}>
                  <option value="mean">{t('aePassRule_mean')}</option>
                  <option value="all">{t('aePassRule_all')}</option>
                  <option value="any">{t('aePassRule_any')}</option>
                </SelectField>
              </>
            ) : null}
          </div>

          <div className="u-flex u-flex-col u-gap-3">
            <h3 className="u-m-0 u-fs-14">{t('aeTasksHeading', { total: draft.tasks.length })}</h3>
            {draft.tasks.map((task, i) => (
              <TaskEditor
                key={task.key}
                index={i}
                task={task}
                trajectorySupported={capability?.trajectory !== false}
                fieldError={fieldError}
                onChange={(patch) => setTask(i, patch)}
                onRemove={draft.tasks.length > 1 ? () => { setDirty(true); setDraft((d) => ({ ...d, tasks: d.tasks.filter((_, j) => j !== i) })); } : undefined}
              />
            ))}
            <div>
              <Button variant="secondary" size="sm" onClick={() => { setDirty(true); setDraft((d) => ({ ...d, tasks: [...d.tasks, emptyTask(d.tasks.length)] })); }}>
                <PlusIcon size={14} /> {t('aeAddTask')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="action-bar">
        {offerNextVersion ? (
          <Button variant="primary" loading={saving} onClick={() => void save(true)}>{t('aeSaveNewVersion', { next: nextVersion })}</Button>
        ) : (
          <Button variant="primary" loading={saving} onClick={() => void save(false)}>{t('aeSaveSuite')}</Button>
        )}
        <Button variant="quiet" onClick={() => void cancel()} disabled={saving}>{t('aeCancel')}</Button>
      </div>
    </section>
  );
}

function TaskEditor({
  index, task, trajectorySupported, fieldError, onChange, onRemove,
}: {
  index: number;
  task: TaskDraft;
  trajectorySupported: boolean;
  fieldError: (prefix: string) => string | undefined;
  onChange: (patch: Partial<TaskDraft>) => void;
  onRemove: (() => void) | undefined;
}): JSX.Element {
  const { t } = useTranslation('evals');
  const p = `tasks[${index}]`;
  const showTrajectory = task.kind === 'trajectory' || task.trajectoryOn;
  return (
    <fieldset className="evals-task">
      <legend className="u-fw-600 u-fs-13">{task.taskId || t('aeTaskN', { n: index + 1 })}</legend>
      <div className="u-grid u-grid-2 u-gap-3">
        <TextField label={t('aeTaskId')} help={t('aeTaskIdHelp')} required dir="ltr" spellCheck={false} value={task.taskId}
          error={fieldError(`${p}.taskId`)} onChange={(e) => onChange({ taskId: e.target.value })} />
        <SelectField label={t('aeExpectedKind')} value={task.kind}
          onChange={(e) => onChange({ kind: e.target.value as ExpectedKind })}>
          <option value="golden">{t('aeKind_golden')}</option>
          <option value="rubric">{t('aeKind_rubric')}</option>
          {trajectorySupported ? <option value="trajectory">{t('aeKind_trajectory')}</option> : null}
        </SelectField>
      </div>
      <TextareaField label={t('aeInput')} help={t('aeInputHelp')} rows={3} required value={task.input}
        error={fieldError(`${p}.input`)} onChange={(e) => onChange({ input: e.target.value })} />

      {task.kind === 'golden' ? (
        <div className="u-grid u-grid-2 u-gap-3">
          <SelectField label={t('aeMatchStrategy')} value={task.matchStrategy}
            onChange={(e) => onChange({ matchStrategy: e.target.value as GoldenStrategy })}>
            <option value="contains">{t('aeStrategy_contains')}</option>
            <option value="exact">{t('aeStrategy_exact')}</option>
            <option value="json-match">{t('aeStrategy_jsonMatch')}</option>
          </SelectField>
          <TextareaField label={t('aeExpectedValue')} rows={2} value={task.matchValue}
            error={fieldError(`${p}.expected.match`) ?? (task.kind === 'golden' ? fieldError(`${p}.expected.kind`) : undefined)}
            onChange={(e) => onChange({ matchValue: e.target.value })} />
        </div>
      ) : null}

      {task.kind === 'rubric' ? (
        <div className="u-flex u-flex-col u-gap-2">
          {task.rubric.map((r, j) => (
            <div key={j} className="u-flex u-items-end u-gap-2 u-wrap">
              <TextField label={t('aeCriterion', { n: j + 1 })} className="u-flex-2" value={r.criterion}
                error={fieldError(`${p}.expected.rubric[${j}].criterion`)}
                onChange={(e) => onChange({ rubric: task.rubric.map((x, k) => (k === j ? { ...x, criterion: e.target.value } : x)) })} />
              <TextField label={t('aeWeight')} className="u-flex-1" inputMode="decimal" value={r.weight}
                error={fieldError(`${p}.expected.rubric[${j}].weight`)}
                onChange={(e) => onChange({ rubric: task.rubric.map((x, k) => (k === j ? { ...x, weight: e.target.value } : x)) })} />
              {task.rubric.length > 1 ? (
                <Button variant="quiet" size="sm" aria-label={t('aeRemoveCriterion', { n: j + 1 })}
                  onClick={() => onChange({ rubric: task.rubric.filter((_, k) => k !== j) })}>
                  <TrashIcon size={14} />
                </Button>
              ) : null}
            </div>
          ))}
          {fieldError(`${p}.expected.rubric`) && !task.rubric.some((_, j) => fieldError(`${p}.expected.rubric[${j}]`))
            ? <div className="field-error" role="alert">{fieldError(`${p}.expected.rubric`)}</div> : null}
          <div>
            <Button variant="quiet" size="sm" onClick={() => onChange({ rubric: [...task.rubric, { criterion: '', weight: '1' }] })}>
              <PlusIcon size={14} /> {t('aeAddCriterion')}
            </Button>
          </div>
        </div>
      ) : null}

      {task.kind !== 'trajectory' && trajectorySupported ? (
        <CheckboxField label={t('aeAlsoTrajectory')} checked={task.trajectoryOn}
          onChange={(e) => onChange({ trajectoryOn: e.target.checked })} />
      ) : null}

      {showTrajectory ? (
        <div className="u-grid u-grid-3 u-gap-3">
          <SelectField label={t('aeTrajectoryMatch')} value={task.trajectoryMatch}
            onChange={(e) => onChange({ trajectoryMatch: e.target.value as TrajectoryMatchMode })}>
            <option value="in-order">{t('aeTraj_inOrder')}</option>
            <option value="exact">{t('aeTraj_exact')}</option>
            <option value="any-order">{t('aeTraj_anyOrder')}</option>
            <option value="subset">{t('aeTraj_subset')}</option>
          </SelectField>
          <TextareaField label={t('aeExpectedCalls')} help={t('aeOnePerLine')} rows={3} className="u-mono" dir="ltr" spellCheck={false} value={task.calls}
            error={fieldError(`${p}.expected.trajectory`)} onChange={(e) => onChange({ calls: e.target.value })} />
          <TextareaField label={t('aeForbiddenTools')} help={t('aeOnePerLine')} rows={3} className="u-mono" dir="ltr" spellCheck={false} value={task.forbidden}
            onChange={(e) => onChange({ forbidden: e.target.value })} />
        </div>
      ) : null}

      <details open={task.fixtures.trim() !== '' || !!fieldError(`${p}.fixtures`)}>
        <summary className="u-cursor-pointer u-fs-13">{t('aeFixturesSummary')}</summary>
        <TextareaField label={t('aeFixturesLabel')} help={t('aeFixturesHelp')} rows={5} className="u-mono u-mt-2" spellCheck={false} dir="ltr"
          value={task.fixtures} error={fieldError(`${p}.fixtures`)} onChange={(e) => onChange({ fixtures: e.target.value })} />
      </details>

      {onRemove ? (
        <div className="action-bar">
          <Button variant="danger" size="sm" onClick={onRemove}><TrashIcon size={14} /> {t('aeRemoveTask')}</Button>
        </div>
      ) : null}
    </fieldset>
  );
}
