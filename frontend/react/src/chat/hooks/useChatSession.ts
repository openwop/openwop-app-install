/**
 * Chat session state. Holds the message thread + drives the RFC 0005 conversation
 * primitive (the SOLE chat transport since ADR 0067 Phase 6 — the per-turn
 * `openwop-app.chat.turn` fallback was retired). `@mention` workflow runs still go
 * through the per-turn createRun + SSE path (`runWorkflowMention`).
 *
 * Lifecycle of a chat turn (`send` → `sendViaConversation`):
 *   1. User submits → append a user Message + an optimistic in-flight assistant bubble
 *   2. Open ONE long-lived conversation run per session (lazily; reused across reloads)
 *   3. `exchange` the message; tail the run SSE so `output.chunk` deltas stream live (ADR 0079)
 *   4. Reconcile to the authoritative wire turns; on failure, append a classified error bubble
 *
 * Sessions are persisted to localStorage (Phase 1). Each session has an
 * id + title + messages[] + createdAt. The current session is the most
 * recently used.
 *
 * ADR 0327 P2 — this file is the COMPOSER of the `chatSession/` hook family:
 * `useChatSessionCore` (shared state/refs) feeds `useSessionPersistence` →
 * `useTranscriptSync` → `useInterruptResolution` → `useWorkflowRunMentions` →
 * `useTurnTransport` (composition order preserves the original effect
 * registration order). The 22-field return surface is FROZEN — identical
 * fields, identical semantics; the integration + multiTab suites pin it.
 */

import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import { useActiveAgents, type UseActiveAgentsResult } from '../activeAgents/useActiveAgents.js';
import type { WorkflowMentionEntry } from '../lib/workflowMentions.js';
import { useChatSessionCore, type UseChatSessionOpts } from './chatSession/core.js';
import { useSessionPersistence } from './chatSession/useSessionPersistence.js';
import { useTranscriptSync } from './chatSession/useTranscriptSync.js';
import { useInterruptResolution } from './chatSession/useInterruptResolution.js';
import { useWorkflowRunMentions } from './chatSession/useWorkflowRunMentions.js';
import { useTurnTransport } from './chatSession/useTurnTransport.js';

// Phase 2D — types extracted to `../types.js` so this hook can focus
// on lifecycle. Re-exported here for back-compat with existing callers
// (MessageBubble, MessageRenderer, etc. import these from this module).
export type {
  AgentDecision,
  AgentHandoff,
  AgentToolCall,
  AgentVerified,
  ChatMessage,
  ChatMessageThoughts,
  ChatSession,
  Citation,
  ContentPart,
  SendOptions,
  WorkflowRunState,
} from '../types.js';
export { messageText } from '../types.js';
import type { ChatSession, SendOptions } from '../types.js';

export interface UseChatSessionResult {
  session: ChatSession;
  /** True while a turn is in flight. */
  isSending: boolean;
  /** True while a backend-keyed session (a multi-tab tab, ADR 0140) is hydrating its
   *  thread from the backend on mount — so the view can show a loading state instead of
   *  the "new chat" welcome for a conversation that isn't actually empty. Always false
   *  for the singleton/ephemeral callers (they don't backend-hydrate). */
  isHydrating: boolean;
  /** The agentId currently generating a reply (the addressed advisor), while a
   *  turn is in flight — drives the sidebar "thinking" pulse. Null when idle or
   *  when the responder isn't a specific named agent. */
  thinkingAgentId: string | null;
  /** Last error from a turn dispatch. */
  error: string | null;
  /** Submit a user message and start a new turn. */
  send: (text: string, config: BYOKActiveConfig, opts?: SendOptions) => Promise<void>;
  /** Run a workflow directly via an `@mention`. Bypasses the LLM and
   *  dispatches POST /v1/runs immediately; surfaces progress + HITL
   *  interrupts inline in the chat feed as a `workflow_run` message. */
  runWorkflowMention: (entry: WorkflowMentionEntry, trailing?: string) => Promise<void>;
  /** Cancel an in-flight workflow_run. No-op if the message is not a
   *  workflow_run, its run is not in flight, or its runId isn't set. */
  cancelWorkflowRun: (messageId: string) => Promise<void>;
  /** Cancel the in-flight turn (if any). No-op when nothing is streaming. */
  cancel: () => Promise<void>;
  /** Append a synthetic system-role message to the visible thread.
   *  Used by slash-command handlers (e.g., /help output, /cost summary). */
  emitSystem: (content: string) => void;
  /** RT-9 — append a spoken turn from a realtime voice session as a display bubble
   *  (a transcript, not a send — the realtime model already answered by voice). */
  /** RT-9c — upsert a LIVE transcript bubble from a realtime voice session (interim + settled). */
  upsertTranscriptTurn: (text: string, role: 'user' | 'assistant', turnId: string, final: boolean) => void;
  /** GRADE-D1 — light merge-refresh of the newest persisted page (no state teardown). */
  refreshNewestMessages: (sessionId: string, targetMessageIds?: readonly string[]) => Promise<void>;
  /** Wipe the session and start fresh. */
  reset: () => void;
  /** Resolve one open interrupt on a message. `nodeId` targets which one when
   *  the message carries several (parallel-gate fan-out); omit it when there's
   *  only a single open interrupt. */
  resolveInterrupt: (messageId: string, value: unknown, nodeId?: string) => Promise<void>;
  /** "Try again": re-send the user message preceding the assistant bubble at
   *  `messageId` as a fresh exchange, APPENDED to the thread (the RFC 0005
   *  conversation run is append-only — see the impl note). No-op if the message
   *  is not an assistant turn, has no preceding user message, or a turn is already
   *  in flight. The prior user turn's text is replayed; attachments / web-search /
   *  tool flags are not preserved (caller passes the current config). */
  regenerate: (messageId: string, config: BYOKActiveConfig) => Promise<void>;
  /** Toggle 👍/👎 feedback on an assistant bubble. Pass `null` to clear. */
  setFeedback: (messageId: string, feedback: 'positive' | 'negative' | null) => void;
  /** Switch the active chat to a persisted session — cancels the in-flight
   *  subscription, loads messages from the BE, replaces local state. */
  loadSessionFromBackend: (sessionId: string) => Promise<void>;
  /** True when the loaded backend thread has older messages not yet fetched
   *  (ADR 0043 Phase 3b) — drives the feed's "Load earlier messages" control. */
  hasOlderMessages: boolean;
  /** True while an earlier page is being fetched (disables the control). */
  isLoadingEarlier: boolean;
  /** Fetch + prepend the next-older page of messages. No-op when none remain. */
  loadEarlierMessages: () => Promise<void>;
  /** Active-agents lineup + mutation handlers (phase D1+). The UI
   *  consumes this through the Conversations rail's inline participants
   *  (ADR 0043); the chat dispatcher (phase D2) reads `currentAgentId` to
   *  route turns; the `@`-mention submit path (phase D3) calls `activate`. */
  activeAgents: UseActiveAgentsResult;
}

export function useChatSession(opts: UseChatSessionOpts = {}): UseChatSessionResult {
  // Shared state/refs + the localStorage persist effect (ADR 0327 P2 core).
  const core = useChatSessionCore(opts);
  // Write-through + session lifecycle (reset / backend load / pagination / feedback).
  const { ensureSessionInBackend, persistMessage, persistOrUpdateMessage, reset, loadSessionFromBackend, loadEarlierMessages, setFeedback } = useSessionPersistence(core);
  // Voice transcript upsert + the light newest-page merge refresh.
  const { upsertTranscriptTurn, refreshNewestMessages } = useTranscriptSync(core, { persistMessage });
  // Interrupt-card resolution.
  const { resolveInterrupt } = useInterruptResolution(core);
  // @mention workflow runs (self-healing SSE, reopen rehydration, mount reconcile).
  const { runWorkflowMention, cancelWorkflowRun } = useWorkflowRunMentions(core, { persistMessage, persistOrUpdateMessage });
  // The RFC 0005 conversation exchange lifecycle (send/cancel/emitSystem/regenerate).
  const { send, cancel, emitSystem, regenerate } = useTurnTransport(core, { persistMessage, ensureSessionInBackend });

  // The useActiveAgents call is unconditional, so rule-of-hooks holds.
  // Placement here (vs at the top of the function) keeps the active-agents
  // API logically grouped with the chat-session result it's exposed on.
  const activeAgents = useActiveAgents(core.session, core.setSession);

  return {
    session: core.session,
    isSending: core.isSending,
    isHydrating: core.isHydrating,
    thinkingAgentId: core.isSending ? core.thinkingAgentIdState : null,
    error: core.error,
    send,
    cancel,
    emitSystem,
    upsertTranscriptTurn,
    refreshNewestMessages,
    reset,
    resolveInterrupt,
    runWorkflowMention,
    cancelWorkflowRun,
    regenerate,
    setFeedback,
    loadSessionFromBackend,
    hasOlderMessages: core.hasOlderMessages,
    isLoadingEarlier: core.isLoadingEarlier,
    loadEarlierMessages,
    activeAgents,
  };
}
