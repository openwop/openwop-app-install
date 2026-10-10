/**
 * Workflow-run chat bubble — slim one-liner version.
 *
 * The full progress UI (step list, progress bar, per-node outputs,
 * active-interrupt approval card) now lives in the right-side
 * `WorkflowProgressPanel`. The bubble carries just enough to anchor
 * the run in the chat thread:
 *   ── workflow name + status pill + progress hint
 *   ── "View progress →" link that opens the panel + focuses this run
 *   ── footer (slug, runId, builder link, elapsed)
 *
 * Rendered for any `workflow_run` ChatMessage — the `@mention` direct-dispatch
 * path (`useChatSession.runWorkflowMention`) AND a run an agent TOOL ignited
 * mid-turn, which arrives as a `workflow_run` conversation turn and is projected
 * by `turnsToBubbles` (ADR 0491). A tool-dispatched run has no `/slug` behind it,
 * so the footer's slug element and its separator are conditional.
 */

import { useTranslation } from 'react-i18next';
import { isOwnedWorkflow } from './lib/workflowMentions.js';
import { Link } from 'react-router-dom';
import { runDetailPath, useCanOpenRunDetail } from './runDetailAccess.js';
import { STATUS_COLORS, STATUS_LABEL_KEYS } from './workflowProgress/StepList.js';
import { formatElapsed } from './workflowProgress/formatters.js';
import { formatNumber } from '../i18n/format.js';
import { Notice } from '../ui/Notice.js';
import type { ChatMessage } from './hooks/useChatSession.js';

interface Props {
  message: ChatMessage;
  /** Open the progress panel + focus this bubble's run. When omitted
   *  (e.g., tests / passive renders) the bubble shows the link as
   *  inert text. */
  onOpenProgress?: (messageId: string) => void;
  /** True when this bubble's run is the one currently focused in the
   *  panel — flips the link copy so the user sees "Showing in panel"
   *  instead of "View progress" in that state. */
  isFocusedInPanel?: boolean;
}

type StepSegment = 'done' | 'failed' | 'waiting' | 'active' | 'todo';

/** Above this many steps the bar stops being readable as segments, so the
 *  bubble keeps only the "n/total" hint. */
const MAX_STEP_SEGMENTS = 12;

/** ADR 0768 follow-up C3 — one segment per step. The bubble knows COUNTS, not
 *  the graph order, so the bar fills left to right by count: done, failed, then
 *  the one step in hand (dashed when it is waiting on the user), then the rest. */
export function stepSegments(run: NonNullable<ChatMessage['workflowRun']>, isSuspended: boolean): StepSegment[] {
  const total = run.totalNodes;
  if (total <= 0 || total > MAX_STEP_SEGMENTS) return [];
  const done = Math.min(run.completedNodeIds.length, total);
  const failed = Math.min(run.failedNodeIds.length, total - done);
  const inHand = (run.status === 'running' || run.status === 'pending') && done + failed < total ? 1 : 0;
  const out: StepSegment[] = [];
  for (let i = 0; i < done; i += 1) out.push('done');
  for (let i = 0; i < failed; i += 1) out.push('failed');
  if (inHand) out.push(isSuspended ? 'waiting' : 'active');
  while (out.length < total) out.push('todo');
  return out;
}

/** The step bar alone — the bubble renders it, and the design-system gallery
 *  renders it from fixtures so it can be looked at without a live run. */
export function RunStepBar({ run, waiting }: { run: NonNullable<ChatMessage['workflowRun']>; waiting: boolean }): JSX.Element | null {
  const { t } = useTranslation('chat');
  const segments = stepSegments(run, waiting);
  if (segments.length === 0) return null;
  const done = Math.min(run.completedNodeIds.length, run.totalNodes);
  return (
    <div
      className="wfrunbubble-steps"
      role="img"
      aria-label={t('runStepBarAria', { done: formatNumber(done), total: formatNumber(run.totalNodes) })}
    >
      {segments.map((kind, i) => (
        <span key={i} className={`wfrunbubble-step wfrunbubble-step--${kind}`} />
      ))}
    </div>
  );
}

export function WorkflowRunBubble({ message, onOpenProgress, isFocusedInPanel }: Props): JSX.Element | null {
  const { t } = useTranslation('chat');
  const canOpenRun = useCanOpenRunDetail();
  const run = message.workflowRun;
  if (!run) return null;

  const completed = run.completedNodeIds.length;
  const total = run.totalNodes;
  const progressHint = total > 0
    ? `${formatNumber(completed)}/${formatNumber(total)}`
    : t('steps', { count: completed });
  const isSuspended = (message.activeInterrupts?.length ?? 0) > 0;

  return (
    <div className="u-flex u-justify-start u-mb-3">
      <div
        className={run.status === 'running' ? 'workflow-run-bubble workflow-run-bubble--live wfrunbubble-box' : 'workflow-run-bubble wfrunbubble-box'}
      >
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <span className="wfrunbubble-status-pill" style={{
            color: STATUS_COLORS[run.status],
            border: `1px solid ${STATUS_COLORS[run.status]}`,
            // Lands like a stamp when the run reaches a terminal state (§6).
            ...(run.status === 'completed' || run.status === 'failed'
              ? { animation: 'openwop-stamp-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) 1' }
              : {}),
          }}>
            {t(STATUS_LABEL_KEYS[run.status])}
          </span>
          {/* DESIGN.md §4.5 rule 17 — status leads the row, the name follows. */}
          <span className="u-fw-600 u-text-sm">{run.workflowName}</span>
          <span className="muted u-fs-11">{progressHint}</span>
          {isSuspended && (
            <span className="wfrunbubble-awaiting">
              {t('awaitingYourInput')}
            </span>
          )}
          <span className="u-ml-auto">
            {onOpenProgress ? (
              <button
                type="button"
                onClick={() => onOpenProgress(message.id)}
                className="wfrunbubble-progress-link"
                aria-pressed={isFocusedInPanel}
                title={isFocusedInPanel ? t('alreadyShowingInPanel') : t('openProgressPanel')}
              >
                {isFocusedInPanel ? t('showingInPanel') : t('viewProgress')}
              </button>
            ) : null /* ADR 0764 (CHATWF-9) — a surface with no progress panel (the
                 embedded chat, a plain tab) used to render "View progress →" as
                 inert text that looked like a link and did nothing. */}
          </span>
        </div>

        <RunStepBar run={run} waiting={isSuspended} />

        <div className="muted u-mt-1 u-fs-11 u-o-75 u-flex u-wrap u-gap-1-5 u-items-baseline">
          {run.slug && <code>/{run.slug}</code>}
          {run.runId && !run.runUnavailable && (
            <>
              {run.slug && <span>·</span>}
              {canOpenRun ? (
                <Link to={runDetailPath(run.runId)} title={t('openRunDetail')}>
                  {t('runIdShort', { id: run.runId.slice(0, 12) })}
                </Link>
              ) : <span>{t('runIdShort', { id: run.runId.slice(0, 12) })}</span>}
            </>
          )}
          {run.runId && run.runUnavailable && (
            <>
              {run.slug && <span>·</span>}
              {/* Run record gone — render the id without a link + a
                  muted hint so the user understands why action buttons
                  below are disabled. */}
              <span title={t('runRecordUnavailableTitle')}>
                {t('runIdShort', { id: run.runId.slice(0, 12) })}
              </span>
            </>
          )}
          {isOwnedWorkflow(run.workflowId) && (
            <>
              <span>·</span>
              <Link to={`/builder/${run.workflowId}`} title={t('openWorkflowInBuilder')}>
                {t('openInBuilderLink')}
              </Link>
            </>
          )}
          <span>·</span>
          <span>{formatElapsed(run.startedAt)}</span>
        </div>

        {/* ADR 0491 — WHY a run failed belongs in the CHAT, not only in the
            progress rail. The bubble previously showed a bare red "Failed" pill,
            so a user whose run died (e.g. the Challenge Factory refusing demo
            research sources) had to open a second surface to learn anything —
            precisely the "the chat doesn't tell you the truth" gap this ADR
            closes. `<Notice variant="error">` also carries role="alert", so the
            terminal failure is ANNOUNCED rather than only rendered. */}
        {run.status === 'failed' && run.error && (
          <div className="u-mt-1-5">
            <Notice variant="error">
              {/* The message is the human part; the wire code is diagnostic, so it
                  trails as muted detail instead of leading the sentence. */}
              {run.error.message}
              <span className="muted u-fs-11 u-ml-1">({run.error.code})</span>
            </Notice>
          </div>
        )}

        {/* ADR 0764 D4 (CHATWF-6) — the two states that used to lie: a stream
            that gave up (bubble said "running" forever) and a cancel request that
            failed (bubble said the RUN failed). Warning, not error: neither is a
            fact about the run itself. */}
        {run.streamLost && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled' && (
          <div className="u-mt-1-5">
            <Notice variant="warning">
              {t('workflowStreamLost')}
              {run.runId && !run.runUnavailable && canOpenRun && (
                <> <Link to={runDetailPath(run.runId)}>{t('openRunDetail')}</Link></>
              )}
            </Notice>
          </div>
        )}
        {run.cancelError && run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled' && (
          <div className="u-mt-1-5">
            <Notice variant="warning">{t('workflowCancelFailed', { message: run.cancelError })}</Notice>
          </div>
        )}

        {run.runUnavailable && (
          <div
            className="muted u-mt-1-5 u-fs-11 u-italic"
            role="note"
          >
            {t('runRecordUnavailableNote')}
          </div>
        )}
      </div>
    </div>
  );
}
