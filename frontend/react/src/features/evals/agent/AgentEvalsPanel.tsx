/**
 * The agent workspace's Evals tab (ADR 0889 D8 / P6).
 *
 *   suites → editor → run (optional baseline) → live scorecard → history
 *
 * Runs go through the ONE normative lane (`POST /runs {mode:"eval"}`); the
 * suite store, history and per-trial progress are host-extension reads. The
 * scorecard polls `…/progress` while the run is live and stops at a terminal
 * status. There is no chat here: "ask why" deep-links the main chat (CLAUDE.md,
 * "No second chat system").
 *
 * `agentId` is the REGISTRY id (`entry.agentRef.agentId`) — the id the run
 * lane resolves through `resolveAgentForTenant`, and the id the history is
 * filtered on. Never the rosterId.
 *
 * A9: an eval run's synthetic `workflowId` (`eval:<ref>`) is never linked into
 * the builder; the scorecard links the run viewer only.
 *
 * Grade remediation (ADR 0889 B):
 *  - EVUX-3 — the open scorecard lives in the URL (`?run=`), always renders
 *    under the Run card, and opening it moves focus + scroll to its heading;
 *  - EVUX-10 — the model picker lists only tool-capable models, grouped by
 *    provider, and names the suite's allowed model classes;
 *  - EVUX-12/14 — every terminal status reads as terminal, and the history
 *    refreshes itself while any row is still running;
 *  - EVUX-8 — after a promote, the notice opens the suite to edit the new task;
 *  - AE-2/AE-3/BE-3 — refusals are localized (`evalErrors.ts`), and announcements
 *    are plural-aware.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../../ui/Button.js';
import { focusByKey } from './focusKey.js';
import { Notice } from '../../../ui/Notice.js';
import { StateCard } from '../../../ui/StateCard.js';
import { SelectField } from '../../../ui/Field.js';
import { DataTable, type DataColumn } from '../../../ui/DataTable.js';
import { confirm } from '../../../ui/confirm.js';
import { announce } from '../../../ui/announce.js';
import { useFormat } from '../../../i18n/useFormat.js';
import { FlaskIcon, PlusIcon, PlayIcon, PencilIcon, TrashIcon, LockIcon, AlertIcon, BanIcon, EraserIcon } from '../../../ui/icons/index.js';
import {
  AgentEvalsRequestError, deleteEvalSuite, getEvalCapability, getEvalProgress, getEvalSummary, isTerminalStatus, listEvalRuns, listEvalSuites, startEvalRun,
  type EvalCapability, type EvalProgress, type ModelPin, type EvalRunRow, type EvalSummary, type StoredSuite,
} from './agentEvalsClient.js';
import { EvalScorecard, PassChip, RegressionChip } from './EvalScorecard.js';
import { EvalSuiteEditor } from './EvalSuiteEditor.js';
import { EvalCaptureSection } from './EvalCaptureSection.js';
import { evalErrorMessage } from './evalErrors.js';
import { fetchModelCapabilities, type ProviderCapabilities } from '../../../client/chatSessionsClient.js';
import { PROVIDERS } from '../../../byok/lib/providers.js';

/** How often the live scorecard re-reads progress. */
export const POLL_MS = 1500;
/** How often the history re-reads while a row is still running and no scorecard is watching it. */
export const HISTORY_POLL_MS = 5000;

type Editing = { suite: StoredSuite | null } | null;

/** Model classes a suite may restrict itself to (`allowedModels`, the RFC 0081 classes). */
const MODEL_CLASSES = new Set(['reasoning', 'writing', 'coding', 'research', 'classification', 'general']);

/** The capability only shapes the editor's hints. `null` means UNKNOWN (the read
 *  failed), and the editor then makes no claim about trials either way. */
async function readCapability(): Promise<EvalCapability | null> {
  try { return await getEvalCapability(); } catch { return null; }
}

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function AgentEvalsPanel({ agentId, persona, canWrite, onDirtyChange }: {
  agentId: string;
  persona: string;
  canWrite: boolean;
  /** The workspace tab host's unsaved-edits signal (EVUX-5). */
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const [suites, setSuites] = useState<StoredSuite[] | null>(null);
  const [runs, setRuns] = useState<EvalRunRow[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);
  // EVAL-10 — the history is paged server-side; `nextCursor` loads older runs.
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [capability, setCapability] = useState<EvalCapability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<{ text: string; edit?: StoredSuite } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // A run-start refusal the Run card's own controls own (baseline, model) lands on them.
  const [runFieldError, setRunFieldError] = useState<{ field: 'baseline' | 'model'; message: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [suiteRef, setSuiteRef] = useState('');
  const [baselineRunId, setBaselineRunId] = useState('');
  // D8 — an optional model pin. '' = the agent's own model (nothing is sent).
  const [modelKey, setModelKey] = useState('');
  const [providers, setProviders] = useState<ProviderCapabilities[]>([]);
  const [starting, setStarting] = useState(false);

  // EVUX-3 — the open scorecard is part of the URL, so refresh / Back / share keep it.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRunId = searchParams.get('run');
  const setSelectedRunId = useCallback((runId: string | null): void => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (runId) p.set('run', runId);
      else p.delete('run');
      return p;
    });
  }, [setSearchParams]);

  // ADR 0889 residue — the editor REPLACES the panel and the scorecard closes in
  // place, so the element that opened either is gone or hidden when it closes.
  // Remember which trigger opened it (a `data-focus-key`) and hand focus back.
  const returnFocusKey = useRef<string | null>(null);
  const openEditor = (suite: StoredSuite | null, focusKey: string): void => {
    returnFocusKey.current = focusKey;
    setEditing({ suite });
  };
  const closeScorecard = (): void => {
    returnFocusKey.current = 'history';
    setSelectedRunId(null);
    // EVUX-14 — a scorecard closed mid-run stops its poll; the history keeps the row honest.
    void refreshRuns();
  };
  useEffect(() => {
    if (editing || !returnFocusKey.current) return;
    if (returnFocusKey.current === 'history' && selectedRunId) return;
    const key = returnFocusKey.current;
    returnFocusKey.current = null;
    if (key === 'history') document.getElementById('ae-history-title')?.focus();
    else if (!focusByKey(key)) document.getElementById('ae-suites-title')?.focus();
  }, [editing, selectedRunId]);

  // EVUX-3 — opening a scorecard (a history row, a fresh run, or a `?run=` link)
  // brings it into view and puts focus on its heading.
  const scorecardSlot = useRef<HTMLDivElement>(null);
  const focusedRun = useRef<string | null>(null);
  const suitesReady = suites !== null;
  useEffect(() => {
    if (!selectedRunId) { focusedRun.current = null; return; }
    if (editing || !suitesReady || focusedRun.current === selectedRunId) return;
    focusedRun.current = selectedRunId;
    const heading = document.getElementById(`ae-scorecard-${selectedRunId}`);
    const target = heading ?? scorecardSlot.current;
    if (!target) return;
    target.focus();
    target.scrollIntoView?.({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [selectedRunId, editing, suitesReady]);

  const [progress, setProgress] = useState<EvalProgress | null>(null);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const [scoreAttempt, setScoreAttempt] = useState(0);

  const refreshRuns = useCallback(async (): Promise<void> => {
    try {
      const page = await listEvalRuns(agentId);
      setRuns(page.items);
      setNextCursor(page.nextCursor);
      setRunsFailed(false);
    } catch {
      setRunsFailed(true);
    }
  }, [agentId]);
  const loadOlder = async (): Promise<void> => {
    if (!nextCursor) return;
    setLoadingOlder(true);
    try {
      const page = await listEvalRuns(agentId, nextCursor);
      setRuns((prev) => [...(prev ?? []), ...page.items.filter((r) => !(prev ?? []).some((p) => p.runId === r.runId))]);
      setNextCursor(page.nextCursor);
    } catch {
      setRunsFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const [s, cap] = await Promise.all([
        listEvalSuites(agentId),
        readCapability(),
      ]);
      setSuites(s);
      setCapability(cap);
    } catch (err) {
      setLoadError(evalErrorMessage(t, f, err));
    }
    await refreshRuns();
  }, [agentId, refreshRuns, t, f]);

  useEffect(() => { void load(); }, [load]);

  // EVUX-14 — while any history row is still running and no scorecard is
  // watching it, re-read the history so it never shows "Scoring" forever.
  const unwatchedLive = (runs ?? []).some((r) => !isTerminalStatus(r.status) && r.runId !== selectedRunId);
  useEffect(() => {
    if (!unwatchedLive) return undefined;
    const timer = setTimeout(() => { void refreshRuns(); }, HISTORY_POLL_MS);
    return () => clearTimeout(timer);
  }, [unwatchedLive, runs, refreshRuns]);

  // The same catalog the chat's ModelSwitcher reads. It resolves to [] on any
  // failure, and then the picker is simply absent (the run uses the agent's model).
  useEffect(() => {
    let live = true;
    void fetchModelCapabilities().then((p) => { if (live) setProviders(p); });
    return () => { live = false; };
  }, []);
  // EVUX-10 — an eval drives the agent's tool loop, so only tool-capable models
  // are offered, grouped under the provider's display name.
  const modelGroups = useMemo(
    () => providers
      .map((p) => ({
        provider: p.provider,
        label: PROVIDERS.find((x) => x.id === p.provider)?.label ?? p.provider,
        models: (p.models ?? [])
          .filter((m) => (m.capabilities ?? []).includes('tools'))
          .map((m) => ({ key: `${p.provider}:${m.id}`, pin: { provider: p.provider, model: m.id }, label: m.label })),
      }))
      .filter((g) => g.models.length > 0),
    [providers],
  );
  const modelPin: ModelPin | undefined = modelGroups.flatMap((g) => g.models).find((o) => o.key === modelKey)?.pin;

  // Default the run picker to the first suite once the list is in.
  useEffect(() => {
    if (suites && suites.length > 0 && !suites.some((s) => s.ref === suiteRef)) setSuiteRef(suites[0]!.ref);
  }, [suites, suiteRef]);
  const selectedSuite = suites?.find((s) => s.ref === suiteRef);
  const allowedClasses = (selectedSuite?.suite.allowedModels ?? []).filter((c) => MODEL_CLASSES.has(c));

  // Live scorecard: poll progress until terminal, then make sure a summary is in hand.
  const pollToken = useRef(0);
  useEffect(() => {
    if (!selectedRunId) return undefined;
    const token = ++pollToken.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = (): boolean => pollToken.current === token;
    // Announce only a run this view WATCHED settle, not one opened from history.
    let sawLive = false;
    setProgress(null);
    setSummary(null);
    setScoreError(null);
    const tick = async (): Promise<void> => {
      try {
        const p = await getEvalProgress(selectedRunId);
        if (!alive()) return;
        setProgress(p);
        if (p.summary) setSummary(p.summary);
        if (!isTerminalStatus(p.status)) {
          sawLive = true;
          timer = setTimeout(() => { void tick(); }, POLL_MS);
          return;
        }
        // The live hint is not a live region (it re-renders every tick); say the
        // outcome once, when the run settles. `count` picks the plural form (AE-3).
        if (sawLive) announce(p.status === 'completed'
          ? (p.summary
            ? t(p.summary.passed ? 'aeAnnouncePassed' : 'aeAnnounceFailed', { passed: f.number(p.summary.passedCount), total: f.number(p.summary.taskCount), count: p.summary.taskCount })
            : t('aeAnnounceDone'))
          : t('aeRunFailed'));
        if (!p.summary && p.status === 'completed') {
          // The progress rows still render without it; the summary only adds the figures.
          try {
            const s = await getEvalSummary(selectedRunId);
            if (alive()) setSummary(s);
          } catch { /* the scorecard stays on the per-trial progress */ }
        }
        void refreshRuns();
      } catch (err) {
        if (alive()) setScoreError(evalErrorMessage(t, f, err));
      }
    };
    void tick();
    return () => { pollToken.current += 1; if (timer) clearTimeout(timer); };
  }, [selectedRunId, scoreAttempt, refreshRuns, t, f]);

  const baselines = useMemo(
    () => (runs ?? []).filter((r) => r.suiteRef === suiteRef && r.status === 'completed'),
    [runs, suiteRef],
  );
  useEffect(() => {
    if (baselineRunId && !baselines.some((b) => b.runId === baselineRunId)) setBaselineRunId('');
  }, [baselines, baselineRunId]);

  const onRun = async (): Promise<void> => {
    if (!suiteRef) return;
    setStarting(true);
    setActionError(null);
    setRunFieldError(null);
    setNotice(null);
    try {
      const { runId } = await startEvalRun({ evalSuiteRef: suiteRef, agentId, ...(baselineRunId ? { baselineRunId } : {}), ...(modelPin ? { ai: modelPin } : {}) });
      setSelectedRunId(runId);
      void refreshRuns();
    } catch (err) {
      const message = evalErrorMessage(t, f, err);
      const field = err instanceof AgentEvalsRequestError ? err.field : undefined;
      if (field === 'configurable.baselineRunId') setRunFieldError({ field: 'baseline', message });
      else if (modelGroups.length > 0 && (field === 'configurable.ai' || (err instanceof AgentEvalsRequestError && err.reason === 'model_class_not_allowed'))) setRunFieldError({ field: 'model', message });
      else setActionError(message);
    } finally {
      setStarting(false);
    }
  };

  const onDelete = async (s: StoredSuite): Promise<void> => {
    const ok = await confirm({ title: t('aeDeleteConfirm', { ref: s.ref }), danger: true, confirmLabel: t('aeDelete') });
    if (!ok) return;
    setActionError(null);
    setDeleting(s.ref);
    try {
      await deleteEvalSuite(s.ref);
      setSuites((prev) => (prev ?? []).filter((x) => x.ref !== s.ref));
      setNotice({ text: t('aeSuiteDeleted', { ref: s.ref }) });
      // EVUX-16 — the row (and its Delete button) is gone; land on the list's heading.
      requestAnimationFrame(() => document.getElementById('ae-suites-title')?.focus());
    } catch (err) {
      setActionError(evalErrorMessage(t, f, err));
    } finally {
      setDeleting(null);
    }
  };

  const upsertSuite = (saved: StoredSuite): void => {
    setSuites((prev) => [...(prev ?? []).filter((x) => x.ref !== saved.ref), saved].sort((a, b) => a.ref.localeCompare(b.ref)));
    setSuiteRef(saved.ref);
  };
  const onSaved = (saved: StoredSuite): void => {
    upsertSuite(saved);
    setEditing(null);
    setNotice({ text: t('aeSuiteSaved', { ref: saved.ref }) });
  };
  const onPromoted = (saved: StoredSuite, taskId: string | undefined): void => {
    upsertSuite(saved);
    setNotice({ text: taskId ? t('aePromotedTask', { ref: saved.ref, taskId }) : t('aePromoted', { ref: saved.ref }), edit: saved });
  };

  const knownRefs = useMemo(() => new Set((suites ?? []).map((s) => s.ref)), [suites]);

  const historyColumns: DataColumn<EvalRunRow>[] = [
    { key: 'started', header: t('aeColStarted'), sortValue: (r) => r.createdAt, render: (r) => f.dateTime(r.createdAt) },
    { key: 'suite', header: t('aeColSuite'), sortValue: (r) => r.suiteRef, render: (r) => <code className="u-fs-12" dir="ltr">{r.suiteRef}</code> },
    { key: 'result', header: t('aeColResult'), render: (r) => <HistoryResult row={r} /> },
    { key: 'score', header: t('aeColScore'), align: 'right', cellClassName: 'u-tabular', sortValue: (r) => r.aggregateScore ?? null, render: (r) => (r.aggregateScore === undefined ? '—' : f.number(r.aggregateScore, { maximumFractionDigits: 2 })) },
    { key: 'tasks', header: t('aeColTasksPassed'), align: 'right', cellClassName: 'u-tabular', render: (r) => (r.taskCount === undefined ? '—' : t('aeOfCount', { passed: f.number(r.passedCount ?? 0), total: f.number(r.taskCount) })) },
    { key: 'regression', header: t('aeColRegression'), render: (r) => (r.regression ? <RegressionChip regression={r.regression} /> : <span className="muted">—</span>) },
  ];

  if (loadError) {
    return (
      <StateCard
        icon={<AlertIcon size={20} />}
        title={t('aeLoadFailed')}
        body={loadError}
        announce
        action={<Button variant="secondary" onClick={() => void load()}>{t('retry')}</Button>}
      />
    );
  }
  if (!suites) return <StateCard icon={<FlaskIcon size={20} />} title={t('aeLoading')} loading />;

  if (editing) {
    return (
      <EvalSuiteEditor
        agentId={agentId}
        initial={editing.suite}
        knownRefs={knownRefs}
        capability={capability}
        onSaved={onSaved}
        onCancel={() => setEditing(null)}
        {...(onDirtyChange ? { onDirtyChange } : {})}
      />
    );
  }

  return (
    <div className="u-flex u-flex-col u-gap-4">
      {notice ? (
        <Notice variant="success" announce={notice.text}>
          {notice.text}
          {notice.edit && canWrite ? <> <Button variant="link" data-focus-key={`edit:${notice.edit.ref}`} onClick={() => openEditor(notice.edit!, `edit:${notice.edit!.ref}`)}>{t('aeEditPromoted')}</Button></> : null}
        </Notice>
      ) : null}
      {actionError ? <Notice variant="error" announce={actionError}>{actionError}</Notice> : null}

      {suites.length === 0 ? (
        <StateCard
          icon={<FlaskIcon size={20} />}
          title={t('aeEmptyTitle')}
          body={t('aeEmptyBody', { persona })}
          action={canWrite ? <Button variant="primary" data-focus-key="create" onClick={() => openEditor(null, 'create')}><PlusIcon size={14} /> {t('aeCreateSuite')}</Button> : undefined}
        />
      ) : (
        <>
          <section className="surface-card" aria-labelledby="ae-run-title">
            <h2 id="ae-run-title" className="u-m-0 u-fs-16">{t('aeRunTitle')}</h2>
            <p className="muted u-fs-13 u-m-0">{t('aeRunHint', { persona })}</p>
            <div className="u-flex u-items-end u-gap-3 u-wrap">
              <SelectField label={t('aeSuiteLabel')} className="u-minw-240" value={suiteRef} dir="ltr" onChange={(e) => setSuiteRef(e.target.value)}>
                {suites.map((s) => <option key={s.ref} value={s.ref}>{s.ref}</option>)}
              </SelectField>
              <SelectField
                label={t('aeBaselineLabel')}
                help={baselines.length === 0 ? t('aeBaselineNone') : t('aeBaselineHelp')}
                className="u-minw-240"
                value={baselineRunId}
                disabled={baselines.length === 0}
                error={runFieldError?.field === 'baseline' ? runFieldError.message : undefined}
                onChange={(e) => { setRunFieldError(null); setBaselineRunId(e.target.value); }}
              >
                <option value="">{t('aeBaselineOff')}</option>
                {baselines.map((b) => (
                  <option key={b.runId} value={b.runId}>
                    {t('aeBaselineOption', { when: f.dateTime(b.createdAt), score: b.aggregateScore === undefined ? '—' : f.number(b.aggregateScore, { maximumFractionDigits: 2 }) })}
                  </option>
                ))}
              </SelectField>
              {modelGroups.length > 0 ? (
                <SelectField
                  label={t('aeModelLabel')}
                  help={allowedClasses.length > 0
                    ? t('aeModelAllowed', { classes: f.list(allowedClasses.map((c) => t(`aeModelClass_${c}`))) })
                    : t('aeModelHelp')}
                  className="u-minw-240"
                  value={modelKey}
                  error={runFieldError?.field === 'model' ? runFieldError.message : undefined}
                  onChange={(e) => { setRunFieldError(null); setModelKey(e.target.value); }}
                >
                  <option value="">{t('aeModelDefault')}</option>
                  {modelGroups.map((g) => (
                    <optgroup key={g.provider} label={g.label}>
                      {g.models.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </optgroup>
                  ))}
                </SelectField>
              ) : null}
              {canWrite ? (
                <Button variant="primary" loading={starting} disabled={!suiteRef} onClick={() => void onRun()}>
                  <PlayIcon size={14} /> {t('aeRunButton')}
                </Button>
              ) : null}
            </div>
            {/* EVUX-19 — a reader can browse suites and history, and is told why there is no Run. */}
            {!canWrite ? <p className="muted u-fs-13 u-m-0">{t('aeReadOnlyReason')}</p> : null}
          </section>

          {selectedRunId ? (
            <div ref={scorecardSlot} tabIndex={-1}>
              {scoreError ? (
                <StateCard
                  icon={<AlertIcon size={20} />}
                  title={t('aeScorecardFailed')}
                  body={scoreError}
                  announce
                  action={(
                    <div className="action-bar">
                      <Button variant="secondary" onClick={() => setScoreAttempt((n) => n + 1)}>{t('retry')}</Button>
                      <Button variant="quiet" onClick={closeScorecard}>{t('aeCloseScorecard')}</Button>
                    </div>
                  )}
                />
              ) : (
                <EvalScorecard runId={selectedRunId} agentId={agentId} progress={progress} summary={summary} onClose={closeScorecard} />
              )}
            </div>
          ) : null}

          <section className="surface-card" aria-labelledby="ae-suites-title">
            <div className="u-flex u-items-center u-justify-between u-gap-3 u-wrap">
              <h2 id="ae-suites-title" tabIndex={-1} className="u-m-0 u-fs-16">{t('aeSuitesTitle')}</h2>
              {canWrite ? <Button variant="secondary" size="sm" data-focus-key="create" onClick={() => openEditor(null, 'create')}><PlusIcon size={14} /> {t('aeNewSuite')}</Button> : null}
            </div>
            <ul className="u-list-plain">
              {suites.map((s) => (
                <li key={s.ref} className="evals-suite-row">
                  <div className="u-flex u-items-center u-gap-2 u-wrap u-min-w-0">
                    <code className="u-truncate" dir="ltr">{s.ref}</code>
                    <span className="chip chip--muted">{t('aeTaskCount', { count: s.suite.tasks.length })}</span>
                    {(s.suite.trials?.count ?? 1) > 1 ? <span className="chip chip--muted">{t('aeTrialCount', { count: s.suite.trials?.count ?? 1 })}</span> : null}
                    {s.source === 'pack'
                      ? <span className="chip chip--muted" title={t('aeFromPackTitle', { pack: s.pack ?? '' })}><LockIcon size={12} />{t('aeFromPack')}</span>
                      : s.locked ? <span className="chip chip--muted" title={t('aeLockedTitle')}><LockIcon size={12} />{t('aeLocked')}</span> : null}
                    {/* EVD-10 — an erasure redacted task content; an exact-args fixture may now miss. */}
                    {s.erasedAt ? <span className="chip chip--warning" title={t('aeErasedTitle', { when: f.dateTime(s.erasedAt) })}><EraserIcon size={12} />{t('aeErased')}</span> : null}
                  </div>
                  {/* A pack-shipped suite is read-only: it lives in the agent's pack, not this workspace (ADR 0889 D2). */}
                  {canWrite && s.source !== 'pack' ? (
                    <div className="action-bar">
                      <Button variant="quiet" size="sm" data-focus-key={`edit:${s.ref}`} onClick={() => openEditor(s, `edit:${s.ref}`)} aria-label={t('aeEditLabel', { ref: s.ref })}>
                        <PencilIcon size={14} /> {t('aeEdit')}
                      </Button>
                      {/* A locked (run-referenced) version cannot be deleted — the server answers 409 (ADR 0889 review M2). */}
                      {!s.locked ? (
                        <Button variant="quiet" size="sm" loading={deleting === s.ref} disabled={deleting !== null} onClick={() => void onDelete(s)} aria-label={t('aeDeleteLabel', { ref: s.ref })}>
                          <TrashIcon size={14} /> {t('aeDelete')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <EvalCaptureSection agentId={agentId} persona={persona} suites={suites} canWrite={canWrite} onSuiteUpdated={onPromoted} />

      <section className="surface-card" aria-labelledby="ae-history-title">
        <h2 id="ae-history-title" tabIndex={-1} className="u-m-0 u-fs-16">{t('aeHistoryTitle')}</h2>
        {runsFailed ? (
          <Notice variant="error" announce={t('aeHistoryFailed')}>
            {t('aeHistoryFailed')} <Button variant="link" onClick={() => void refreshRuns()}>{t('retry')}</Button>
          </Notice>
        ) : runs === null ? (
          <p className="muted u-fs-13 u-m-0">{t('aeLoading')}</p>
        ) : (
          <DataTable
            columns={historyColumns}
            rows={runs}
            rowKey={(r) => r.runId}
            onRowClick={(r) => setSelectedRunId(r.runId)}
            caption={t('aeHistoryCaption')}
            density="compact"
            stack
            rowClassName={(r) => (r.runId === selectedRunId ? 'is-selected' : undefined)}
            empty={<p className="muted u-fs-13">{t('aeHistoryEmpty')}</p>}
          />
        )}
        {nextCursor && !runsFailed ? (
          <div><Button variant="secondary" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>{t('aeHistoryOlder')}</Button></div>
        ) : null}
      </section>
    </div>
  );
}

/** EVUX-12 — every terminal status reads as terminal; only a live run says "Scoring". */
function HistoryResult({ row }: { row: EvalRunRow }): JSX.Element {
  const { t } = useTranslation('evals');
  if (row.passed !== undefined) return <PassChip passed={row.passed} />;
  if (row.status === 'failed') return <span className="chip chip--danger"><AlertIcon size={12} />{t('aeRunFailedShort')}</span>;
  if (row.status === 'cancelled' || row.status === 'canceled') return <span className="chip chip--muted"><BanIcon size={12} />{t('aeRunCancelledShort')}</span>;
  if (row.status === 'expired') return <span className="chip chip--muted"><BanIcon size={12} />{t('aeRunExpiredShort')}</span>;
  if (row.status === 'completed') return <span className="chip chip--muted">{t('aeRunNoScore')}</span>;
  return <PassChip passed={undefined} />;
}
