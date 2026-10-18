/**
 * The eval scorecard (ADR 0889 D8 / P6) — one run, live or finished.
 *
 * Two sources, one view: the per-trial `progress` (host-internal, carries the
 * judge's reasons) and the RFC 0081 `summary` (present once the run completes).
 * A finished task reads from the summary; a task still running reads from its
 * trials so far. Every number is shown only when its source reported it — a
 * missing figure is a dash, never a confident zero.
 *
 * The trial strip is the one bespoke mark: one square per trial, filled for a
 * pass and outlined for a fail, always beside its "c/n passed" text so colour
 * is never the only signal (DESIGN.md §5.3).
 *
 * Grade remediation (ADR 0889 B): "Ask why" opens the ONE chat scoped to the
 * Agent Author — the agent that can read eval results — with a staged draft
 * naming this run (EVUX-4; `stageComposerDraft`, never a second chat); a run
 * error reads as a localized sentence with the raw code behind a disclosure
 * (BE-1); pass@k / pass^k / fixture misses are explained in place (EVUX-17).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useFormat } from '../../../i18n/useFormat.js';
import { DataTable, type DataColumn } from '../../../ui/DataTable.js';
import { KeyFigureBand, type KeyFigureItem } from '../../../ui/KeyFigure.js';
import { Notice } from '../../../ui/Notice.js';
import { Button } from '../../../ui/Button.js';
import { InfoTip } from '../../../ui/InfoTip.js';
import { CheckIcon, XIcon, ClockIcon, ArrowRightIcon, MessageSquareIcon } from '../../../ui/icons/index.js';
import { stageComposerDraft } from '../../../chat/composerSeed.js';
import { AGENT_AUTHOR_AGENT_ID } from '../../../agents/agentAuthorId.js';
import type { EvalProgress, EvalSummary, Regression, RegressionReason, TrajectoryResult, TrialRecord } from './agentEvalsClient.js';
import { isTerminalStatus } from './agentEvalsClient.js';
import { runErrorMessage } from './evalErrors.js';

interface TaskRow {
  taskId: string;
  /** undefined while the task has no verdict yet (live). */
  passed: boolean | undefined;
  score: number | undefined;
  trials: TrialRecord[];
  trialN: number | undefined;
  trialPassed: number | undefined;
  passAtK: number | undefined;
  passHatK: number | undefined;
  trajectory: TrajectoryResult | undefined;
  fixtureMisses: number | undefined;
  costUsd: number | undefined;
  latencyMs: number | undefined;
  details: string[];
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Merge the summary (authoritative once present) with the live trials. */
export function buildTaskRows(progress: EvalProgress['progress'] | undefined, summary: EvalSummary | null): TaskRow[] {
  const byTask = new Map<string, TrialRecord[]>();
  for (const [taskId, trials] of Object.entries(progress ?? {})) {
    byTask.set(taskId, Object.entries(trials).sort(([a], [b]) => Number(a) - Number(b)).map(([, r]) => r));
  }
  const order = [...(summary?.tasks.map((t) => t.taskId) ?? []), ...byTask.keys()].filter((id, i, all) => all.indexOf(id) === i);
  return order.map((taskId) => {
    const trials = byTask.get(taskId) ?? [];
    const s = summary?.tasks.find((t) => t.taskId === taskId);
    const details = trials.map((r) => r.detail).filter((d): d is string => typeof d === 'string' && d.length > 0);
    if (s) {
      return {
        taskId, passed: s.passed, score: s.score, trials,
        trialN: s.trials?.n ?? (trials.length || undefined),
        trialPassed: s.trials?.passedCount ?? (trials.length ? trials.filter((r) => r.passed).length : undefined),
        passAtK: s.trials?.passAtK, passHatK: s.trials?.passHatK,
        trajectory: s.trajectory ?? trials[0]?.trajectory,
        fixtureMisses: s.fixtureMissCount ?? (trials.length ? sum(trials.map((r) => r.fixtureMissCount)) : undefined),
        costUsd: s.costUsd, latencyMs: s.latencyMs, details,
      };
    }
    return {
      taskId, passed: undefined,
      score: trials.length ? sum(trials.map((r) => r.score)) / trials.length : undefined,
      trials, trialN: trials.length, trialPassed: trials.filter((r) => r.passed).length,
      passAtK: undefined, passHatK: undefined,
      trajectory: trials[trials.length - 1]?.trajectory,
      fixtureMisses: sum(trials.map((r) => r.fixtureMissCount)),
      costUsd: sum(trials.map((r) => r.costUsd)),
      latencyMs: trials.length ? sum(trials.map((r) => r.latencyMs)) / trials.length : undefined,
      details,
    };
  });
}

/** Why an `inconclusive` verdict paired nothing, when the host says (A1 `regressionReason`). */
export function inconclusiveReason(t: TFunction, regression: Regression | undefined, reason: RegressionReason | null | undefined): string | null {
  if (!regression || (regression.verdict ?? 'inconclusive') !== 'inconclusive' || !reason) return null;
  return t(`evals:aeInconclusive_${reason}`, { defaultValue: '' }) || null;
}

export function RegressionChip({ regression, reason }: { regression: Regression; reason?: RegressionReason | null | undefined }): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const verdict = regression.verdict ?? 'inconclusive';
  const why = inconclusiveReason(t, regression, reason);
  const tone = verdict === 'improved' ? 'chip--success' : verdict === 'regressed' ? 'chip--danger' : verdict === 'unchanged' ? 'chip--muted' : 'chip--warning';
  const delta = f.number(regression.scoreDelta, { maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  return (
    <span className={`chip ${tone}`} title={why ?? t('aeRegressionTitle', { baseline: regression.baselineRunId })} dir="auto">
      {t(`aeVerdict_${verdict}`)} <span className="u-tabular">{delta}</span>
    </span>
  );
}

export function PassChip({ passed }: { passed: boolean | undefined }): JSX.Element {
  const { t } = useTranslation('evals');
  if (passed === undefined) return <span className="chip chip--muted"><ClockIcon size={12} />{t('aeScoring')}</span>;
  return passed
    ? <span className="chip chip--success"><CheckIcon size={12} />{t('aePassed')}</span>
    : <span className="chip chip--danger"><XIcon size={12} />{t('aeFailed')}</span>;
}

function TrialStrip({ row, t }: { row: TaskRow; t: TFunction }): JSX.Element {
  const n = row.trialN;
  const c = row.trialPassed;
  return (
    <div className="u-flex u-flex-col u-gap-1">
      {row.trials.length > 1 ? (
        <span className="evals-trials" aria-hidden="true">
          {row.trials.map((r, i) => <span key={i} className={`evals-trial ${r.passed ? 'evals-trial--pass' : 'evals-trial--fail'}`} />)}
        </span>
      ) : null}
      <span className="u-tabular">{n !== undefined && c !== undefined ? t('aeTrialsPassed', { passed: c, total: n }) : '—'}</span>
    </div>
  );
}

export function EvalScorecard({
  runId, agentId, progress, summary, onClose,
}: {
  runId: string;
  agentId: string;
  progress: EvalProgress | null;
  summary: EvalSummary | null;
  onClose?: () => void;
}): JSX.Element {
  const { t } = useTranslation('evals');
  const f = useFormat();
  const navigate = useNavigate();
  const status = progress?.status ?? (summary ? 'completed' : 'running');
  const live = !isTerminalStatus(status);
  const rows = useMemo(() => buildTaskRows(progress?.progress, summary), [progress, summary]);
  const pct = (x: number | undefined): string => (x === undefined ? '—' : f.percent(x, { maximumFractionDigits: 0 }));
  const score = (x: number | undefined): string => (x === undefined ? '—' : f.number(x, { maximumFractionDigits: 2 }));

  const figures: KeyFigureItem[] = summary ? [
    { key: 'score', label: t('aeFigScore'), value: score(summary.aggregateScore) },
    { key: 'tasks', label: t('aeFigTasks'), value: t('aeOfCount', { passed: summary.passedCount, total: summary.taskCount }), ...(summary.passed ? {} : { tone: 'attention' as const }) },
    ...(summary.trialStats ? [
      { key: 'passAtK', label: t('aeFigPassAtK', { k: summary.trialStats.k }), value: pct(summary.trialStats.passAtK), sub: t('aeFigPassAtKSub', { count: summary.trialStats.k }) },
      { key: 'passHatK', label: t('aeFigPassHatK', { k: summary.trialStats.k }), value: pct(summary.trialStats.passHatK), sub: t('aeFigPassHatKSub', { count: summary.trialStats.k }) },
    ] : []),
    ...(summary.totalCostUsd !== undefined ? [{ key: 'cost', label: t('aeFigCost'), value: f.usd(summary.totalCostUsd) }] : []),
  ] : [];

  const columns: DataColumn<TaskRow>[] = [
    { key: 'task', header: t('aeColTask'), rowHeader: true, render: (r) => <code dir="ltr">{r.taskId}</code> },
    { key: 'result', header: t('aeColResult'), render: (r) => <PassChip passed={r.passed} /> },
    { key: 'score', header: t('aeColScore'), align: 'right', cellClassName: 'u-tabular', render: (r) => score(r.score) },
    {
      key: 'trials', header: t('aeColTrials'), render: (r) => (
        <div className="u-flex u-flex-col u-gap-1">
          <TrialStrip row={r} t={t} />
          {r.trialN !== undefined && r.trialN > 1 && r.passAtK !== undefined && r.passHatK !== undefined ? (
            <span className="muted u-fs-12 u-tabular">{t('aePassKLine', { at: pct(r.passAtK), hat: pct(r.passHatK) })}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'trajectory', header: t('aeColTrajectory'), render: (r) => r.trajectory ? (
        <div className="u-flex u-flex-col u-gap-1">
          <span className="u-tabular">{t('aeTrajectoryMatched', { matched: r.trajectory.matchedCount, expected: r.trajectory.expectedCount })}</span>
          {r.trajectory.forbiddenCount > 0
            ? <span className="chip chip--danger">{t('aeForbiddenCalls', { count: r.trajectory.forbiddenCount })}</span>
            : null}
        </div>
      ) : <span className="muted">—</span>,
    },
    {
      key: 'misses',
      header: <span className="u-iflex u-items-center u-gap-1">{t('aeColFixtureMisses')} <InfoTip label={t('aeFixtureMissesInfoLabel')} text={t('aeFixtureMissesInfo')} /></span>,
      align: 'right', render: (r) => r.fixtureMisses === undefined ? '—' : (
        r.fixtureMisses > 0 ? <span className="chip chip--warning u-tabular">{t('aeFixtureMisses', { count: r.fixtureMisses })}</span> : <span className="u-tabular">{f.number(0)}</span>
      ),
    },
    { key: 'cost', header: t('aeColCost'), align: 'right', cellClassName: 'u-tabular', render: (r) => (r.costUsd === undefined ? '—' : f.usd(r.costUsd)) },
    { key: 'latency', header: t('aeColLatency'), align: 'right', cellClassName: 'u-tabular', render: (r) => (r.latencyMs === undefined ? '—' : f.durationMs(r.latencyMs)) },
    {
      key: 'detail', header: t('aeColDetail'), render: (r) => r.details.length ? (
        <details>
          <summary className="u-cursor-pointer u-fs-12">{t('aeJudgeDetail')}</summary>
          <ul className="u-list-plain u-mt-1 u-fs-12">
            {r.details.map((d, i) => <li key={i} className="u-prewrap">{d}</li>)}
          </ul>
        </details>
      ) : <span className="muted">—</span>,
    },
  ];

  const failed = status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired';
  const err = progress?.error;
  const suiteRef = progress?.suiteRef ?? (summary ? `${summary.suiteId}@${summary.suiteVersion}` : undefined);

  // EVUX-4 — the evaluated agent has no tool to read its own eval results; the
  // Agent Author does. Stage a draft naming this run, then open the ONE chat.
  const askWhy = (): void => {
    stageComposerDraft(t('aeAskDraft', { runId, suite: suiteRef ?? '', agentId }));
    navigate(`/chat?agent=${encodeURIComponent(AGENT_AUTHOR_AGENT_ID)}`);
  };

  // No aria-busy on the section (EVUX-15): it would hide the whole scorecard
  // from a screen reader for the entire run. The outcome is announced on settle.
  return (
    <section className="surface-card" aria-labelledby={`ae-scorecard-${runId}`}>
      <div className="u-flex u-items-center u-justify-between u-gap-3 u-wrap">
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <h2 id={`ae-scorecard-${runId}`} tabIndex={-1} className="u-m-0 u-fs-16" dir={suiteRef ? 'ltr' : undefined}>{suiteRef ?? t('aeScorecard')}</h2>
          {summary ? <PassChip passed={summary.passed} /> : live ? <span className="chip chip--muted chip--pulse"><ClockIcon size={12} />{t('aeRunning')}</span> : null}
          {summary?.regression ? <RegressionChip regression={summary.regression} reason={progress?.regressionReason} /> : null}
        </div>
        <div className="action-bar">
          <Link className="btn-link u-fs-13" to={`/runs/${encodeURIComponent(runId)}`}>
            <ArrowRightIcon size={14} /> {t('aeOpenRun')}
          </Link>
          {(summary && !summary.passed) || failed ? (
            <Button variant="link" className="u-fs-13" onClick={askWhy} title={t('aeAskAgentTitle')}>
              <MessageSquareIcon size={14} /> {t('aeAskAgent')}
            </Button>
          ) : null}
          {onClose ? <Button variant="quiet" size="sm" onClick={onClose}>{t('aeCloseScorecard')}</Button> : null}
        </div>
      </div>

      {inconclusiveReason(t, summary?.regression, progress?.regressionReason)
        ? <p className="muted u-fs-13 u-m-0">{inconclusiveReason(t, summary?.regression, progress?.regressionReason)}</p> : null}

      {live ? <p className="muted u-fs-13 u-m-0">{t('aeLiveHint', { count: rows.filter((r) => r.trials.length > 0).length })}</p> : null}

      {failed ? (
        <Notice variant="error" announce={t('aeRunFailed')}>
          <strong>{t(status === 'failed' ? 'aeRunFailed' : status === 'expired' ? 'aeRunExpired' : 'aeRunCancelled')}</strong>
          {status === 'failed' ? <> {runErrorMessage(t, err?.code)}</> : null}
          {err?.code || err?.message ? (
            <details className="u-mt-1">
              <summary className="u-cursor-pointer u-fs-12">{t('aeTechnicalDetails')}</summary>
              <p className="u-fs-12 u-m-0 u-mt-1" dir="ltr">{err.code ? <code>{err.code}</code> : null} {err.message ?? ''}</p>
            </details>
          ) : null}
        </Notice>
      ) : null}

      {figures.length ? <KeyFigureBand figures={figures} ariaLabel={t('aeFiguresLabel')} /> : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.taskId}
        caption={t('aeTasksCaption')}
        density="compact"
        stack
        empty={<p className="muted u-fs-13">{live ? t('aeNoTasksYet') : t('aeNoTasks')}</p>}
      />
    </section>
  );
}
