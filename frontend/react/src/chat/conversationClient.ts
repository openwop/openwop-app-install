/**
 * Conversation-primitive client (RFC 0005) — the frontend surface for a
 * wire-aligned multi-agent chat.
 *
 * A chat session maps to ONE long-lived conversation run (a workflow with a
 * `core.conversationGate` node). The user's first message OPENS it; each
 * subsequent message is an `exchange` (the gate stays suspended); "New chat"
 * `close`s it. Per-turn agent attribution comes from the wire
 * (`conversation.exchanged` turns carry `from`/`role`/`agent`), so the thread is
 * rebuilt from the run's events rather than stamped client-side (supersedes the
 * #203 frontend labeling).
 *
 * This module is the client surface + the pure turn-reconstructor. Wiring it as
 * the default chat transport is a deliberate, separately-rolled-out cutover (the
 * existing per-turn path keeps working until then).
 */

import { createRun } from '../client/runsClient.js';
import { resolveByRun } from '../client/interruptsClient.js';

/** Mirror of the wire `ConversationTurn` (conversation-turn.schema.json). */
export interface ConversationTurn {
  messageId: string;
  from: string;
  to?: string;
  groupId?: string;
  content: unknown;
  ts: number;
  role: 'user' | 'agent' | 'system';
  agent?: { agentId: string };
  turnIndex: number;
}

/** A run event as surfaced by the run event stream / debug bundle. */
export interface RunEvent {
  type?: string;
  payload?: { conversationId?: string; initialTurn?: ConversationTurn; turn?: ConversationTurn; finalTurn?: ConversationTurn };
}

/** Open a conversation run for a session. The workflow MUST contain a
 *  `core.conversationGate` node (the demo registers `openwop-app.conversation`). */
export async function openConversation(input: {
  workflowId: string;
  nodeId?: string;
  tenantId?: string;
  /** Provider config carried into the run so the exchange handler dispatches
   *  the agent reply with the SAME provider/model/credential as the per-turn
   *  chat (managed by default; the user's BYOK row when selected). */
  inputs?: Record<string, unknown>;
  /** Host-extension run metadata. Carries the chat `sessionId` so the exchange
   *  handler can resolve the conversation's ConversationMeta — `ownerSubject`
   *  knowledge grounding (ADR 0084) and a board's injected strategy context
   *  (ADR 0079 Phase 5) are keyed by the chat sessionId, not the run-derived gate
   *  conversationId, so without this the exchange never finds them. */
  metadata?: Record<string, unknown>;
}): Promise<{ runId: string }> {
  const res = await createRun({
    workflowId: input.workflowId,
    inputs: input.inputs ?? {},
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return { runId: res.runId };
}

/** Send one user turn to the addressed agent (`to` = the @mention agentId).
 *  The gate stays suspended; the agent reply arrives as a conversation.exchanged
 *  event on the run's stream. `exchangeKey` (ADR 0067 §Phase 2) is a stable
 *  per-attempt idempotency key: replaying it (double-submit, retry) returns the
 *  already-appended turns instead of duplicating them. */
export async function exchange(runId: string, nodeId: string, input: { content: unknown; to?: string; exchangeKey?: string; webSearch?: boolean; model?: string; provider?: string; permissionMode?: 'safe' | 'bypass' }): Promise<void> {
  await resolveByRun(runId, nodeId, {
    operation: 'exchange',
    turn: { content: input.content, ...(input.to ? { to: input.to } : {}) },
    ...(input.exchangeKey ? { exchangeKey: input.exchangeKey } : {}),
    // Per-exchange native web-search override (ADR 0101) — so a mid-chat toggle
    // takes effect on THIS turn, not just the next new conversation.
    ...(input.webSearch !== undefined ? { webSearch: input.webSearch } : {}),
    // Per-exchange model switch (ADR 0124 Phase 2b/3) — the in-chat selector sends
    // the chosen model/provider for THIS turn; the backend applies it at highest
    // precedence (override > route stamp > run inputs).
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    // Per-exchange permission mode (ADR 0150) — the composer Safe/Bypass switch sends the
    // mode for THIS turn; `bypass` lets the agent act without an approval card.
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
  });
}

/** Close the conversation (resumes + completes the run). */
export async function closeConversation(runId: string, nodeId: string, outcome?: unknown): Promise<void> {
  await resolveByRun(runId, nodeId, { operation: 'close', ...(outcome !== undefined ? { outcome } : {}) });
}

/**
 * Rebuild the ordered conversation from a run's events (the open turn + every
 * exchanged turn for the conversation), deduped on messageId and sorted by
 * turnIndex. Pure — the single source of truth for rendering the thread.
 */
export function reconstructConversation(events: readonly RunEvent[]): ConversationTurn[] {
  const byId = new Map<string, ConversationTurn>();
  for (const e of events) {
    const t =
      e.type === 'conversation.opened' ? e.payload?.initialTurn :
      e.type === 'conversation.exchanged' ? e.payload?.turn :
      e.type === 'conversation.closed' ? e.payload?.finalTurn :
      undefined;
    if (t && typeof t.messageId === 'string' && !byId.has(t.messageId)) byId.set(t.messageId, t);
  }
  return [...byId.values()].sort((a, b) => a.turnIndex - b.turnIndex);
}
