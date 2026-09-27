/**
 * EvalsDrawer (ADR 0477 §5) — the builder's evaluation panel: per-set rows
 * (name, case count, promote-gate chip, latest-result chip), Run-now with
 * live polling, per-case verdict detail (per-assertion pass/fail + run
 * deep-links), a JSON editor for create/edit (v1 — the pin-editor precedent;
 * a form builder is a recorded follow-on), and two-step delete.
 *
 * Honesty rules: a running result POLLS until complete (never a stale
 * spinner); server validation errors surface verbatim (they name the
 * offending case/assertion); the latest-result chip never claims green for a
 * result of an OLDER revision than it can know about (the server-side
 * promote gate is the authority — the chip is contextual).
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { StateCard } from '../ui/index.js';
import { FlaskIcon, PlayIcon, XIcon } from '../ui/icons/index.js';
import { formatDate, formatNumber } from '../i18n/format.js';
import { drawerEscapeHandler } from './builderShellHelpers.js';
import {
  listEvalSets, putEvalSet, deleteEvalSet, runEvalSet, listEvalResults, listOnlineBuckets,
  type WorkflowEvalSetDTO, type WorkflowEvalResultDTO, type EvalCaseDTO, type OnlineEvalBucketDTO,
} from '../workflows/workflowEvalsClient.js';
import { Sparkline } from '../ui/Sparkline.js';
import { listWorkflowRevisions } from '../workflows/workflowsClient.js';

const TEMPLATE: { name: string; requiredForPromote: boolean; online: { enabled: boolean; sampleRate: number; assertions: unknown[] }; cases: EvalCaseDTO[] } = {
  name: 'Smoke',
  requiredForPromote: false,
  // ADR 0480 — the online lane's shape, discoverable from the editor (off by
  // default; flip enabled to score production runs against these invariants).
  online: { enabled: false, sampleRate: 1, assertions: [{ kind: 'status', value: 'completed' }] },
  cases: [
    {
      caseId: 'case-1',
      inputs: { example: 'value' },
      assertions: [
        { kind: 'status', value: 'completed' },
        { kind: 'output-contains', value: 'expected text' },
      ],
    },
  ],
};

/** ADR 0480 — the per-set online trend block: last-7d pass rate, a daily
 *  pass-rate sparkline over the bucket window, and recent failing runs
 *  (opaque refs — a retention-deleted run 404s honestly on the deep link).
 *  Honesty: window + sample rate are DISCLOSED beside the numbers. */
function OnlineTrend({ buckets, sampleRate, t }: {
  buckets: OnlineEvalBucketDTO[] | 'error' | undefined;
  sampleRate: number;
  t: TFunction<'builder'>;
}): JSX.Element {
  if (buckets === 'error') {
    return <p className="alert error u-fs-11 u-m-0" role="alert">{t('onlineLoadFailed')}</p>;
  }
  if (buckets === undefined) {
    return <p className="muted u-fs-11 u-m-0" role="status">{t('onlineLoading')}</p>;
  }
  const evaluated = buckets.reduce((a, b) => a + b.evaluated, 0);
  if (evaluated === 0) {
    return <p className="muted u-fs-11 u-m-0">{t('onlineEmpty', { pct: formatNumber(sampleRate * 100, { maximumFractionDigits: 0 }) })}</p>;
  }
  // ux review — "last 7 days" must mean CALENDAR days (buckets exist only
  // for days with traffic; slicing rows made the claim false for sparse
  // workflows), and the sparkline discloses it plots ACTIVE days only (a
  // single polyline cannot render gaps; zero-filling would fake 0% days).
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const last7 = buckets.filter((b) => b.day >= cutoff);
  const eval7 = last7.reduce((a, b) => a + b.evaluated, 0);
  const pass7 = last7.reduce((a, b) => a + b.passed, 0);
  const pct7 = eval7 > 0 ? Math.round((pass7 / eval7) * 100) : null;
  const activeDays = buckets.filter((b) => b.evaluated > 0);
  const series = activeDays.map((b) => b.passed / b.evaluated);
  const failures = [...buckets].reverse().flatMap((b) => [...b.failures].reverse()).slice(0, 5);
  const judgeSkipped = buckets.reduce((a, b) => a + b.judgeSkipped, 0);
  return (
    <div className="u-flex u-flex-col u-gap-1 u-fs-11">
      <span className="u-flex u-items-center u-gap-2 u-wrap">
        <span className={`chip u-fs-10 ${pct7 === null ? 'chip--muted' : pct7 >= 90 ? 'chip--success' : pct7 >= 50 ? 'chip--warning' : 'chip--danger'}`}>
          {pct7 === null ? t('onlineNoRecent') : t('onlinePass7d', { pct: pct7, count: eval7 })}
        </span>
        {series.length >= 2 ? (
          <span className="binspector-online-spark"><Sparkline points={series} domain={[0, 1]} label={t('onlineSparkAria', { count: series.length })} /></span>
        ) : null}
        <span className="muted">{t('onlineWindowNote', { count: activeDays.length, pct: formatNumber(sampleRate * 100, { maximumFractionDigits: 0 }) })}</span>
      </span>
      {judgeSkipped > 0 ? <span className="muted">{t('onlineJudgeSkipped', { count: judgeSkipped })}</span> : null}
      {failures.length > 0 ? (
        <span className="u-flex u-items-center u-gap-2 u-wrap">
          <span className="muted">{t('onlineRecentFailures')}</span>
          {failures.map((f) => (
            <Link
              key={`${f.runId}-${f.at}`}
              className="inline-link"
              to={`/runs/${encodeURIComponent(f.runId)}`}
              aria-label={t('onlineFailureLinkAria', { runId: f.runId.slice(0, 8), kinds: f.failedKinds.join(', ') || t('onlineFailureRunFailed'), date: formatDate(f.at) })}
              title={f.failedKinds.join(', ')}
            >
              {f.runId.slice(0, 8)}… <span className="muted">({formatDate(f.at)})</span>
            </Link>
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function EvalsDrawer({ workflowId, open, onClose }: {
  workflowId: string;
  open: boolean;
  onClose(): void;
}): JSX.Element | null {
  const { t } = useTranslation('builder');
  const rootRef = useRef<HTMLElement | null>(null);
  // Grade-ux #6 — focus moves into the drawer when it opens.
  useEffect(() => { if (open) rootRef.current?.focus(); }, [open]);
  const [sets, setSets] = useState<WorkflowEvalSetDTO[] | null>(null);
  const [results, setResults] = useState<Map<string, WorkflowEvalResultDTO>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ evalSetId: string; draft: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // ADR 0480 — online trend buckets, fetched lazily per set on expansion
  // (bounds reads to one per opened set; 'error' renders a named notice).
  const [onlineBuckets, setOnlineBuckets] = useState<Map<string, OnlineEvalBucketDTO[] | 'error'>>(new Map());
  // ux-review F1 — the head's content hash: a green result of an OLDER
  // revision must never render as plain green (the promote gate will refuse
  // it as stale; the chip must agree with the gate).
  const [headHash, setHeadHash] = useState<string | null>(null);
  // …and a failed revisions read is NOT "no revisions". Falling back to `null`
  // skipped the staleness check entirely and chose the OPTIMISTIC branch, so an
  // unreadable head made the chip claim plain green on a result the promote gate
  // would refuse — the exact disagreement the comment above forbids.
  const [headUnknown, setHeadUnknown] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, r, revs] = await Promise.all([
        listEvalSets(workflowId),
        listEvalResults(workflowId),
        listWorkflowRevisions(workflowId).then((rows) => ({ ok: true as const, rows })).catch(() => ({ ok: false as const })),
      ]);
      if (!openRef.current) return; // ux-review F3 — closed mid-flight: no state, no re-schedule
      setSets(s);
      setHeadUnknown(!revs.ok);
      setHeadHash(revs.ok ? (revs.rows.find((rev) => rev.isHead)?.revisionHash ?? null) : null);
      const latest = new Map<string, WorkflowEvalResultDTO>();
      for (const row of r) if (!latest.has(row.evalSetId)) latest.set(row.evalSetId, row); // newest first
      setResults(latest);
      // Poll while anything is still running (the honest spinner).
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (r.some((row) => row.status === 'running')) {
        pollTimer.current = setTimeout(() => { void load(); }, 2000);
      }
    } catch {
      if (openRef.current) setError(t('evalsLoadFailed'));
    }
  }, [workflowId, t]);

  useEffect(() => {
    openRef.current = open;
    if (open) { setSets(null); setEditing(null); setDeleting(null); setOnlineBuckets(new Map()); void load(); }
    return () => { openRef.current = false; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [open, load]);

  if (!open) return null;

  async function onRun(evalSetId: string): Promise<void> {
    setBusy(evalSetId);
    setError(null);
    try {
      await runEvalSet(workflowId, evalSetId);
      await load();
    } catch (err) {
      // ux-review F2 — refusals are often NAMED (capability, quota); only the
      // bare typed code falls back to the generic copy.
      const msg = err instanceof Error ? err.message : '';
      setError(/^eval_run_\d+$/.test(msg) || !msg ? t('evalsRunFailed') : msg);
    } finally {
      setBusy(null);
    }
  }

  async function onSaveDraftSet(): Promise<void> {
    if (!editing) return;
    setBusy(editing.evalSetId);
    setError(null);
    try {
      const parsed = JSON.parse(editing.draft) as { name: string; requiredForPromote?: boolean; cases: EvalCaseDTO[] };
      await putEvalSet(workflowId, editing.evalSetId, parsed);
      setEditing(null);
      await load();
    } catch (err) {
      // Server messages name the offending case/assertion; JSON.parse errors
      // get the localized wrapper.
      setError(
        err instanceof SyntaxError ? t('evalsInvalidJson')
          : err instanceof Error && err.message === 'eval_set_put_404' ? t('evalsWorkflowUnsynced')
          : err instanceof Error ? err.message
          : t('evalsSaveFailed'),
      );
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(evalSetId: string): Promise<void> {
    setBusy(evalSetId);
    setError(null);
    try {
      await deleteEvalSet(workflowId, evalSetId);
      setDeleting(null);
      await load();
    } catch {
      setError(t('evalsDeleteFailed'));
    } finally {
      setBusy(null);
    }
  }

  function resultChip(r: WorkflowEvalResultDTO | undefined): JSX.Element {
    if (!r) return <span className="chip chip--muted u-fs-10">{t('evalsNeverRun')}</span>;
    if (r.status === 'running') return <span className="chip chip--muted u-fs-10">{t('evalsRunning')}</span>;
    // Grade-data M6 — a run stranded by an instance restart is repaired
    // server-side to `incomplete`; say so instead of an eternal "running".
    if (r.status === 'incomplete') return <span className="chip chip--warning u-fs-10" title={t('evalsIncompleteTitle')}>{t('evalsIncomplete')}</span>;
    const failed = r.cases.filter((c) => c.status !== 'passed').length;
    if (failed > 0) return <span className="chip chip--danger u-fs-10">{t('evalsRed', { failed, total: r.cases.length })}</span>;
    // ux-review F1 — a green result of an OLDER revision is STALE, not green:
    // the promote gate will refuse it, so the chip must say so too.
    if (headHash && r.revisionHash !== headHash) {
      return <span className="chip chip--muted u-fs-10" title={t('evalsGreenStaleTitle')}>{t('evalsGreenStale')}</span>;
    }
    // Freshness unverifiable ⇒ do not promise green. The gate may still refuse.
    if (headUnknown) {
      return <span className="chip chip--muted u-fs-10" title={t('evalsGreenUnverifiedTitle')}>{t('evalsGreenUnverified')}</span>;
    }
    return <span className="chip chip--success u-fs-10">{t('evalsGreen', { count: r.cases.length })}</span>;
  }

  return (
    // Grade-ux #6 — Escape closes; focus moves in on open (see HistoryDrawer).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="surface-card builder-history-drawer"
      aria-label={t('evalsAria')}
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={drawerEscapeHandler(onClose)}
    >
      <header className="u-flex u-items-center u-gap-2">
        <FlaskIcon size={16} />
        <h3 className="u-fs-13 u-m-0">{t('evalsTitle')}</h3>
        <span className="review-card__spacer" />
        <Button
          variant="secondary" size="sm"
          onClick={() => setEditing({ evalSetId: `set-${Date.now().toString(36)}`, draft: JSON.stringify(TEMPLATE, null, 2) })}
          disabled={busy !== null}
        >
          {t('evalsNewSet')}
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose} aria-label={t('evalsClose')}>
          <XIcon size={14} />
        </Button>
      </header>
      {error ? <p className="alert error u-fs-12 u-m-0" role="alert">{error}</p> : null}

      {editing ? (
        <div className="u-flex u-flex-col u-gap-2">
          <textarea
            className="binspector-debug-pin-editor"
            rows={14}
            value={editing.draft}
            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
            aria-label={t('evalsEditorLabel')}
            spellCheck={false}
          />
          <div className="u-flex u-gap-2">
            <Button variant="accent-solid" size="sm" onClick={() => { void onSaveDraftSet(); }} disabled={busy !== null}>
              {t('evalsSaveSet')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)} disabled={busy !== null}>
              {t('common:cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {sets === null && !error ? <StateCard loading title={t('evalsLoading')} /> : null}
      {sets !== null && sets.length === 0 && !editing ? (
        <StateCard title={t('evalsEmptyTitle')} body={t('evalsEmptyBody')} />
      ) : null}

      {sets !== null && sets.length > 0 ? (
        <ol className="builder-history-drawer__list" aria-label={t('evalsTitle')}>
          {sets.map((s) => {
            const latest = results.get(s.evalSetId);
            return (
              <li key={s.evalSetId} className="builder-history-drawer__row">
                <div className="u-flex u-items-center u-gap-2 u-wrap">
                  <strong className="u-fs-12">{s.name}</strong>
                  <span className="muted u-fs-11">{t('evalsCaseCount', { count: s.cases.length })}</span>
                  {s.requiredForPromote ? (
                    <span className="chip chip--accent u-fs-10" title={t('evalsGateChipTitle')}>{t('evalsGateChip')}</span>
                  ) : null}
                  {resultChip(latest)}
                  {s.online?.enabled ? (
                    <span className="chip chip--muted u-fs-10" title={t('onlineChipTitle', { pct: formatNumber((s.online.sampleRate ?? 1) * 100, { maximumFractionDigits: 0 }) })}>
                      {t('onlineChip')}
                    </span>
                  ) : null}
                  {latest?.finishedAt ? <span className="muted u-fs-11">{formatDate(latest.finishedAt)}</span> : null}
                </div>
                <div className="u-flex u-items-center u-gap-2 u-wrap">
                  <Button variant="secondary" size="sm" className="u-flex u-items-center u-gap-1" onClick={() => { void onRun(s.evalSetId); }} disabled={busy !== null} title={t('evalsRunNowTitle')}>
                    <PlayIcon size={12} /> {t('evalsRunNow')}
                  </Button>
                  <Button
                    variant="secondary" size="sm"
                    onClick={() => setEditing({
                      evalSetId: s.evalSetId,
                      // ux CRITICAL — the draft MUST round-trip `online`: the
                      // backend persists it only when present, so omitting it
                      // here made every case-typo edit silently disable
                      // production scoring.
                      draft: JSON.stringify({ name: s.name, requiredForPromote: s.requiredForPromote, ...(s.online ? { online: s.online } : {}), cases: s.cases }, null, 2),
                    })}
                    disabled={busy !== null}
                  >
                    {t('evalsEdit')}
                  </Button>
                  {latest || s.online?.enabled ? (
                    <Button
                      variant="quiet" size="sm"
                      onClick={() => {
                        const next = expanded === s.evalSetId ? null : s.evalSetId;
                        setExpanded(next);
                        if (next && s.online?.enabled && !onlineBuckets.has(s.evalSetId)) {
                          void listOnlineBuckets(workflowId, s.evalSetId)
                            .then((b) => setOnlineBuckets((m) => new Map(m).set(s.evalSetId, b)))
                            .catch(() => setOnlineBuckets((m) => new Map(m).set(s.evalSetId, 'error')));
                        }
                      }}
                    >
                      {expanded === s.evalSetId ? t('evalsHideDetail') : t('evalsShowDetail')}
                    </Button>
                  ) : null}
                  {deleting === s.evalSetId ? (
                    <>
                      {/* Grade-ux #6 — a question is a polite status, not an
                          assertive alert (role=alert interrupts SR output). */}
                      <span className="u-fs-11" role="status">{t('evalsDeleteConfirm')}</span>
                      <Button variant="danger" size="sm" onClick={() => { void onDelete(s.evalSetId); }} disabled={busy !== null}>
                        {t('evalsDeleteYes')}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setDeleting(null)} disabled={busy !== null}>
                        {t('evalsDeleteNo')}
                      </Button>
                    </>
                  ) : (
                    <Button variant="quiet" size="sm" onClick={() => setDeleting(s.evalSetId)} disabled={busy !== null}>
                      {t('evalsDelete')}
                    </Button>
                  )}
                </div>
                {expanded === s.evalSetId && s.online?.enabled ? (
                  <OnlineTrend
                    buckets={onlineBuckets.get(s.evalSetId)}
                    sampleRate={s.online.sampleRate ?? 1}
                    t={t}
                  />
                ) : null}
                {expanded === s.evalSetId && latest ? (
                  <ul className="builder-history-drawer__list u-fs-11" aria-label={t('evalsDetailAria', { name: s.name })}>
                    {latest.cases.map((c) => (
                      <li key={c.caseId} className="u-flex u-flex-col u-gap-1">
                        <span className="u-flex u-items-center u-gap-2 u-wrap">
                          <code>{c.caseId}</code>
                          <span className={`chip u-fs-10 ${c.status === 'passed' ? 'chip--success' : c.status === 'running' ? 'chip--muted' : 'chip--danger'}`}>
                            {t(`evalsCase_${c.status}`)}
                          </span>
                          {c.runId ? (
                            <Link className="inline-link" to={`/runs/${encodeURIComponent(c.runId)}`}>{t('evalsOpenRun')}</Link>
                          ) : null}
                        </span>
                        {c.assertions.filter((a) => !a.pass).map((a, i) => (
                          <span key={i} className="muted">
                            {t('evalsAssertionFailed', { kind: a.kind, detail: a.detail ?? '' })}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </aside>
  );
}
