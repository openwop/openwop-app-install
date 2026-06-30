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
import { pollEvents } from '../../client/runsClient.js';
import type { SubscribeOptions } from '../../client/streamsClient.js';
import { mergeOpenInterrupts, removeInterruptByNode } from '../lib/interruptResolution.js';
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
  /** UPSERT a chat message (append first, then update in place) — the run-backed
   *  `workflow_run` message is re-saved as its state evolves, so a suspended /
   *  still-running run survives reopen, not just the terminal snapshot. */
  persistMessage: (sessionId: string, title: string, msg: ChatMessage) => Promise<void>;
  sessionId: string;
  sessionTitle: string;
  updateWorkflowRun: (
    messageId: string,
    patch: (prev: WorkflowRunState) => WorkflowRunState,
  ) => void;
  closeWorkflowSub: (messageId: string) => void;
}

/** Outcome of a reconcile pass, consumed by the self-healing subscription
 *  in `useChatSession` to decide whether to re-subscribe.
 *    - `terminal`  — the run's terminal status if the log shows it ended,
 *      else null. Non-null ⇒ stop (reconcile already finalized + closed).
 *    - `polled`    — false when the event-log poll itself failed (backend
 *      unreachable / run gone). Lets the heal loop tell a merely-idle run
 *      (poll OK → keep healing) from a truly dead backend (poll fails →
 *      bound the retries) without an unbounded re-subscribe loop. */
export interface ReconcileResult {
  terminal: 'completed' | 'failed' | 'cancelled' | null;
  polled: boolean;
}

/** Backfill the workflow-run panel from the authoritative event log.
 *
 *  The live SSE stream is the primary path, but it can fall behind the
 *  truth in two ways the panel must survive:
 *    1. A reconnect resumes from `Last-Event-ID` (a sequence) — events the
 *       server buffered/batched across the gap are not all replayed, so a
 *       `node.completed` emitted during the gap can be silently skipped.
 *    2. A HITL run that sits suspended longer than the idle window loses
 *       its stream entirely (no reconnect after a timeout), so every
 *       post-resume event is dropped and the step list freezes.
 *
 *  This re-polls the FULL log and reconciles. Node-level state is
 *  UNION-merged (add-only): it can only ever ADD a completion/failure the
 *  stream missed, never remove one, so a poll that races a concurrent live
 *  SSE write can't clobber it. The open-interrupt set is refreshed from the
 *  authoritative read path (a dead stream otherwise strands the next gate's
 *  card or leaves a resolved one on screen), and the terminal status is
 *  finalized if the log shows the run ended but the stream never delivered
 *  the `run.*` event — guarded against the SSE branch having already done it,
 *  so it can't double-persist. Mirrors the RunDetailPage terminal/transition
 *  reconciliation. Best-effort: a poll failure is reported via `polled:false`
 *  and the live-stream state is left untouched. */
export async function reconcileWorkflowRunFromLog(
  ctx: WorkflowRunHandlerContext,
): Promise<ReconcileResult> {
  const {
    runId, runMsgId, setSession, persistMessage, sessionId, sessionTitle,
    updateWorkflowRun, closeWorkflowSub,
  } = ctx;

  let events: readonly RunEventDoc[];
  try {
    ({ events } = await pollEvents(runId, 0));
  } catch {
    return { terminal: null, polled: false }; // leave live-stream state as-is
  }

  // Derive the authoritative node-level + terminal state from the log.
  const completed: string[] = [];
  const failed: string[] = [];
  const outputs: Record<string, unknown> = {};
  let terminal: 'completed' | 'failed' | 'cancelled' | null = null;
  let runOutputs: Record<string, unknown> | undefined;
  let runError: { code: string; message: string } | undefined;
  for (const ev of events) {
    const payload = (ev.payload as Record<string, unknown>) ?? {};
    const nodeId = ev.nodeId ?? (typeof payload.nodeId === 'string' ? payload.nodeId : undefined);
    if (ev.type === 'node.completed' && nodeId) {
      if (!completed.includes(nodeId)) completed.push(nodeId);
      if (payload.outputs && typeof payload.outputs === 'object') {
        outputs[nodeId] = payload.outputs;
      }
    } else if (ev.type === 'node.failed' && nodeId) {
      if (!failed.includes(nodeId)) failed.push(nodeId);
    } else if (ev.type === 'run.completed') {
      terminal = 'completed';
      runOutputs = (payload.outputs as Record<string, unknown>) ?? undefined;
    } else if (ev.type === 'run.failed') {
      terminal = 'failed';
      const err = (payload.error as Record<string, string>) ?? {};
      runError = { code: err.code ?? 'unknown', message: err.message ?? 'unknown failure' };
    } else if (ev.type === 'run.cancelled') {
      terminal = 'cancelled';
    }
  }

  // Finalize the terminal status FIRST when the log shows the run ended but
  // the stream never delivered the run.* event (e.g. dead during a long HITL
  // wait). Done before the node/interrupt updates below so it is the FIRST
  // state update of this reconcile pass: React only invokes a setState updater
  // eagerly/synchronously when no updates are pending, so ordering it first is
  // what makes the `finalized` capture (→ persist) reliable on the standalone
  // timeout-heal path. On the SSE-triggered paths a prior update may already be
  // pending so the capture is skipped — but those handlers already persisted,
  // which is exactly the double-persist we want to avoid. The `status` patch
  // itself always applies (the updater runs on the next render regardless);
  // only the persist side-effect is best-effort. Closing the sub is
  // unconditional so cleanup never depends on the capture.
  if (terminal) {
    // Bind to a const so the narrowing survives into the closure below (a
    // captured `let` would re-widen to include null, forcing a `!` assertion).
    const terminalStatus = terminal;
    let finalized: ChatMessage | null = null;
    setSession((s) => {
      const next = s.messages.map((m) => {
        if (m.id !== runMsgId || !m.workflowRun) return m;
        if (m.workflowRun.status === terminalStatus) return m; // already applied
        const updated: ChatMessage = {
          ...m,
          workflowRun: {
            ...m.workflowRun,
            status: terminalStatus,
            ...(runOutputs ? { outputs: runOutputs } : {}),
            ...(runError ? { error: runError } : {}),
          },
        };
        finalized = updated;
        return updated;
      });
      return finalized ? { ...s, messages: next } : s;
    });
    if (finalized) void persistMessage(sessionId, sessionTitle, finalized);
    closeWorkflowSub(runMsgId);
  }

  // Union-merge node-level state (add-only → race-safe vs a live SSE write).
  updateWorkflowRun(runMsgId, (prev) => {
    const mergedCompleted = prev.completedNodeIds.slice();
    for (const id of completed) if (!mergedCompleted.includes(id)) mergedCompleted.push(id);
    const mergedFailed = prev.failedNodeIds.slice();
    for (const id of failed) if (!mergedFailed.includes(id)) mergedFailed.push(id);
    const settled = new Set([...mergedCompleted, ...mergedFailed]);
    const running = (prev.runningNodeIds ?? []).filter((id) => !settled.has(id));
    // Nothing new → return prev so React can skip the re-render.
    if (
      mergedCompleted.length === prev.completedNodeIds.length &&
      mergedFailed.length === prev.failedNodeIds.length &&
      running.length === (prev.runningNodeIds ?? []).length
    ) return prev;
    return {
      ...prev,
      completedNodeIds: mergedCompleted,
      failedNodeIds: mergedFailed,
      runningNodeIds: running,
      // Backfill missing outputs but let any live value win (it's freshest).
      nodeOutputs: { ...outputs, ...prev.nodeOutputs },
    };
  });

  // Refresh the open-interrupt set from the authoritative read path so a
  // gap can't strand the next gate's card (never surfaced) or leave a
  // resolved card on screen. Empty on a terminal run → clears all.
  try {
    const open = await listOpenInterrupts(runId);
    setSession((s) => ({
      ...s,
      messages: s.messages.map((m) => m.id === runMsgId
        ? { ...m, activeInterrupts: mergeOpenInterrupts([], open) }
        : m),
    }));
  } catch { /* leave interrupts as-is */ }

  return { terminal, polled: true };
}

/** Persist the CURRENT run-backed message snapshot (its evolving `workflowRun`
 *  state + open interrupt cards) via the ctx upsert. Reads the latest message via
 *  a read-only `setSession` (returns the same state → no re-render) so it captures
 *  every update applied earlier in this tick. Best-effort. Used at non-terminal
 *  milestones (suspend / interrupt resolved) so a reopened chat restores the full
 *  card — terminal events persist via their own finalize path. */
function persistRunMessageSnapshot(ctx: WorkflowRunHandlerContext): void {
  const { runMsgId, setSession, persistMessage, sessionId, sessionTitle } = ctx;
  // Read + persist INSIDE the updater so we capture the message AFTER every state
  // change applied earlier this tick (reading via a let-then-check outside races
  // the updater, which runs during React's flush). Returns the same state (no
  // re-render); the upsert is idempotent so a StrictMode double-invoke is harmless.
  setSession((s) => {
    const snap = s.messages.find((m) => m.id === runMsgId);
    if (snap) void persistMessage(sessionId, sessionTitle, snap);
    return s;
  });
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
        //
        // A workflow with parallel branches can have SEVERAL interrupts
        // open at once (e.g. legal + brand + risk gates fan out
        // together). Store the FULL open set — not just the last one —
        // so every gate gets its own card; resolving one must not
        // strand the rest (the bug that left runs stuck at "Running").
        let open: readonly OpenInterrupt[] = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            open = await listOpenInterrupts(runId);
            if (open.length > 0) break;
          } catch { /* try again */ }
          if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
        }
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => m.id === runMsgId
            ? { ...m, activeInterrupts: mergeOpenInterrupts(m.activeInterrupts, open) }
            : m),
        }));
        // The freshly-suspended node's interrupt, for the history entry below.
        const active: OpenInterrupt | null = (nodeId && open.find((i) => i.nodeId === nodeId)) || open[open.length - 1] || null;
        // Track in WorkflowRunState.interruptHistory so the persistent
        // decision card has the `kind` + opened-at after resolution —
        // the open interrupt is cleared at resolve time and would
        // otherwise lose the history.
        // Drop the suspended node from the "actively running" set so
        // its row renders the ⏸ paused chip instead of a spinner —
        // the StepList already special-cases suspended via
        // `activeInterrupts`, but `runningNodeIds` needs to
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
        // Persist the SUSPENDED snapshot (node cards so far + the HITL interrupt
        // card) so reopening the chat restores it. A suspended run is NOT terminal,
        // and was previously never written — the whole card vanished on reopen.
        // `persistMessage` upserts, so this append/updates the run-backed message.
        persistRunMessageSnapshot(ctx);
      } else if (ev.type === 'node.interrupt.resolved') {
        // Clear ONLY the resolved node's interrupt — sibling gates from
        // a parallel fan-out stay open until each is individually
        // resolved. Nulling the whole set here was the stuck-run bug.
        const resolvedNode = nodeId;
        setSession((s) => ({
          ...s,
          messages: s.messages.map((m) => m.id === runMsgId
            ? { ...m, activeInterrupts: resolvedNode
                ? removeInterruptByNode(m.activeInterrupts, resolvedNode)
                : [] }
            : m),
        }));
        // Close out the matching entry in interruptHistory.
        // resumeValue lands in nodeOutputs via the `node.completed`
        // event that fires alongside this one (see executor.ts:780);
        // pick it up so the decision card renders the chosen option.
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
        // Persist the post-resolve snapshot (the decision card now carries the
        // chosen value) so a reopen shows the resolved gate, not a stale open one.
        persistRunMessageSnapshot(ctx);
        // Backfill from the authoritative log: the resume emits the gate's
        // node.completed (+ downstream nodes) which a reconnect gap or a
        // briefly-dropped stream can skip. Union-merge picks them up so the
        // step list keeps advancing past the approval.
        void reconcileWorkflowRunFromLog(ctx);
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
        // Final backfill: the run is done, so the log is now complete and
        // immutable — reconcile any node.completed the live stream skipped so
        // the step list shows the true N-of-N, not a frozen pre-suspend count.
        void reconcileWorkflowRunFromLog(ctx);
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
