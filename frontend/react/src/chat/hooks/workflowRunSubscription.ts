/**
 * Workflow-run SSE handler. Extracted VERBATIM from `useChatSession.ts`'s
 * inline `subscribeToRun(...)` subscription inside `runWorkflowMention` so
 * the ~195-line event handler lives in one testable module instead of inside
 * the `runWorkflowMention` callback.
 *
 * `makeWorkflowRunHandlers(ctx)` returns the `SubscribeOptions` handlers
 * (`onEvent` / `onError` / `onTimeout`) minus `modes`; `runWorkflowMention`
 * spreads them into
 * `subscribeToRun(runId, { modes: ['updates'], ...makeWorkflowRunHandlers(ctx) })`.
 *
 * The `updateWorkflowRun` / `closeWorkflowSub` helpers are passed in via `ctx`
 * (they are ALSO used by `cancelWorkflowRun`, so they stay defined in the hook).
 */

import type React from 'react';
import type { RunEventDoc } from '@openwop/openwop';
import { listOpenInterrupts, type OpenInterrupt } from '../../client/interruptsClient.js';
import type { SubscribeOptions } from '../../client/streamsClient.js';
import { isRecord } from '../lib/typeGuards.js';
import type { ChatMessage, ChatSession, WorkflowRunState } from '../types.js';

/** Dependencies the workflow-run SSE handler closes over. Threaded through
 *  instead of capturing the whole `session` so the handler can live outside
 *  the hook. Values (`runId`, `runMsgId`, `sessionId`, `sessionTitle`) are
 *  snapshotted per dispatch; setters + helpers are stable. The
 *  `updateWorkflowRun` / `closeWorkflowSub` helpers are owned by the hook
 *  (also used by `cancelWorkflowRun`) and passed in here. */
export interface WorkflowRunHandlerContext {
  runId: string;
  runMsgId: string;
  setSession: React.Dispatch<React.SetStateAction<ChatSession>>;
  persistMessage: (sessionId: string, title: string, msg: ChatMessage) => Promise<void>;
  sessionId: string;
  sessionTitle: string;
  updateWorkflowRun: (
    messageId: string,
    patch: (prev: WorkflowRunState) => WorkflowRunState,
  ) => void;
  closeWorkflowSub: (messageId: string) => void;
}

/** Build the workflow-run SSE handlers. Returns the `SubscribeOptions`
 *  handlers (minus `modes`) so the caller can do
 *  `subscribeToRun(runId, { modes: ['updates'], ...makeWorkflowRunHandlers(ctx) })`. */
export function makeWorkflowRunHandlers(
  ctx: WorkflowRunHandlerContext,
): Pick<SubscribeOptions, 'onEvent' | 'onError' | 'onTimeout'> {
  const {
    runId,
    runMsgId,
    setSession,
    persistMessage,
    sessionId,
    sessionTitle,
    updateWorkflowRun,
    closeWorkflowSub,
  } = ctx;
  return {
    onEvent: async (ev: RunEventDoc) => {
      const payload = (ev.payload as Record<string, unknown>) ?? {};
      const nodeId = ev.nodeId ?? (typeof payload.nodeId === 'string' ? payload.nodeId : undefined);

      if (ev.type === 'node.started' && nodeId) {
        updateWorkflowRun(runMsgId, (prev) => {
          const running = prev.runningNodeIds ?? [];
          return {
            ...prev,
            currentNodeName: prev.nodeNames[nodeId] ?? nodeId,
            runningNodeIds: running.includes(nodeId) ? running : [...running, nodeId],
          };
        });
      } else if (ev.type === 'node.completed' && nodeId) {
        // Capture the node's outputs so the bubble can render them
        // inline. The arbiter approval card needs to see what the
        // three upstream critics produced; without this they'd be
        // discarded.
        const outputs = (payload.outputs && typeof payload.outputs === 'object')
          ? payload.outputs
          : undefined;
        updateWorkflowRun(runMsgId, (prev) => {
          if (prev.completedNodeIds.includes(nodeId)) return prev;
          const running = (prev.runningNodeIds ?? []).filter((id) => id !== nodeId);
          return {
            ...prev,
            completedNodeIds: [...prev.completedNodeIds, nodeId],
            runningNodeIds: running,
            ...(outputs ? { nodeOutputs: { ...prev.nodeOutputs, [nodeId]: outputs } } : {}),
          };
        });
      } else if (ev.type === 'node.failed' && nodeId) {
        // The executor may keep running other branches on failure
        // (error-routing trigger rules). Track failed nodes so the
        // progress bar accounts for them and clear `currentNodeName`
        // so the UI doesn't claim a failed node is still "running".
        updateWorkflowRun(runMsgId, (prev) => (
          prev.failedNodeIds.includes(nodeId)
            ? prev
            : {
                ...prev,
                failedNodeIds: [...prev.failedNodeIds, nodeId],
                runningNodeIds: (prev.runningNodeIds ?? []).filter((id) => id !== nodeId),
                currentNodeName: prev.currentNodeName === (prev.nodeNames[nodeId] ?? nodeId)
                  ? null
                  : prev.currentNodeName,
              }
        ));
      } else if (ev.type === 'node.suspended') {
        // Best-effort fetch with one retry — the event emission and
        // interrupt-row commit are sequential server-side but the
        // FE's GET sometimes lands before the row is visible to the
        // read path under load. Without the retry the approval card
        // silently never appears.
        let active: OpenInterrupt | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const open = await listOpenInterrupts(runId);
            active = open[open.length - 1] ?? null;
            if (active) break;
          } catch { /* try again */ }
          if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
        }
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => m.id === runMsgId ? { ...m, activeInterrupt: active } : m),
        }));
        // Track in WorkflowRunState.interruptHistory so the persistent
        // decision card has the `kind` + opened-at after resolution —
        // `activeInterrupt` flips to null at resolve time and would
        // otherwise lose the history.
        // Drop the suspended node from the "actively running" set so
        // its row renders the ⏸ paused chip instead of a spinner —
        // the StepList already special-cases suspended via
        // `activeInterrupt.nodeId`, but `runningNodeIds` needs to
        // agree or both states fight each other on the same row.
        if (nodeId) {
          updateWorkflowRun(runMsgId, (prev) => {
            const running = prev.runningNodeIds ?? [];
            if (!running.includes(nodeId)) return prev;
            return { ...prev, runningNodeIds: running.filter((id) => id !== nodeId) };
          });
        }
        if (active && nodeId) {
          const openedAt = active.createdAt;
          const kind = active.kind;
          const interruptId = active.interruptId;
          updateWorkflowRun(runMsgId, (prev) => {
            const history = prev.interruptHistory ?? [];
            if (history.some((h) => h.interruptId === interruptId)) return prev;
            return {
              ...prev,
              interruptHistory: [...history, { interruptId, nodeId, kind, openedAt }],
            };
          });
        }
      } else if (ev.type === 'node.interrupt.resolved') {
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => m.id === runMsgId ? { ...m, activeInterrupt: null } : m),
        }));
        // Close out the matching entry in interruptHistory.
        // resumeValue lands in nodeOutputs via the `node.completed`
        // event that fires alongside this one (see executor.ts:780);
        // pick it up so the decision card renders the chosen option.
        const resolvedNode = nodeId;
        const resolvedAt = ev.timestamp ?? new Date().toISOString();
        if (resolvedNode) {
          updateWorkflowRun(runMsgId, (prev) => {
            const history = prev.interruptHistory ?? [];
            const idx = history.findIndex(
              (h) => h.nodeId === resolvedNode && !h.resolvedAt,
            );
            if (idx === -1) return prev;
            // The executor wraps the user's resumeValue as
            // `{output: <resumeValue>}` when writing the node.completed
            // event (see executor.ts:780). Unwrap it back so the
            // HitlDecisionCard sees the raw shape the ApprovalCard
            // emitted (`{action, content, selectedKey, comment}`).
            const nodeOutput = prev.nodeOutputs[resolvedNode];
            const resumeValue = isRecord(nodeOutput) && 'output' in nodeOutput
              ? nodeOutput.output
              : nodeOutput;
            const next = history.slice();
            next[idx] = { ...next[idx]!, resolvedAt, resumeValue };
            return { ...prev, interruptHistory: next };
          });
        }
      } else if (ev.type === 'run.completed') {
        const outputs = (payload.outputs as Record<string, unknown>) ?? undefined;
        // Inline setSession (rather than updateWorkflowRun) so we
        // can capture the finalized message and write it through to
        // the BE in the same step — without this, an @mention chat
        // session is never persisted and the history drawer keeps
        // showing "New chat — 0 messages" even after completion.
        let finalized: ChatMessage | null = null;
        setSession((s) => {
          const next = s.messages.map((m) => {
            if (m.id !== runMsgId || !m.workflowRun) return m;
            const updated: ChatMessage = {
              ...m,
              workflowRun: {
                ...m.workflowRun,
                status: 'completed',
                ...(outputs ? { outputs } : {}),
              },
            };
            finalized = updated;
            return updated;
          });
          return { ...s, messages: next };
        });
        if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
        closeWorkflowSub(runMsgId);
      } else if (ev.type === 'run.failed') {
        const err = (payload.error as Record<string, string>) ?? { code: 'unknown', message: 'unknown failure' };
        let finalized: ChatMessage | null = null;
        setSession((s) => {
          const next = s.messages.map((m) => {
            if (m.id !== runMsgId || !m.workflowRun) return m;
            const updated: ChatMessage = {
              ...m,
              workflowRun: {
                ...m.workflowRun,
                status: 'failed',
                error: { code: err.code ?? 'unknown', message: err.message ?? 'unknown failure' },
              },
            };
            finalized = updated;
            return updated;
          });
          return { ...s, messages: next };
        });
        if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
        closeWorkflowSub(runMsgId);
      } else if (ev.type === 'run.cancelled') {
        let finalized: ChatMessage | null = null;
        setSession((s) => {
          const next = s.messages.map((m) => {
            if (m.id !== runMsgId || !m.workflowRun) return m;
            const updated: ChatMessage = {
              ...m,
              workflowRun: { ...m.workflowRun, status: 'cancelled' },
            };
            finalized = updated;
            return updated;
          });
          return { ...s, messages: next };
        });
        if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
        closeWorkflowSub(runMsgId);
      }
    },
    onError: () => { /* SSE drops don't tear down the bubble */ },
    onTimeout: () => { /* idle timeout — leave bubble as-is */ },
  };
}
