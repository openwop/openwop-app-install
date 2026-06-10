/**
 * Workflow-progress panel — rendered inside `LeftRail` as one of the
 * three tab panels. The rail owns width / border / mobile positioning;
 * this component fills whatever container it's given.
 *
 * Hosts:
 *   - Run switcher when the session has more than one `workflow_run`
 *     message. Selecting a row focuses that run.
 *   - Header: workflow name + status pill + "Step N of M — currentNode"
 *     + progress bar.
 *   - StepList (per-node check/pending/running/suspended icons with
 *     expandable outputs).
 *   - Active-interrupt POINTER chip — the actual `CardHost` (approval
 *     picker, clarification form, etc.) renders inline below the
 *     workflow_run bubble in `MessageFeed`. The panel only flags
 *     presence + directs the user to the chat so they don't have to
 *     swivel between two surfaces to respond. Layout decision:
 *     2026-05-25 (reverted from the 2026-05-24 split where the panel
 *     hosted the CardHost directly).
 *   - Outputs / error / footer (runId + builder link + elapsed).
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { StepList, STATUS_COLORS, STATUS_LABELS } from './StepList.js';
import { formatElapsed } from './formatters.js';
import type { ChatMessage } from '../hooks/useChatSession.js';
import { PauseIcon, XIcon } from '../../ui/icons/index.js';

/** Render-time humanization for the pointer-chip copy. Raw `kind`
 *  values are lowercase enum strings — the labels here read more
 *  naturally in a sentence like "see the {label} card". Unknown
 *  vendor kinds fall back to the raw value. */
const INTERRUPT_KIND_LABEL: Record<string, string> = {
  approval: 'approval',
  clarification: 'clarification',
  refinement: 'refinement',
  cancellation: 'cancellation',
};

interface Props {
  /** Every `workflow_run` message in the current session. Most-recent
   *  first ordering is the caller's responsibility. */
  workflowRunMessages: readonly ChatMessage[];
  /** Currently-focused workflow_run message id. When the session has
   *  >1 workflow_run messages the panel renders a run-switcher header. */
  focusedMessageId: string | null;
  /** Switch the focused run via the run-switcher. */
  onFocus: (messageId: string) => void;
  /** Close the panel (chevron or Esc). */
  onClose: () => void;
  /** Cancel an in-flight workflow_run. */
  onCancel: (messageId: string) => Promise<void>;
}

export function WorkflowProgressPanel({
  workflowRunMessages,
  focusedMessageId,
  onFocus,
  onClose,
  onCancel,
}: Props): JSX.Element {
  // Esc closes the panel — but ONLY when focus is inside it. A
  // global `window.keydown` would fight `ChatInput`'s own Esc handling
  // (cancel in-flight turn) and close the panel as a side-effect of
  // the user trying to abort their message. Binding via an onKeyDown
  // on the aside with tabIndex=-1 keeps the keypress properly scoped.
  // We deliberately DON'T auto-focus the close button on mount: the
  // panel rendering is gated on persisted `progressOpen=true`, so an
  // auto-focus would yank the user's focus on every page reload that
  // restores an open panel. Users who want Esc to work click anywhere
  // inside the panel first.

  const focused = useMemo(
    () => workflowRunMessages.find((m) => m.id === focusedMessageId) ?? workflowRunMessages[0] ?? null,
    [workflowRunMessages, focusedMessageId],
  );

  const headingId = 'workflow-progress-panel-heading';

  return (
    // The Escape-to-close handler below is intentionally scoped to this panel
    // (see the block comment above on not using a global window listener). The
    // <aside> is a focus-scoped container, not an interactive control, so the
    // noninteractive-interactions heuristic is a false positive here.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <aside
      className="workflow-progress-panel u-w-full u-h-full u-bg-surface u-flex u-flex-col"
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      aria-labelledby={headingId}
    >
      <header className="wfprog-header">
        <strong id={headingId} className="u-flex-1 u-fs-13">Workflow progress</strong>
        <button
          type="button"
          className="secondary wfprog-close-btn"
          onClick={onClose}
          aria-label="Close workflow progress"
        >
          <XIcon size={14} />
        </button>
      </header>

      {workflowRunMessages.length === 0 ? (
        <div className="muted u-p-4 u-fs-12">
          No workflow runs in this chat yet. Type <code>@</code> to dispatch one.
        </div>
      ) : (
        <>
          {workflowRunMessages.length > 1 && (
            <RunSwitcher
              messages={workflowRunMessages}
              focusedMessageId={focused?.id ?? null}
              onFocus={onFocus}
            />
          )}
          {focused && <FocusedRunView
            message={focused}
            onCancel={onCancel}
          />}
        </>
      )}
    </aside>
  );
}

function RunSwitcher({
  messages,
  focusedMessageId,
  onFocus,
}: {
  messages: readonly ChatMessage[];
  focusedMessageId: string | null;
  onFocus: (messageId: string) => void;
}): JSX.Element {
  return (
    <nav
      aria-label="Runs in this chat"
      className="wfprog-runswitcher"
    >
      <ul className="u-list-none u-m-0 u-p-0">
        {messages.map((m) => {
          const run = m.workflowRun;
          if (!run) return null;
          const isActive = m.id === focusedMessageId;
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onFocus(m.id)}
                className="wfprog-run-btn"
                style={{
                  background: isActive
                    ? 'color-mix(in oklch, var(--color-accent) 18%, transparent)'
                    : 'transparent',
                  borderLeft: isActive
                    ? '2px solid var(--color-accent)'
                    : '2px solid transparent',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                <span className="wfprog-run-dot" style={{
                  background: STATUS_COLORS[run.status],
                }} aria-hidden />
                <span className="u-flex-1 u-truncate">
                  {run.workflowName}
                </span>
                <span className="muted u-fs-10">
                  {STATUS_LABELS[run.status]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function FocusedRunView({
  message,
  onCancel,
}: {
  message: ChatMessage;
  onCancel: (messageId: string) => Promise<void>;
}): JSX.Element | null {
  const run = message.workflowRun;
  if (!run) return null;

  const completed = run.completedNodeIds.length;
  const total = run.totalNodes;
  const stepLabel = total > 0
    ? `Step ${Math.min(completed + 1, total)} of ${total}`
    : `${completed} step${completed === 1 ? '' : 's'} completed`;
  const progressPct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const isTerminal = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
  const showRunning = run.status === 'running' || run.status === 'pending';
  const canCancel = run.status === 'running' && !!run.runId;

  return (
    <div className="wfprog-focused">
      {/* Header */}
      <div>
        <div className="u-flex u-items-center u-gap-2 u-mb-1">
          <span className="wfprog-run-name">
            {run.workflowName}
          </span>
          <span className="wfprog-status-pill" style={{
            color: STATUS_COLORS[run.status],
            border: `1px solid ${STATUS_COLORS[run.status]}`,
          }}>
            {STATUS_LABELS[run.status]}
          </span>
          {canCancel && (
            <button
              type="button"
              className="secondary u-ml-auto u-fs-11 u-pad-2x10 u-minh-0"
              onClick={() => { void onCancel(message.id); }}
              title="Cancel this run"
            >
              Cancel
            </button>
          )}
        </div>

        {showRunning && (
          <>
            <div className="u-flex u-justify-between u-fs-12 u-mb-1">
              <span className="muted">
                {stepLabel}
                {run.currentNodeName && <> — <strong className="u-fw-600">{run.currentNodeName}</strong></>}
              </span>
              {total > 0 && <span className="muted">{progressPct}%</span>}
            </div>
            <div className="wfprog-bar">
              <div className="wfprog-bar-fill" style={{
                width: total > 0 ? `${progressPct}%` : '30%',
                background: STATUS_COLORS[run.status],
                animation: total === 0 ? 'openwop-pulse 1.2s ease-in-out infinite' : 'none',
              }} />
            </div>
          </>
        )}

        {isTerminal && total > 0 && (
          <div className="muted u-fs-12">
            {completed} of {total} step{total === 1 ? '' : 's'} completed
          </div>
        )}
      </div>

      {/* Active interrupt pointer — the actual approval / clarification
          card renders inline in the chat thread (MessageFeed below the
          workflow_run bubble). The panel is for *tracking* the run's
          shape, not for taking the action — splitting "see progress"
          from "respond to a prompt" would force the user to swivel
          between two surfaces every gate. Show a short pointer here
          so users who are watching the panel know where to look. */}
      {message.activeInterrupt && (
        <div className="wfprog-interrupt">
          <PauseIcon size={14} /> <span>Awaiting your input — see the {INTERRUPT_KIND_LABEL[message.activeInterrupt.kind] ?? message.activeInterrupt.kind} card in the chat ↑</span>
        </div>
      )}

      {/* Per-node step list */}
      {Object.keys(run.nodeNames).length > 0 && (
        <StepList run={run} message={message} />
      )}

      {/* Outputs (completed) */}
      {run.status === 'completed' && run.outputs && Object.keys(run.outputs).length > 0 && (
        <pre className="wfprog-outputs">
          {JSON.stringify(run.outputs, null, 2)}
        </pre>
      )}

      {/* Error */}
      {run.status === 'failed' && run.error && (
        <div className="wfprog-error">
          <strong>{run.error.code}:</strong> {run.error.message}
        </div>
      )}

      {/* Footer */}
      <div className="muted wfprog-footer">
        <code>/{run.slug}</code>
        {run.runId && (
          <>
            <span>·</span>
            <Link to={`/runs/${run.runId}`} title="Open run detail">
              run {run.runId.slice(0, 12)}
            </Link>
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
    </div>
  );
}

