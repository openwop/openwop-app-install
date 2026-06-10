/**
 * Per-node step list with click-to-expand outputs. Each completed node
 * whose run captured an `outputs` payload becomes inspectable inline
 * so the user can read what each upstream step produced before making
 * an HITL approval decision.
 *
 * Extracted from `WorkflowRunBubble` so both the slim chat bubble and
 * the right-side `WorkflowProgressPanel` can render the same list shape
 * — only the panel actually mounts it; the bubble keeps a one-liner.
 */

import { useState } from 'react';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleIcon, PauseIcon, XIcon } from '../../ui/icons/index.js';
import type { ChatMessage, WorkflowRunState } from '../hooks/useChatSession.js';

export const STATUS_COLORS: Record<WorkflowRunState['status'], string> = {
  pending: 'var(--color-text-muted)',
  running: 'var(--color-accent)',
  completed: 'var(--color-success)',
  failed: 'var(--color-danger)',
  cancelled: 'var(--color-warning)',
};

export const STATUS_LABELS: Record<WorkflowRunState['status'], string> = {
  pending: 'Starting…',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

interface Props {
  run: WorkflowRunState;
  message: ChatMessage;
}

export function StepList({ run, message }: Props): JSX.Element {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  const completedSet = new Set(run.completedNodeIds);
  const failedSet = new Set(run.failedNodeIds);
  // Per-node "running" affordance. A node is actively running when the
  // executor has emitted `node.started` for it and not yet
  // completed / failed / suspended it. `runningNodeIds` is the
  // authoritative source; legacy persisted runs predate the field, so
  // we fall back to a `currentNodeName` match (one spinner at a time,
  // matching the pre-spinner behaviour).
  //
  // Gate on a live run status — once the run is in a terminal state
  // (completed / failed / cancelled), no node is "still running" even
  // if cancellation raced ahead of the per-node cleanup events.
  const runIsLive = run.status === 'running' || run.status === 'pending';
  const runningSet = new Set(
    runIsLive
      ? (run.runningNodeIds ?? [])
      : [],
  );
  return (
    <ul className="steplist-list">
      {Object.entries(run.nodeNames).map(([nodeId, friendlyName], idx) => {
        const isCompleted = completedSet.has(nodeId);
        const isFailed = failedSet.has(nodeId);
        const isSuspended = message.activeInterrupt?.nodeId === nodeId;
        // `runningNodeIds` is the new authoritative source (set by
        // node.started / cleared by node.completed/failed/suspended);
        // the `currentNodeName` fallback keeps legacy persisted runs
        // (no runningNodeIds field) showing the same single-spinner
        // behaviour they had before this field was added.
        const isRunning = !isCompleted && !isFailed && !isSuspended && (
          run.runningNodeIds === undefined
            ? run.currentNodeName === friendlyName && runIsLive
            : runningSet.has(nodeId)
        );
        const isPending = !isCompleted && !isFailed && !isSuspended && !isRunning;
        const outputs = run.nodeOutputs?.[nodeId];
        const hasOutputs = outputs !== undefined && outputs !== null
          && (typeof outputs !== 'object' || Object.keys(outputs).length > 0);
        const isExpanded = expandedNodeId === nodeId;

        const stateChip: { icon: JSX.Element; color: string } = isCompleted
          ? { icon: <CheckIcon size={13} />, color: STATUS_COLORS.completed }
          : isFailed ? { icon: <XIcon size={13} />, color: STATUS_COLORS.failed }
          : isSuspended ? { icon: <PauseIcon size={13} />, color: STATUS_COLORS.running }
          : isRunning ? { icon: <StepSpinner />, color: STATUS_COLORS.running }
          : { icon: <CircleIcon size={13} />, color: 'var(--ink-3)' };

        // A11y wiring for the disclosure pattern. Screen readers
        // announce the row as a button + report its expanded state +
        // point at the panel that materializes when expanded. The
        // panel id ties row → `<pre>` so AT navigation works.
        const panelId = `step-output-${nodeId}`;
        return (
          <li key={nodeId}>
            <div
              role={hasOutputs ? 'button' : undefined}
              tabIndex={hasOutputs ? 0 : -1}
              aria-expanded={hasOutputs ? isExpanded : undefined}
              aria-controls={hasOutputs ? panelId : undefined}
              onClick={hasOutputs ? () => setExpandedNodeId(isExpanded ? null : nodeId) : undefined}
              onKeyDown={hasOutputs ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpandedNodeId(isExpanded ? null : nodeId);
                }
              } : undefined}
              className="steplist-row"
              style={{
                opacity: isPending ? 0.55 : 1,
                fontWeight: isRunning || isSuspended ? 600 : 400,
                cursor: hasOutputs ? 'pointer' : 'default',
              }}
            >
              <span className="steplist-icon" style={{
                color: stateChip.color,
              }} aria-hidden>
                {stateChip.icon}
              </span>
              <span className="steplist-idx">
                {String(idx + 1).padStart(2, ' ')}
              </span>
              <span className="u-flex-1 u-minw-0 u-truncate">
                {friendlyName}
              </span>
              {hasOutputs && (
                <span className="steplist-output-link">
                  <span className="steplist-output-link-inner">
                    {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    {isExpanded ? 'hide' : 'view output'}
                  </span>
                </span>
              )}
              {isSuspended && (
                <span className="steplist-suspended">
                  Awaiting your input ↓
                </span>
              )}
              {isRunning && (
                <span className="steplist-running" style={{ color: STATUS_COLORS.running }} aria-hidden>
                  Running…
                </span>
              )}
            </div>
            {isExpanded && hasOutputs && (
              <pre id={panelId} className="steplist-output-pre">
                {formatOutputs(outputs)}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Tiny rotating arc rendered in the icon column when a node is
 *  actively running. Replaces the empty ○ for that row so users can
 *  tell at a glance which steps are "in flight in the background" vs
 *  "not yet reached". Inherits its hue from the parent's `color`
 *  (set to `STATUS_COLORS.running` on the chip wrapper) so theme +
 *  status colour follow the rest of the panel. Honours
 *  `prefers-reduced-motion` via the `openwop-spinner-rotate` keyframe
 *  rule (the keyframe + reduced-motion gate live in
 *  `styles/global.css`, alongside `openwop-pulse`). */
function StepSpinner(): JSX.Element {
  return (
    <span
      aria-hidden
      className="steplist-spinner"
    />
  );
}

/** Friendly render of a node output. If outputs has a single string-
 *  valued field (the common "text" / "completion" case), show that
 *  string raw. Otherwise pretty-print the whole object as JSON. */
export function formatOutputs(outputs: unknown): string {
  if (typeof outputs !== 'object' || outputs === null) {
    return String(outputs);
  }
  const rec = outputs as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 1) {
    const only = rec[keys[0]!];
    if (typeof only === 'string') return only;
  }
  try {
    return JSON.stringify(rec, null, 2);
  } catch {
    return String(rec);
  }
}
