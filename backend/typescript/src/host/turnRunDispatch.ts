/**
 * Turn-scoped run-dispatch surfacing — the ONE owner of "an agent tool ignited a
 * workflow run during a chat turn, so the conversation must SHOW that run".
 *
 * THE DEFECT THIS REPLACES (2026-07-25, KickTodo Challenge Factory incident).
 * Five features each hand-rolled the same `appendWorkflowRunTurn` helper
 * (campaign-brief, campaign-channels, campaign-orchestration, kicktodo-core,
 * kicktodo-creator), byte-identical but for a `nodeId` and a log message. Each
 * did: `loadTurns` → `nextIndex = max+1` → `persistExchangedPair`. That is a
 * SECOND turnIndex allocator running while `conversationExchange` already held
 * the first:
 *
 *   1. the exchange loads turns and reserves N (user) and N+1 (agent);
 *   2. it dispatches — the tool loop runs INSIDE that dispatch;
 *   3. the tool re-reads the log (the user turn is not persisted yet, dispatch
 *      is deliberately first) and computes the SAME index N;
 *   4. the tool writes `workflow_run` at N; the exchange then writes the user
 *      turn at N too.
 *
 * `loadTurns` folds with a bare `list.push` (no dedup), so both rows survive at
 * one index and the run bubble sorts against the user's own message. Worse, the
 * exchange's return value is `[...existing, userTurn, agentTurn]` where
 * `existing` was read BEFORE the tool ran — so the run turn was persisted but
 * absent from the response, invisible until a full page reload. The user saw an
 * agent promising "the run is active" beside an empty Workflow-progress rail.
 *
 * THE FIX: the exchange owns turn allocation and owns the response, so it owns
 * this. A tool RECORDS its dispatch on the scope; the exchange DRAINS the record
 * and materializes the turns itself — correct indices, one persist, and in the
 * returned `turns` so the bubble and the progress rail populate without a
 * reload. One allocator, one owner.
 *
 * Transports with no collector on the scope (the realtime voice bridge, the
 * host-driven `agentDispatch` loop) keep the out-of-band append via
 * `appendRunTurnDirect` — same behavior as before, but through one
 * implementation instead of five, and it no longer returns SILENTLY when the
 * conversation has no backing run (that miss is now logged, per the repo's
 * "failed read is never a silent empty" doctrine).
 *
 * @see conversationExchange.ts — the drain + materialize site
 * @see conversationToolLoop.ts — builds the collector onto the tool scope
 */

import type { Storage } from '../storage/storage.js';
import type { ConversationTurn } from './conversation.js';
import { makeTurn } from './conversation.js';
import { getConversationMeta } from './conversationStore.js';
import { loadTurns } from './exchange/loadTurns.js';
import { persistExchangedPair } from './exchange/persistExchange.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.turnRunDispatch');

/** A workflow run an agent tool ignited during the current turn. */
export interface TurnRunDispatch {
  runId: string;
  /** The agent the run is attributed to (the roster id the bubble renders as). */
  agentId: string;
  /** The workflow that was started. Carried because the DISPATCHING TOOL is the
   *  only party that knows it — the client would otherwise render a bubble with a
   *  blank title and a bare `/` slug (it has no cheap way to resolve a runId to a
   *  workflow). Optional so a caller that genuinely lacks it degrades to the
   *  client's generic label rather than being forced to invent one. */
  workflowId?: string;
  /** Human-readable name for the bubble/rail header; falls back to `workflowId`,
   *  then to a translated generic label client-side. */
  workflowName?: string;
}

/** The write side handed to tools via the tool scope. Deliberately narrow: a
 *  tool may RECORD a dispatch, never read or materialize one. */
export interface TurnRunDispatchSink {
  record(dispatch: TurnRunDispatch): void;
}

/** The exchange-side collector: a `sink` to hand down the scope, and `drain` to
 *  read what the turn's tools ignited. Dedupes by runId — a retried tool call
 *  that re-dispatches the same run must not double-render a bubble. */
export function createTurnRunDispatchCollector(): { sink: TurnRunDispatchSink; drain: () => TurnRunDispatch[] } {
  const byRunId = new Map<string, TurnRunDispatch>();
  return {
    sink: {
      record(dispatch) {
        if (!dispatch.runId) {
          // Correct to drop — there is nothing to point a bubble at — but never
          // silently: a caller reaching here believes it surfaced a run.
          log.warn('run_dispatch_recorded_without_run_id', { agentId: dispatch.agentId, workflowId: dispatch.workflowId });
          return;
        }
        if (byRunId.has(dispatch.runId)) return;
        byRunId.set(dispatch.runId, dispatch);
      },
    },
    drain: () => [...byRunId.values()],
  };
}

/**
 * Materialize the `workflow_run` turns for a turn's dispatched runs, starting at
 * `firstIndex`. Pure — the caller persists them with its own turns and includes
 * them in its response, so there is exactly one write and one allocator.
 */
export function buildRunDispatchTurns(
  conversationId: string,
  dispatches: readonly TurnRunDispatch[],
  firstIndex: number,
): ConversationTurn[] {
  return dispatches.map((d, i) =>
    makeTurn({
      conversationId,
      turnIndex: firstIndex + i,
      role: 'agent',
      from: d.agentId,
      // Additive, host-internal turn content (RFC 0005 treats turn content as
      // opaque). `workflowId`/`workflowName` are omitted when unknown so a reader
      // distinguishes "not provided" from "empty name".
      content: {
        kind: 'workflow_run', runId: d.runId, agentId: d.agentId,
        ...(d.workflowId ? { workflowId: d.workflowId } : {}),
        ...(d.workflowName ? { workflowName: d.workflowName } : {}),
      },
      ts: Date.now(),
      groupId: conversationId,
      agent: { agentId: d.agentId },
      speakerId: d.agentId,
    }),
  );
}

/**
 * Out-of-band append for transports that expose no collector (realtime voice,
 * the host-driven agentDispatch loop). Best-effort by contract — the run has
 * already started, so a persistence miss must never fail the tool — but never
 * SILENT: a conversation with no materialized backing run is logged, because
 * that is precisely the state in which a model's "your run is underway" claim
 * reaches a user with nothing to back it.
 */
export async function appendRunTurnDirect(
  storage: Storage,
  tenantId: string,
  conversationId: string,
  dispatch: TurnRunDispatch,
  nodeId: string,
): Promise<void> {
  try {
    const meta = await getConversationMeta(tenantId, conversationId);
    const backingRunId = meta?.conversationRunId;
    if (!backingRunId) {
      log.warn('run_turn_no_backing_conversation_run', { conversationId, runId: dispatch.runId, nodeId });
      return;
    }
    const turns = await loadTurns(storage, backingRunId, conversationId);
    const nextIndex = turns.reduce((max, t) => Math.max(max, t.turnIndex), -1) + 1;
    const [turn] = buildRunDispatchTurns(conversationId, [dispatch], nextIndex);
    if (!turn) return;
    await persistExchangedPair({
      runId: backingRunId,
      nodeId,
      conversationId,
      entries: [[nextIndex, turn]],
    });
  } catch (err) {
    log.warn('run_turn_persist_failed', {
      conversationId,
      runId: dispatch.runId,
      nodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * What a feature's agent tool calls after igniting a run. Prefers the turn-scoped
 * collector (the exchange materializes correctly-indexed turns and returns them
 * in the response); falls back to the out-of-band append for collector-less
 * transports. Features must not hand-roll either path.
 */
export async function surfaceDispatchedRun(
  scope: { tenantId: string; conversationId?: string | undefined; onRunDispatched?: TurnRunDispatchSink | undefined },
  storage: Storage,
  dispatch: TurnRunDispatch,
  nodeId: string,
): Promise<void> {
  // ONE line that answers the question this incident could not answer from the
  // logs: "the tool says it dispatched — was the run ever SURFACED, and how?"
  // `challenge_factory_dispatched` proved the run started; nothing recorded
  // whether the conversation ever learned about it. Grep `run_dispatch_surfaced`
  // beside the feature's own dispatch log to see both halves.
  const mode = !scope.conversationId ? 'no_conversation' : scope.onRunDispatched ? 'exchange' : 'direct';
  log.info('run_dispatch_surfaced', { runId: dispatch.runId, conversationId: scope.conversationId, mode, nodeId });
  if (!scope.conversationId) return; // not running inside a conversation — nothing to surface
  if (scope.onRunDispatched) {
    scope.onRunDispatched.record(dispatch);
    return;
  }
  await appendRunTurnDirect(storage, scope.tenantId, scope.conversationId, dispatch, nodeId);
}
