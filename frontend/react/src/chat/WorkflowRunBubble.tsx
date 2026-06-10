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
 * Rendered when a `workflow_run` ChatMessage is dispatched via the
 * `@mention` direct-dispatch path (`useChatSession.runWorkflowMention`).
 */

import { Link } from 'react-router-dom';
import { STATUS_COLORS, STATUS_LABELS } from './workflowProgress/StepList.js';
import { formatElapsed } from './workflowProgress/formatters.js';
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

export function WorkflowRunBubble({ message, onOpenProgress, isFocusedInPanel }: Props): JSX.Element | null {
  const run = message.workflowRun;
  if (!run) return null;

  const completed = run.completedNodeIds.length;
  const total = run.totalNodes;
  const progressHint = total > 0
    ? `${completed}/${total}`
    : `${completed} step${completed === 1 ? '' : 's'}`;
  const isSuspended = !!message.activeInterrupt;

  return (
    <div className="u-flex u-justify-start u-mb-3">
      <div
        className={run.status === 'running' ? 'workflow-run-bubble workflow-run-bubble--live wfrunbubble-box' : 'workflow-run-bubble wfrunbubble-box'}
      >
        <div className="u-flex u-items-center u-gap-2 u-wrap">
          <span className="u-fw-600 u-fs-13">{run.workflowName}</span>
          <span className="wfrunbubble-status-pill" style={{
            color: STATUS_COLORS[run.status],
            border: `1px solid ${STATUS_COLORS[run.status]}`,
            // Lands like a stamp when the run reaches a terminal state (§6).
            ...(run.status === 'completed' || run.status === 'failed'
              ? { animation: 'openwop-stamp-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) 1' }
              : {}),
          }}>
            {STATUS_LABELS[run.status]}
          </span>
          <span className="muted u-fs-11">{progressHint}</span>
          {isSuspended && (
            <span className="wfrunbubble-awaiting">
              Awaiting your input
            </span>
          )}
          <span className="u-ml-auto">
            {onOpenProgress ? (
              <button
                type="button"
                onClick={() => onOpenProgress(message.id)}
                className="wfrunbubble-progress-link"
                aria-pressed={isFocusedInPanel}
                title={isFocusedInPanel ? 'Already showing in the side panel' : 'Open the progress panel'}
              >
                {isFocusedInPanel ? 'Showing in panel →' : 'View progress →'}
              </button>
            ) : (
              <span className="muted u-fs-12">View progress →</span>
            )}
          </span>
        </div>

        <div className="muted u-mt-1 u-fs-11 u-o-75 u-flex u-wrap u-gap-1-5 u-items-baseline">
          <code>/{run.slug}</code>
          {run.runId && !run.runUnavailable && (
            <>
              <span>·</span>
              <Link to={`/runs/${run.runId}`} title="Open run detail">
                run {run.runId.slice(0, 12)}
              </Link>
            </>
          )}
          {run.runId && run.runUnavailable && (
            <>
              <span>·</span>
              {/* Run record gone — render the id without a link + a
                  muted hint so the user understands why action buttons
                  below are disabled. */}
              <span title="Run record no longer available on the server">
                run {run.runId.slice(0, 12)}
              </span>
            </>
          )}
          {run.workflowId && run.workflowId.startsWith('wf_') && (
            <>
              <span>·</span>
              <Link to={`/builder/${run.workflowId}`} title="Open this workflow in the builder">
                open in builder →
              </Link>
            </>
          )}
          <span>·</span>
          <span>{formatElapsed(run.startedAt)}</span>
        </div>

        {run.runUnavailable && (
          <div
            className="muted u-mt-1-5 u-fs-11 u-italic"
            role="note"
          >
            Run record no longer available on the server — action links below
            are disabled. The decision + completion cards still render from
            local history.
          </div>
        )}
      </div>
    </div>
  );
}
