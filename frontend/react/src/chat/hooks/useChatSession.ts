/**
 * Chat session state. Holds the message thread + drives the RFC 0005 conversation
 * primitive (the SOLE chat transport since ADR 0067 Phase 6 — the per-turn
 * `openwop-app.chat.turn` fallback was retired). `@mention` workflow runs still go
 * through the per-turn createRun + SSE path (`runWorkflowMention`).
 *
 * Lifecycle of a chat turn (`send` → `sendViaConversation`):
 *   1. User submits → append a user Message + an optimistic in-flight assistant bubble
 *   2. Open ONE long-lived conversation run per session (lazily; reused across reloads)
 *   3. `exchange` the message; tail the run SSE so `ai.message.chunk` deltas stream live (ADR 0079)
 *   4. Reconcile to the authoritative wire turns; on failure, append a classified error bubble
 *
 * Sessions are persisted to localStorage (Phase 1). Each session has an
 * id + title + messages[] + createdAt. The current session is the most
 * recently used.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../../i18n/index.js';
import { cancelRun, createRun, getRun } from '../../client/runsClient.js';
import { subscribeToRun, type Subscription } from '../../client/streamsClient.js';
import { listOpenInterrupts, resolveByRun } from '../../client/interruptsClient.js';
import {
  appendChatMessage,
  createChatSession,
  getSessionFeedback,
  listChatSessionMessagesPage,
  setConversationRun,
  updateChatMessage,
  type ChatMessagePersisted,
} from '../../client/chatSessionsClient.js';
import type { BYOKActiveConfig } from '../../byok/lib/useBYOKConfig.js';
import { useApplyAnimation } from './useApplyAnimation.js';
import { useActiveAgents, type UseActiveAgentsResult } from '../activeAgents/useActiveAgents.js';
import { getSavedWorkflow } from '../../builder/persistence/localStore.js';
// serializeWorkflow + registerWorkflow are lazy-imported at their one call site
// (running a saved workflow) so builder/palette/catalogRegistry stays out of the
// first-paint chat entry chunk.
import type { WorkflowMentionEntry } from '../lib/workflowMentions.js';
import { loadSession, persistSession, freshSession } from '../lib/chatPersistence.js';
import { chatSessionReducer } from '../lib/chatSessionReducer.js';
import { openConversationSession, sendConversationTurn, closeConversationSession, fetchTurns, turnsToBubbles, streamDeltaFromEvent, exchangeSettleSignal, exchangeErrorPayload, toolActivityFromEvent, titledFromEvent, CONVERSATION_GATE_NODE_ID, type ConversationBubble, type ToolActivity } from '../conversationTransport.js';
import type { ConversationTurn } from '../conversationClient.js';
import { WopError } from '@openwop/openwop';
import { setMessageFeedback } from '../state/messageFeedbackClient.js';
import { planInterruptResolution, removeInterruptByNode } from '../lib/interruptResolution.js';

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

import type {
  ChatMessage,
  ChatSession,
  SendOptions,
  WorkflowRunState,
} from '../types.js';
import { messageText } from '../types.js';
import { makeWorkflowRunHandlers, reconcileWorkflowRunFromLog, type WorkflowRunHandlerContext } from './workflowRunSubscription.js';

// `ChatSession` + `SendOptions` now live in `../types.js`; see the
// re-export above. Inlined imports are sufficient for the rest of this
// file.

// The localStorage session blob + the drawer's fallback session-header index
// now live in `../lib/chatPersistence.ts` (loadSession / persistSession);
// extracted so persistence is a separately testable seam.

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

/** Built-in fallback inputs for hardcoded sample.* workflows that ship without
 *  a SavedWorkflow defaultInputs blob. Module-scoped (static data) so it has a
 *  stable identity and never needs to appear in a hook dependency array. */
const SAMPLE_DEFAULT_INPUTS: Record<string, Record<string, unknown>> = {
  'openwop-app.uppercase': { text: 'hello world' },
};

/** How many messages a backend session loads per page (ADR 0043 Phase 3b).
 *  The newest page renders immediately; "Load earlier messages" pages older. */
const MESSAGE_PAGE_SIZE = 50;

// ADR 0079 §Phase 3 — how long the async-exchange path waits for the reply's
// settle signal (the agent turn or a terminal error) on the SSE before giving
// up and surfacing a retry. Generous: removing the ~60s ceiling for long replies
// is the whole point, so this matches the backend dispatch budget (180s).
const ASYNC_SETTLE_TIMEOUT_MS = 180_000;

/** The CANONICAL chat-message id for a conversation wire turn — the single id used
 *  for display, the durable store, dedup, and reopen, so there is no per-path id
 *  duality (feedback / regenerate / "load earlier" all key on the same value).
 *
 *  Wire turn ids are `${runId}:gate:0:${turnIndex}:${role}` — the colons fail the
 *  chat-message store's `/^[A-Za-z0-9_-]{1,64}$/` pattern. Sanitizing colons →
 *  `_` is enough for today's uuid runIds (~52 chars), and is stable/deterministic
 *  (same turn → same id) so dedup + a later reload line up. But a naive
 *  `.slice(0, 64)` would truncate the TAIL — exactly the `${turnIndex}:${role}`
 *  discriminator — so a longer (e.g. prefixed) runId could collide two turns and
 *  silently drop the second on its 409. Guard with a stable hash fallback that
 *  preserves the discriminating tail; the common path stays the readable id. */
function conversationMessageId(wireId: string): string {
  const sanitized = wireId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized.length <= 64) return sanitized;
  // FNV-1a (32-bit) over the FULL wire id — deterministic, no deps. Combined with
  // the readable tail (turnIndex+role) so two long ids can't collide on the hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < wireId.length; i += 1) { h ^= wireId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `cm_${(h >>> 0).toString(36)}_${sanitized.slice(-40)}`;
}

/** Decode persisted rows (each `content` is a JSON-encoded ChatMessage minus its
 *  id — the id is the row's messageId) back into ChatMessages, dropping any row
 *  that fails to parse. Shared by the initial load + the load-earlier path. */
function parsePersistedMessages(rows: readonly ChatMessagePersisted[]): ChatMessage[] {
  return rows
    .map((p): ChatMessage | null => {
      // The chat surface stores a JSON-serialized ChatMessage envelope; CHANNEL
      // posts + agent replies (channelService / agentRunnerNode) store PLAIN TEXT.
      // Handle both: a JSON object envelope wins; anything else (plain text, or a
      // JSON scalar) is treated as a plain-text message built from the row's role.
      try {
        const parsed = JSON.parse(p.content) as unknown;
        if (parsed && typeof parsed === 'object' && ('content' in parsed || 'role' in parsed)) {
          return { ...(parsed as Omit<ChatMessage, 'id'>), id: p.messageId };
        }
      } catch { /* not JSON — fall through to the plain-text path */ }
      return { id: p.messageId, role: p.role, content: p.content, createdAt: p.createdAt } as ChatMessage;
    })
    .filter((m): m is ChatMessage => m !== null);
}

/** ADR 0089 Phase 2 — fold one tool-loop step into the in-flight assistant
 *  message's existing `agentEvents.toolCalls` cards (Running… → done/error).
 *  De-dupes on `callId` since the run SSE replays from seq 0 on reconnect. */
function applyToolActivity(
  messageId: string,
  activity: ToolActivity,
  setSession: (updater: (s: ChatSession) => ChatSession) => void,
): void {
  if (activity.kind === 'reasoned') return; // summary only — no card
  setSession((s) => ({
    ...s,
    messages: s.messages.map((m) => {
      if (m.id !== messageId) return m;
      const ae = m.agentEvents ?? { toolCalls: [], handoffs: [], decisions: [] };
      const toolCalls = [...ae.toolCalls];
      if (activity.kind === 'tool-called') {
        if (activity.callId && toolCalls.some((c) => c.callId === activity.callId)) return m;
        toolCalls.push({
          callId: activity.callId ?? crypto.randomUUID(),
          toolName: activity.toolName ?? 'tool',
          agentId: activity.agentId ?? '',
          startedAt: new Date().toISOString(),
        });
      } else {
        const idx = toolCalls.findIndex((c) =>
          activity.callId ? c.callId === activity.callId : (!c.finishedAt && c.toolName === activity.toolName),
        );
        const card = idx >= 0 ? toolCalls[idx] : undefined;
        // No matching open card, OR already settled — ignore. The settled guard
        // keeps a replayed `toolReturned` (the run SSE replays from seq 0 on
        // reconnect) from re-stamping `finishedAt` and drifting the duration badge.
        if (!card || card.finishedAt) return m;
        const failedStatus = activity.status && activity.status !== 'ok' ? activity.status : undefined;
        // Human-readable message for the card's expanded view (the code stays the
        // machine status). Terse "tool forbidden" reads as a bug to a user.
        const errorMessage = failedStatus === 'forbidden' ? "This tool isn't permitted for this agent."
          : failedStatus === 'invalid_args' ? 'The tool was called with invalid arguments.'
          : 'The tool call failed.';
        toolCalls[idx] = {
          ...card,
          finishedAt: new Date().toISOString(),
          ...(failedStatus ? { error: { code: failedStatus, message: errorMessage } } : {}),
        };
      }
      return { ...m, agentEvents: { ...ae, toolCalls } };
    }),
  }));
}

export function useChatSession(
  opts: {
    persist?: boolean;
    /** Multi-tab (ADR 0140): bind this session to a specific backend conversation
     *  id and run in "backend-keyed" mode — hydrate the thread from the backend on
     *  mount, and do NOT read/write the shared singleton localStorage current-session
     *  cache (`LS_CURRENT_SESSION_KEY`), which N concurrent tabs would clobber. The
     *  durable backend store + the keyed session index stay correct. Implies persist. */
    sessionId?: string;
    /** Backend-keyed mode only: fired when the hook's session id changes away from
     *  the bound id (e.g. `reset()` mints a new chat in-place), so the tab container
     *  can re-key the tab to the new conversation id and not strand it. */
    onSessionIdChange?: (sessionId: string) => void;
  } = {},
): UseChatSessionResult {
  // Ephemeral mode (persist:false) — a task-scoped chat (e.g. the builder's
  // embedded authoring chat, ADR 0073) that must NOT read/write the shared
  // `openwop-app.chat.session` localStorage key or the conversations index, so
  // it can't clobber or pollute the user's main chat. Defaults to persisted.
  const persist = opts.persist !== false;
  // Backend-keyed multi-tab mode: a fixed conversation id, hydrated from the BE,
  // with the singleton current-cache disabled. `useCurrentCache` is the ONLY thing
  // that writes the shared `LS_CURRENT_SESSION_KEY` slot — true for the singleton
  // main chat, false for every tab. (ADR 0140 §Decision 0.)
  const backendKeyedSessionId = (persist && typeof opts.sessionId === 'string' && opts.sessionId.length > 0)
    ? opts.sessionId
    : null;
  const backendKeyed = backendKeyedSessionId !== null;
  const useCurrentCache = persist && !backendKeyed;
  const onSessionIdChange = opts.onSessionIdChange;
  const [session, setSession] = useState<ChatSession>(() =>
    backendKeyedSessionId ? freshSession(backendKeyedSessionId) : persist ? loadSession() : freshSession());
  const [isSending, setIsSending] = useState(false);
  // True until a backend-keyed tab's one-shot mount-load resolves (ADR 0140 P5/P6 — so
  // the view shows a loading state, not the new-chat welcome, for a restored thread).
  const [isHydrating, setIsHydrating] = useState(backendKeyed);
  // The addressed agent for the in-flight turn; surfaced (gated on isSending) as
  // `thinkingAgentId` so the sidebar pulses the right advisor without needing to
  // clear at each of the many setIsSending(false) sites.
  const [thinkingAgentIdState, setThinkingAgentIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mirror `session` in a ref so stable callbacks (resolveInterrupt,
  // etc.) can read the latest state without putting `session` in their
  // dep array (which would invalidate every dependent callback on
  // every message tick). Updated synchronously after every commit via
  // the useEffect below.
  const sessionRef = useRef<ChatSession>(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  // Reverse-pagination state for the loaded thread (ADR 0043 Phase 3b). The
  // cursor points at the oldest message currently held; null means we're at the
  // start of history (or the session was never paged — a fresh/local chat).
  const olderCursorRef = useRef<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const subRef = useRef<Subscription | null>(null);
  /** Run id of the in-flight turn. Used by cancel(). */
  const inFlightRunIdRef = useRef<string | null>(null);
  /** Assistant message id of the in-flight bubble. Used by cancel(). */
  const inFlightAssistantIdRef = useRef<string | null>(null);
  /** The long-lived RFC 0005 conversation run for this session (the sole chat
   *  transport). Opened lazily on the first send; closed on reset(). */
  const conversationRef = useRef<{ runId: string; nodeId: string } | null>(null);
  /** Accumulated conversation turns (ADR 0067 §Phase 4 tailing), keyed by
   *  messageId, plus the highest event sequence folded so far. Each exchange
   *  fetches only events past the cursor and merges them, instead of rescanning
   *  the run's whole event log from seq 0. Reset when the conversation run changes. */
  const conversationTurnsRef = useRef<Map<string, ConversationTurn>>(new Map());
  const conversationCursorRef = useRef(0);
  /** SSE subscriptions for live workflow_run messages, keyed by the
   *  workflow_run chat-message id. Bare-mention dispatches are
   *  long-lived and independent of the chat-turn lifecycle — they
   *  can run concurrently and outlive any single chat turn, so they
   *  need their own ref. Cleared on terminal events + unmount. */
  const workflowSubsRef = useRef<Map<string, Subscription>>(new Map());
  /** Indirection to `rehydrateWorkflowRuns` (defined later) so the mount hydration
   *  effect + `loadSessionFromBackend` (both declared ABOVE it) can re-attach live
   *  to a reopened session's non-terminal workflow runs without a forward TS
   *  reference. Assigned each render once the real callback exists. */
  const rehydrateWorkflowRunsRef = useRef<(sess: ChatSession) => void>(() => {});
  /** Session-ids known to exist in the BE. Populated by
   *  `ensureSessionInBackend()` (lazy POST on first persist), by
   *  `reset()` (eager POST), and by `loadSessionFromBackend()` (mark
   *  loaded). Sample-grade: lives for the hook's lifetime; a page
   *  reload re-discovers via the idempotent create-or-409 path. */
  const backendSessionsRef = useRef<Set<string>>(new Set());
  /** Message-ids already persisted to BE. Prevents double-persist when
   *  React re-fires terminal handlers (e.g., StrictMode dev double-
   *  invoke) and when the SSE stream emits a stale terminal event on
   *  reconnect. */
  const persistedIdsRef = useRef<Set<string>>(new Set());
  /** Multi-tab (ADR 0140): one-shot guard + parked promise for the backend-keyed
   *  mount-load (the tab hydrates its thread from the BE once on mount). `send`
   *  awaits `mountLoadRef` so a turn can't race ahead of the load. */
  const didMountLoadRef = useRef(false);
  const mountLoadRef = useRef<Promise<void> | null>(null);

  // Apply-animation: batches token deltas into ~one update per
  // animation frame. The flush callback appends the accumulated tail
  // to whichever in-flight assistant bubble exists.
  const animation = useApplyAnimation({
    frameBudgetMs: 16,
    onFlush: (tail) => {
      const assistantId = inFlightAssistantIdRef.current;
      if (!assistantId) return;
      setSession((s) => ({
        ...s,
        // Assistant streams are always string content (LLMs stream text).
        // The ContentPart[] path is for user multi-modal messages.
        messages: s.messages.map((m) =>
          m.id === assistantId
            ? { ...m, content: (typeof m.content === 'string' ? m.content : '') + tail }
            : m,
        ),
      }));
    },
  });

  useEffect(() => {
    if (persist) persistSession(session, { writeCurrentCache: useCurrentCache });
  }, [session, persist, useCurrentCache]);

  /** Lazily create a session in the BE if we haven't already. Idempotent
   *  against 409 conflicts so a page reload that re-uses a previously-
   *  created sessionId silently no-ops. Errors are logged but never
   *  surface to the UI — write-through is best-effort. */
  const ensureSessionInBackend = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (backendSessionsRef.current.has(sessionId)) return;
    try {
      await createChatSession({ sessionId, title });
      backendSessionsRef.current.add(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // 409 = the session already exists (e.g., we created it on a
      // previous page load). Treat as success for the dedup cache so
      // subsequent persists don't retry the create.
      if (msg.includes('idempotency_key_conflict')) {
        backendSessionsRef.current.add(sessionId);
      } else {
        // Network down or BE unreachable — leave dedup empty; we'll
        // retry on the next persist. The UI continues to work via
        // localStorage; the drawer just won't reflect this session
        // until connectivity returns.
        console.warn('chat-session BE create failed (write-through degraded)', err);
      }
    }
  }, []);

  /** Fire-and-forget persist a finalized chat message to BE. Calling
   *  again with the same `msg.id` is a no-op (dedup via
   *  `persistedIdsRef`). Ensures the parent session exists first. */
  const persistMessage = useCallback(async (sessionId: string, title: string, msg: ChatMessage): Promise<void> => {
    // Ephemeral mode (persist:false): skip ALL backend history/rail writes — no
    // createChatSession, no appendChatMessage — so an embedded task-scoped chat
    // (ADR 0073) never creates a server-side session record in the user's
    // conversations rail. The live conversation run (sendViaConversation →
    // openConversationSession) is independent of this and still works.
    if (!persist) return;
    // CHAT-2: capture the dedup set instance up front. reset()/
    // loadSessionFromBackend swap `persistedIdsRef.current` for a new Set on a
    // session switch; claiming + rolling back against the captured instance (not
    // `.current`) keeps a mid-flight persist for the OLD session from mutating
    // the NEW session's dedup set on failure.
    const claimedSet = persistedIdsRef.current;
    if (claimedSet.has(msg.id)) return;
    claimedSet.add(msg.id); // claim immediately to dedup concurrent calls
    try {
      await ensureSessionInBackend(sessionId, title);
      const { id: _id, meta, ...rest } = msg;
      const contentJson = JSON.stringify(rest);
      const args: Parameters<typeof appendChatMessage>[1] = {
        messageId: msg.id,
        role: msg.role,
        content: contentJson,
      };
      if (meta) args.meta = JSON.stringify(meta);
      await appendChatMessage(sessionId, args);
    } catch (err) {
      // Roll back the dedup claim so a future retry has a chance.
      // The user's session keeps streaming through localStorage; the
      // drawer just won't show this message until the next persist
      // succeeds.
      claimedSet.delete(msg.id);
      console.warn('chat-message BE persist failed (write-through degraded)', err);
    }
  }, [ensureSessionInBackend, persist]);

  /** Persist a MUTABLE message (a run-backed `workflow_run` whose state grows
   *  across its lifecycle): append the FIRST time, UPDATE in place thereafter, so a
   *  HITL-suspended / still-running run survives reopen with its node cards + the
   *  interrupt card — not just the terminal snapshot (ADR 0067; the myndhyve
   *  "re-save the message as it evolves" pattern). Dedup-set membership decides
   *  append-vs-update; a first-append 409 (a racing/older session already wrote it)
   *  falls back to update. Best-effort + persisted-mode only. */
  const persistOrUpdateMessage = useCallback(async (sessionId: string, title: string, msg: ChatMessage): Promise<void> => {
    if (!persist) return;
    const claimedSet = persistedIdsRef.current;
    const { id: _id, meta, ...rest } = msg;
    const content = JSON.stringify(rest);
    const metaStr = meta ? JSON.stringify(meta) : undefined;
    try {
      await ensureSessionInBackend(sessionId, title);
      if (claimedSet.has(msg.id)) {
        await updateChatMessage(sessionId, msg.id, { content, ...(metaStr ? { meta: metaStr } : {}) });
        return;
      }
      claimedSet.add(msg.id);
      try {
        await appendChatMessage(sessionId, { messageId: msg.id, role: msg.role, content, ...(metaStr ? { meta: metaStr } : {}) });
      } catch (err) {
        // A duplicate id (a prior write we don't have in this session's dedup set,
        // e.g. after reload) → switch to update; keep the claim so future saves
        // update too. Other errors roll the claim back for a later retry.
        if (err instanceof Error && /idempotency_key_conflict|already exists|\b409\b/.test(err.message)) {
          await updateChatMessage(sessionId, msg.id, { content, ...(metaStr ? { meta: metaStr } : {}) });
        } else {
          claimedSet.delete(msg.id);
          throw err;
        }
      }
    } catch (err) {
      console.warn('chat-message BE upsert failed (write-through degraded)', err);
    }
  }, [ensureSessionInBackend, persist]);

  useEffect(() => () => {
    subRef.current?.close();
    closeAllWorkflowSubs();
  }, []);

  // Hydration poll: any persisted workflow_run with status='running' is
  // stale (the SSE subscription died on the previous tab/reload). Fetch
  // a one-shot snapshot + open-interrupts list per stuck run so we can
  // either reconcile to a terminal state OR re-surface a missed
  // approval card inline. The ref guard ensures we only walk the
  // initial session — subsequent session changes drive their own SSE.
  const didHydrateRef = useRef(false);
  useEffect(() => {
    if (didHydrateRef.current) return;
    // Backend-keyed tab (ADR 0140): the initial session is an EMPTY placeholder; the
    // real thread arrives async via the mount-load below. Reconciling the empty
    // placeholder would flip `didHydrate` and never cover the loaded messages — so
    // wait. This effect re-fires on `session` change, running once the load lands.
    // (A genuinely empty conversation stays skipped, which is correct — nothing to
    // reconcile.)
    if (backendKeyed && session.messages.length === 0) return;
    didHydrateRef.current = true;
    let cancelled = false;
    // Re-attach LIVE to any non-terminal workflow_run restored from localStorage
    // on this initial load (F5): rebuild cards from the log + resume SSE so the
    // run keeps streaming and the HITL card stays actionable — not frozen at the
    // persisted snapshot. The one-shot reconcile loops below still run (they also
    // flag a 404'd run unavailable); rehydrate skips runs it already re-subscribed.
    rehydrateWorkflowRunsRef.current(session);
    void (async () => {
      const stuck = session.messages.filter(
        (m): m is ChatMessage & { workflowRun: WorkflowRunState } =>
          m.role === 'workflow_run'
          && m.workflowRun?.status === 'running'
          && typeof m.workflowRun?.runId === 'string',
      );
      for (const m of stuck) {
        const runId = m.workflowRun.runId;
        if (!runId) continue;
        try {
          const snap = await getRun(runId);
          if (cancelled) return;
          const next: WorkflowRunState['status'] | null = (() => {
            switch (snap.status) {
              case 'completed': return 'completed';
              case 'failed':    return 'failed';
              case 'cancelled': return 'cancelled';
              default: return null;
            }
          })();
          if (next) {
            setSession((s) => ({
              ...s,
              messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
                ...mm,
                workflowRun: {
                  ...mm.workflowRun,
                  status: next,
                  ...(next === 'failed' ? { error: { code: 'reconciled', message: 'Run failed; details in /runs.' } } : {}),
                },
              } : mm),
            }));
            continue;
          }
          // Not terminal — check for open interrupts so the approval
          // card resurfaces if SSE delivery missed the `node.suspended`
          // event (page reload, dropped connection, etc.).
          try {
            const open = await listOpenInterrupts(runId);
            if (cancelled) return;
            if (open.length > 0) {
              setSession((s) => ({
                ...s,
                messages: s.messages.map((mm) => mm.id === m.id ? { ...mm, activeInterrupts: [...open] } : mm),
              }));
            }
          } catch (e) {
            // Best-effort resurfacing, but no longer silent (GAP-ANALYSIS E6):
            // a failed listOpenInterrupts left a run stuck with a phantom
            // spinner and no signal. Surface it for diagnosis.
            console.warn('[chat] could not resurface open interrupts for run', runId, e);
          }
        } catch (err) {
          // Distinguish 404 (run record gone — account-deleted, retention
          // sweep, fresh DB) from transient errors (5xx, network drop).
          // Only 404 flips the `runUnavailable` flag permanently; other
          // errors leave the bubble as-is so the next reload can recover.
          if (err instanceof Error && /\b404\b/.test(err.message)) {
            setSession((s) => ({
              ...s,
              messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
                ...mm,
                workflowRun: { ...mm.workflowRun, runUnavailable: true },
              } : mm),
            }));
          }
          /* other errors: leave the bubble as-is; user can refresh later */
        }
      }

      // Second pass — probe terminal-status workflow_run messages that
      // haven't been validated yet. They render fine from local persisted
      // state, but action links ("Open run", "View") would 404 if the
      // BE no longer has the row. One probe per message per session-load.
      const terminal = session.messages.filter(
        (m): m is ChatMessage & { workflowRun: WorkflowRunState } =>
          m.role === 'workflow_run'
          && m.workflowRun?.runId != null
          && m.workflowRun.runUnavailable === undefined
          && (m.workflowRun.status === 'completed'
              || m.workflowRun.status === 'failed'
              || m.workflowRun.status === 'cancelled'),
      );
      for (const m of terminal) {
        const runId = m.workflowRun.runId;
        if (!runId) continue;
        try {
          await getRun(runId);
          if (cancelled) return;
          // Mark as confirmed-available so we don't re-probe next reload.
          setSession((s) => ({
            ...s,
            messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
              ...mm,
              workflowRun: { ...mm.workflowRun, runUnavailable: false },
            } : mm),
          }));
        } catch (err) {
          if (cancelled) return;
          if (err instanceof Error && /\b404\b/.test(err.message)) {
            setSession((s) => ({
              ...s,
              messages: s.messages.map((mm) => mm.id === m.id && mm.workflowRun ? {
                ...mm,
                workflowRun: { ...mm.workflowRun, runUnavailable: true },
              } : mm),
            }));
          }
          /* transient errors: leave undefined so the next reload re-probes */
        }
      }
    })();
    return () => { cancelled = true; };
  }, [session, backendKeyed]);

  // RFC 0005 conversation transport — the sole chat transport (ADR 0067 Phase 6).
  // One long-lived conversation run per session: open lazily, `exchange` per
  // message, rebuild the thread from the wire.
  // Fold tailed turns into the accumulator and rebuild the message list from the
  // wire (the source of truth). Keyed by messageId so a re-fetch is idempotent;
  // sorted by turnIndex so order is wire-authoritative, not arrival order.
  // Pure display rebuild — folds the exchange delta into the accumulator, rebuilds
  // the message list from the wire (source of truth), and RETURNS the messages new
  // to THIS merge so the caller can persist them (the durable write is a separate
  // concern — see `persistTurns`). Each turn's display id is the canonical
  // `conversationMessageId` (sanitized once, here) so the SAME id is used live, in
  // the durable store, and on a later reopen — no per-path id duality.
  const mergeConversationTurns = useCallback((incoming: readonly ConversationTurn[]): ChatMessage[] => {
    // The ids new to THIS merge (the exchange delta), in the canonical scheme.
    const incomingIds = new Set(
      incoming.map((t) => t?.messageId).filter((id): id is string => typeof id === 'string').map(conversationMessageId),
    );
    for (const t of incoming) {
      if (t && typeof t.messageId === 'string') conversationTurnsRef.current.set(t.messageId, t);
    }
    const sorted = [...conversationTurnsRef.current.values()].sort((a, b) => a.turnIndex - b.turnIndex);
    // Resolve each turn's raw agentId (wire `agent.agentId`/`from`) to its lineup
    // row so the bubble can attribute by name + @handle, not a raw id "blob".
    const lineup = sessionRef.current.activeAgents?.lineup ?? [];
    const mapped: ChatMessage[] = turnsToBubbles(sorted).map((b: ConversationBubble) => {
      const rawId = b.agentPersona; // turnsToBubbles set this to agent.agentId ?? from
      const row = rawId ? lineup.find((a) => a.agentId === rawId) : undefined;
      return {
        // Canonical id: the wire turn id (`${runId}:gate:0:N:role`) sanitized to the
        // store's pattern — identical live, persisted, and on reopen (no id-flip).
        id: conversationMessageId(b.id), role: b.role, content: b.content, createdAt: new Date().toISOString(),
        ...(rawId ? { agentId: rawId } : {}),
        ...(row?.persona ? { agentPersona: row.persona } : {}),
        ...(row?.slug ? { agentSlug: row.slug } : {}),
      };
    });
    setSession((s) => ({ ...s, messages: mapped }));
    return mapped.filter((m) => incomingIds.has(m.id) && (m.role === 'user' || m.role === 'assistant'));
  }, []);

  // Mirror newly-arrived conversation turns into the durable chat-message store so
  // reopening a past chat from the rail (loadSessionFromBackend reads that store)
  // isn't blank. Best-effort, like the @mention workflow_run path; ephemeral
  // (persist:false) chats no-op inside persistMessage; the canonical-id dedup
  // (persistedIdsRef) keeps a re-merge / reload from re-POSTing a stored id (the
  // backend 409s on duplicates). SEQUENTIAL (await each before the next): the store
  // stamps `created_at` server-side and orders by it, so two CONCURRENT appends
  // could land the agent turn before its user turn (a reopened thread would show
  // the reply above the prompt). `msgs` is turnIndex-sorted, so awaiting in order
  // keeps the timestamps monotonic. persistMessage never rejects.
  const persistTurns = useCallback((msgs: readonly ChatMessage[]): void => {
    if (msgs.length === 0) return;
    const sid = sessionRef.current.id;
    const stitle = sessionRef.current.title;
    void (async () => {
      for (const m of msgs) await persistMessage(sid, stitle, m);
    })();
  }, [persistMessage]);

  const sendViaConversation = useCallback(async (text: string, config: BYOKActiveConfig, opts?: SendOptions): Promise<void> => {
    const optimistic: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: new Date().toISOString() };
    // The conversation `exchange` is synchronous and can run for tens of seconds
    // (a reasoning advisor), so show an optimistic "thinking" bubble attributed
    // to the addressed agent — otherwise the feed freezes with no who/what. It's
    // replaced by the real turn on success (mergeConversationTurns rebuilds from
    // the wire) and removed in the catch on failure.
    const thinkingId = crypto.randomUUID();
    const thinkingRow = opts?.activeAgentId ? sessionRef.current.activeAgents?.lineup.find((a) => a.agentId === opts.activeAgentId) : undefined;
    const thinking: ChatMessage = {
      id: thinkingId, role: 'assistant', content: '', isStreaming: true, createdAt: new Date().toISOString(),
      ...(opts?.activeAgentId ? { agentId: opts.activeAgentId } : {}),
      ...(thinkingRow?.persona ? { agentPersona: thinkingRow.persona } : {}),
      ...(thinkingRow?.slug ? { agentSlug: thinkingRow.slug } : {}),
    };
    setSession((s) => ({ ...s, title: s.messages.length === 0 ? text.slice(0, 60) : s.title, messages: [...s.messages, optimistic, thinking] }));
    // Stable idempotency key for THIS send: a double-submit / retry reuses it so
    // the backend returns the existing turns instead of duplicating them (ADR 0067).
    const exchangeKey = crypto.randomUUID();
    // ADR 0079 §Phase 2 — tail the run SSE so the reply's `ai.message.chunk`
    // deltas type into the optimistic bubble live, then reconcile to the wire turn.
    let streamSub: Subscription | null = null;
    // ADR 0079 §Phase 3 — fallback timer for the async settle-wait (cleared in finally).
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Reuse this session's open conversation run across reloads (the suspended
      // run survives restarts) so the agent keeps server-side context. Only open
      // a NEW one when neither the in-memory ref nor the persisted id exists —
      // opening with the SAME provider/model/credential the per-turn chat uses.
      if (!conversationRef.current) {
        const persistedRunId = sessionRef.current.conversationRunId;
        if (persistedRunId) {
          conversationRef.current = { runId: persistedRunId, nodeId: CONVERSATION_GATE_NODE_ID };
          // Reload recovery: seed the turn accumulator + cursor from the run's
          // events so the first exchange tails forward (and dedups) instead of
          // rescanning. Silent (no setSession) — the persisted local thread stays
          // visible until the exchange rebuilds it from the wire.
          if (conversationCursorRef.current === 0 && conversationTurnsRef.current.size === 0) {
            try {
              const hydrated = await fetchTurns(persistedRunId, 0);
              conversationCursorRef.current = hydrated.lastSeq;
              for (const t of hydrated.turns) {
                if (t && typeof t.messageId === 'string') conversationTurnsRef.current.set(t.messageId, t);
              }
            } catch { /* best-effort hydration — a fresh exchange still works */ }
          }
        } else {
          conversationRef.current = await openConversationSession({ provider: config.provider, model: config.model, credentialRef: config.credentialRef, chatSessionId: sessionRef.current.id, ...(opts?.webSearch ? { webSearch: true } : {}) });
          const openedRunId = conversationRef.current.runId;
          conversationTurnsRef.current = new Map();
          conversationCursorRef.current = 0;
          setSession((s) => ({ ...s, conversationRunId: openedRunId }));
          // Persist the run id server-side (ADR 0067 continuity) so reopening the
          // chat on another device / after the local blob is gone reuses THIS
          // suspended run instead of orphaning it. Ensure the session row exists
          // first (the PUT 404s on an unknown session); both calls are idempotent.
          // Best-effort + persisted-mode only (ephemeral chats keep no BE record).
          if (persist) {
            const sid = sessionRef.current.id;
            const stitle = sessionRef.current.title;
            void (async () => {
              await ensureSessionInBackend(sid, stitle);
              await setConversationRun(sid, openedRunId).catch((e) => {
                // Continuity silently degrades to "fresh run per reopen" (pre-#586
                // behavior) if this never lands — surface it for diagnosis rather
                // than failing the turn.
                console.warn('[chat] failed to persist conversationRunId (reopen continuity degraded)', e);
              });
            })();
          }
        }
      }
      const { runId, nodeId } = conversationRef.current;
      // Stream this exchange's deltas into the optimistic thinking bubble. The
      // animation batcher flushes into `inFlightAssistantIdRef`; point it at the
      // placeholder. Guard on `sequence > startSeq` because the run SSE replays
      // from seq 0 on connect — without it, a prior exchange's deltas would
      // re-type into this bubble. Best-effort: the exchange below reconciles the
      // authoritative turn regardless, so a missed/closed stream just means no
      // live tokens, never a wrong reply.
      inFlightAssistantIdRef.current = thinkingId;
      const startSeq = conversationCursorRef.current;
      // ADR 0079 §Phase 3 — when the backend runs the exchange async, the POST
      // acks BEFORE the reply is emitted (so it rides the SSE past the ~60s CDN
      // ceiling). Resolve `settled` when the agent's authoritative turn — or a
      // terminal error — lands on the stream; the post-ack branch awaits it.
      let resolveSettle: ((s: 'agent' | 'error') => void) | null = null;
      const settled = new Promise<'agent' | 'error'>((res) => { resolveSettle = res; });
      // Holder (not a bare `let`) so control-flow analysis re-widens it after the
      // `await` below — a bare let assigned only inside the closure narrows to `null`.
      const asyncErr: { value: { code?: string; message?: string } | null } = { value: null };
      streamSub = subscribeToRun(runId, {
        modes: ['updates'],
        onEvent: (ev) => {
          const delta = streamDeltaFromEvent(ev, startSeq);
          if (delta !== null) { animation.push(delta); return; }
          // ADR 0089 Phase 2 — render the agent's live tool progress into the
          // in-flight bubble's existing `agentEvents.toolCalls` cards.
          const activity = toolActivityFromEvent(ev, startSeq);
          if (activity) { applyToolActivity(thinkingId, activity, setSession); return; }
          // ADR 0151 — the auto-titler named this conversation; swap the substring
          // placeholder live. A manual rename ('user' provenance) is never emitted,
          // so this only ever replaces a default/auto title.
          const autoTitle = titledFromEvent(ev, startSeq);
          if (autoTitle) { setSession((s) => ({ ...s, title: autoTitle })); return; }
          const signal = exchangeSettleSignal(ev, startSeq);
          if (signal === 'error') { asyncErr.value = exchangeErrorPayload(ev); resolveSettle?.('error'); }
          else if (signal === 'agent') resolveSettle?.('agent');
        },
        onError: () => { /* best-effort streaming — the exchange still reconciles */ },
      });
      // Tail from the cursor: fetch only events past what we've folded, then merge.
      const { turns, lastSeq } = await sendConversationTurn(
        runId, nodeId,
        { content: text, exchangeKey, ...(opts?.activeAgentId ? { to: opts.activeAgentId } : {}), ...(opts?.webSearch !== undefined ? { webSearch: opts.webSearch } : {}), ...(opts?.model ? { model: opts.model } : {}), ...(opts?.provider ? { provider: opts.provider } : {}), ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}) },
        conversationCursorRef.current,
      );
      // A "synchronous" exchange is one whose authoritative AGENT turn is already
      // on the wire — detect THAT, not `lastSeq > cursor`. Under the async path
      // (ADR 0079 §Phase 3 / the ADR 0089 tool loop) the POST acks BEFORE the
      // reply, but transient `ai.message.chunk` deltas have already bumped the
      // sequence; the old `lastSeq > cursor` heuristic mis-read those chunks as a
      // completed turn, advanced the cursor past them, and merged an EMPTY turn
      // set — silently dropping that reply. Across a board cadence (one exchange
      // per advisor) several replies (and the opening question) vanished this way.
      const hasNewAgentTurn = turns.some(
        (t) => t.role === 'agent' && !conversationTurnsRef.current.has(t.messageId),
      );
      if (hasNewAgentTurn) {
        // Synchronous exchange (default) — the user+agent turns are already on
        // the wire; reconcile immediately.
        animation.flush();
        conversationCursorRef.current = lastSeq;
        persistTurns(mergeConversationTurns(turns));
      } else {
        // Async ack — the reply lands later on the SSE. Wait for the settle
        // signal (or a generous timeout matching the backend dispatch budget)
        // BEFORE refetching + merging, so the optimistic user/thinking bubbles
        // aren't erased by a merge over a still-empty wire. NOTE: the cursor is
        // deliberately NOT advanced here — the refetch below must restart from the
        // SAME cursor so it re-reads past the transient chunk events and captures
        // the authoritative `conversation.exchanged` turns.
        const outcome = await Promise.race([
          settled,
          new Promise<'timeout'>((res) => { settleTimer = setTimeout(() => res('timeout'), ASYNC_SETTLE_TIMEOUT_MS); }),
        ]);
        animation.flush();
        if (outcome === 'error') {
          // No POST 4xx to catch — rethrow the terminal event so the shared
          // catch below renders the classified error bubble (preserving the code).
          throw Object.assign(new Error(asyncErr.value?.message ?? i18n.t('chat:replyFailed')), { code: asyncErr.value?.code });
        }
        const tail = await fetchTurns(runId, conversationCursorRef.current);
        if (tail.lastSeq <= conversationCursorRef.current) {
          throw new Error(i18n.t('chat:replyTimedOut'));
        }
        conversationCursorRef.current = tail.lastSeq;
        persistTurns(mergeConversationTurns(tail.turns));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Preserve the wire error CODE so the ErrorCard classifier fires the right
      // card + CTA (e.g. credential_unavailable → "Open BYOK settings"). Without
      // this, every exchange error collapsed to a generic "Something went wrong".
      // Prefer the wire envelope code; fall back to the `.code` an async terminal
      // (`ai.message.error`) rethrow carries (no WopError envelope in that path).
      const code = err instanceof WopError
        ? err.envelope?.error
        : (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined);
      setError(message);
      // Self-heal ONLY when the run itself is dead (closed/cancelled/gone) so the
      // NEXT send opens fresh. Gate on the actual wire CODE — not a message regex:
      // a credential_unavailable message literally contains "expired", which the
      // old regex misread as a dead run and needlessly tore down the conversation.
      const DEAD_RUN_CODES = new Set(['interrupt_already_resolved', 'interrupt_gone', 'run_not_found']);
      const isDeadRun = code ? DEAD_RUN_CODES.has(code) : /resolved|gone|not.?found/i.test(message);
      if (isDeadRun) {
        conversationRef.current = null;
        conversationTurnsRef.current = new Map();
        conversationCursorRef.current = 0;
        setSession((s) => ({ ...s, conversationRunId: undefined }));
      }
      // Mirror the per-turn path's error UX: keep the user's message and append
      // an assistant error bubble (ErrorCard classifies the code, e.g. a BYOK
      // prompt), rather than leaving a dangling user turn with no reply.
      const errBubble: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
        meta: { error: { code: code ?? 'conversation_exchange_failed', message } },
      };
      // Drop the optimistic "thinking" bubble (the reply never landed) and append
      // the error bubble, keeping the user's message.
      setSession((s) => ({ ...s, messages: [...s.messages.filter((m) => m.id !== thinkingId), errBubble] }));
    } finally {
      // Always tear down the delta stream + release the animation target.
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      streamSub?.close();
      inFlightAssistantIdRef.current = null;
    }
  }, [mergeConversationTurns, persistTurns, persist, ensureSessionInBackend]);

  const send = useCallback(async (text: string, config: BYOKActiveConfig, opts?: SendOptions) => {
    // Backend-keyed tab (ADR 0140): if a turn is fired before the one-shot mount-load
    // has hydrated the thread, wait for it. Otherwise this send would open a fresh
    // conversation run that `loadSessionFromBackend` then resets (it nulls
    // `conversationRef`), stranding the turn against the wrong run.
    if (mountLoadRef.current) await mountLoadRef.current;
    setIsSending(true);
    setThinkingAgentIdState(opts?.activeAgentId ?? null);
    setError(null);

    // The RFC 0005 conversation primitive is the SOLE chat transport. The
    // per-turn `openwop-app.chat.turn` fallback was retired in ADR 0067 Phase 6
    // (parity + telemetry clean); the backend workflow is kept ONLY so historical
    // per-turn runs still replay/fork (the wire contract), not for new sends.
    await sendViaConversation(text, config, opts);
    setIsSending(false);
  }, [sendViaConversation]);

  const cancel = useCallback(async () => {
    // NOTE: `inFlightRunIdRef` is populated only by the @mention workflow-run path
    // (`runWorkflowMention`); `sendViaConversation` does not set it (cancelling the
    // long-lived conversation run would tear down the whole thread, not the one
    // in-flight exchange). So Stop is a no-op mid-chat-exchange — aborting a single
    // conversation `exchange` is a tracked follow-up (ADR 0067), not part of Phase 6.
    const runId = inFlightRunIdRef.current;
    if (!runId) return;
    // Close the SSE subscription immediately so further deltas don't
    // arrive after the user clicked Stop. Flush any buffered animation
    // tail first so it lands in the bubble. The BE's cancelRun call
    // races in parallel — whichever finishes first wins.
    animation.flush();
    subRef.current?.close();
    subRef.current = null;
    try {
      await cancelRun(runId, 'cancelled by user from chat');
    } catch (err) {
      // Cancel failed (run already terminal, network blip, etc.) —
      // still surface a friendly cancellation in the bubble.
      setError(err instanceof Error ? err.message : String(err));
    }
    const assistantId = inFlightAssistantIdRef.current;
    if (assistantId) {
      setSession((s) => ({
        ...s,
        messages: s.messages.map((m) => m.id === assistantId ? {
          ...m,
          isStreaming: false,
          meta: { ...(m.meta ?? {}), error: { code: 'cancelled', message: i18n.t('chat:stoppedByUser') }, runId: runId },
        } : m),
      }));
    }
    inFlightRunIdRef.current = null;
    inFlightAssistantIdRef.current = null;
    setIsSending(false);
    // animation's methods are ref-backed useCallbacks (stable); cancel reads
    // only refs + setIsSending. No reactive deps. (GAP-ANALYSIS code-review)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emitSystem = useCallback((content: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'system',
      content,
      createdAt: new Date().toISOString(),
    };
    setSession((s) => chatSessionReducer(s, { type: 'appendMessage', message: msg }));
  }, []);

  const reset = useCallback(() => {
    subRef.current?.close();
    closeAllWorkflowSubs(); // leaving the session — stop its self-healing run subs
    // Close the conversation run for the prior session, if any.
    if (conversationRef.current) {
      void closeConversationSession(conversationRef.current.runId, conversationRef.current.nodeId);
      conversationRef.current = null;
    }
    // Drop the tailing accumulator + cursor so the next conversation starts clean.
    conversationTurnsRef.current = new Map();
    conversationCursorRef.current = 0;
    const fresh: ChatSession = {
      id: crypto.randomUUID(),
      title: i18n.t('chat:newChat'),
      messages: [],
      createdAt: new Date().toISOString(),
    };
    // Clear write-through dedup state. The fresh sessionId has no
    // messages persisted yet; the new title belongs to a session that
    // doesn't exist in BE yet (ensureSessionInBackend will create it
    // on the first send).
    persistedIdsRef.current = new Set();
    // A fresh chat has no backend history to page.
    olderCursorRef.current = null;
    setHasOlderMessages(false);
    if (persist) persistSession(fresh, { writeCurrentCache: useCurrentCache });
    setSession(fresh);
    setError(null);
    setIsSending(false);
    // Backend-keyed tab (ADR 0140): "new chat in this tab" mints a fresh id, so the
    // hook's identity diverges from the bound `sessionId`. Tell the tab container to
    // re-key the tab to the new id — otherwise a later reload/deep-link would reopen
    // the OLD (now-abandoned) conversation. The singleton/ephemeral callers pass no
    // handler, so this is a no-op for them.
    if (backendKeyed) {
      onSessionIdChange?.(fresh.id);
      // ONLY a backend-keyed tab eagerly creates the BE row, and only because the
      // re-key above REMOUNTS the tab (key={sessionId}) and re-fires its one-shot
      // mount-load against the new id; without the row that load 404s and triggers
      // the unbounded remount→404→re-key loop guarded in loadSessionFromBackend's
      // not_found recovery. The SINGLETON main chat has no remount, so it does NOT
      // create anything here — it defers to the first send (ensureSessionInBackend
      // runs in sendViaConversation / persistMessage). An unused "New chat" therefore
      // never writes an empty messageCount:0 conversation into the history rail.
      if (persist) void ensureSessionInBackend(fresh.id, fresh.title);
    }
  }, [ensureSessionInBackend, persist, useCurrentCache, backendKeyed, onSessionIdChange]);

  const resolveInterrupt = useCallback(async (messageId: string, value: unknown, nodeId?: string) => {
    // Read latest session from the ref so this stable callback doesn't depend
    // on `session` (which would invalidate it on every message tick). The
    // decision logic lives in the pure planInterruptResolution (tested).
    // `nodeId` selects WHICH open interrupt to resolve — a message can carry
    // several at once when a workflow fans out into parallel human gates.
    const plan = planInterruptResolution(sessionRef.current, messageId, nodeId);
    if (!plan) {
      // Nothing actionable for this target — leave any other open cards alone.
      return;
    }
    const targetNode = plan.nodeId;
    // Optimistically drop ONLY the resolved card for immediate feedback; the BE
    // call + SSE reconcile happen below. Sibling gates stay open.
    setSession((s) => chatSessionReducer(s, {
      type: 'updateMessage',
      id: messageId,
      patch: { activeInterrupts: removeInterruptByNode(
        s.messages.find((m) => m.id === messageId)?.activeInterrupts, targetNode) },
    }));
    try {
      await resolveByRun(plan.runId, targetNode, value);
    } catch (err) {
      // Resume failed — restore just this interrupt so the user can retry. Via
      // the reducer's id-scoped update so a concurrent SSE write to other
      // fields on the same message is preserved.
      const message = err instanceof Error ? err.message : String(err);
      setSession((s) => {
        const existing = s.messages.find((m) => m.id === messageId)?.activeInterrupts ?? [];
        const restored = existing.some((i) => i.nodeId === targetNode)
          ? existing
          : [...existing, plan.interrupt];
        return chatSessionReducer(s, { type: 'updateMessage', id: messageId, patch: { activeInterrupts: restored } });
      });
      setError(`Could not resolve interrupt: ${message}`);
    }
  }, []);

  const loadSessionFromBackend = useCallback(async (sessionId: string) => {
    // Cancel anything in flight on the current session before switching.
    subRef.current?.close();
    subRef.current = null;
    closeAllWorkflowSubs(); // switching sessions — stop the old run's self-healing subs
    inFlightRunIdRef.current = null;
    inFlightAssistantIdRef.current = null;
    // Drop the PRIOR session's conversation run + turn accumulator (do NOT close
    // that run — it belongs to the other chat and stays valid). Without this, the
    // next send would reuse the previous conversation's run (appending into the
    // wrong thread) and merge into its stale turn accumulator. THIS session's own
    // conversationRunId is restored from the load response below, so continuing it
    // reuses its suspended run (server-side context preserved) — not a fresh one.
    conversationRef.current = null;
    conversationTurnsRef.current = new Map();
    conversationCursorRef.current = 0;
    setIsSending(false);
    setError(null);
    try {
      // Load only the most-recent page; older messages page in on demand via
      // `loadEarlierMessages` (ADR 0043 Phase 3b). The thread comes back ASC.
      const page = await listChatSessionMessagesPage(sessionId, { limit: MESSAGE_PAGE_SIZE });
      const messages = parsePersistedMessages(page.messages);
      olderCursorRef.current = page.nextCursor;
      setHasOlderMessages(page.nextCursor !== null);
      const next: ChatSession = {
        id: sessionId,
        // The drawer holds the authoritative title; on reload we use a
        // placeholder until the next persistSession() picks it up.
        title: i18n.t('chat:savedChat'),
        messages,
        createdAt: page.messages[0]?.createdAt ?? new Date().toISOString(),
        // `activeAgents` deliberately omitted HERE — the lineup is now DERIVED
        // from the conversation's server-side `participants` by the caller
        // (`ChatSidebar.selectConversation` → `activeAgents.setLineup`,
        // ADR 0043), so it reconstructs on any device rather than living only in
        // this session record. Leaving it unset means a fresh load starts empty
        // until that derive runs; same-browser reloads of the CURRENT session
        // still restore instantly via `persistSession` → localStorage.
        //
        // Restore the conversation RUN id (ADR 0067 continuity) recorded
        // server-side: continuing this reopened chat reuses its suspended run
        // (server-side agent context preserved) instead of opening a fresh one.
        ...(page.conversationRunId ? { conversationRunId: page.conversationRunId } : {}),
      };
      // Mark every loaded id as already-persisted so subsequent appends
      // dedup correctly. The session itself is known to exist in BE
      // since we just listed its messages.
      persistedIdsRef.current = new Set(messages.map((m) => m.id));
      backendSessionsRef.current.add(sessionId);
      if (persist) persistSession(next, { writeCurrentCache: useCurrentCache });
      setSession(next);
      // Re-attach to any non-terminal workflow_run in the reopened thread so its
      // cards + HITL gate come back live (rebuilt from the log + resumed SSE),
      // not frozen at the persisted snapshot. Via the ref — the real callback is
      // declared below this one.
      rehydrateWorkflowRunsRef.current(next);
      // Re-display the caller's 👍/👎 on the restored thread (ADR 0102 Phase 3) —
      // feedback lives server-side keyed by the now-unified message id, but the FE
      // never loaded it on open, so it vanished on reopen. Best-effort + guarded
      // against a fast session-switch landing stale ratings on the wrong thread.
      void getSessionFeedback(sessionId).then((ratings) => {
        if (Object.keys(ratings).length === 0) return;
        setSession((s) => (s.id !== sessionId ? s : {
          ...s,
          messages: s.messages.map((m) => {
            const fb = ratings[m.id] === 'up' ? 'positive' : ratings[m.id] === 'down' ? 'negative' : null;
            return fb && m.feedback !== fb ? { ...m, feedback: fb } : m;
          }),
        }));
      }).catch(() => { /* best-effort */ });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A stale session id — the conversation is scoped to a tenant the caller no
      // longer matches (an expired/rotated anon session, a workspace switch, or an
      // identity change). The data is NOT lost, just invisible here. The client
      // prefixes the backend error code, so a missing/invisible session reads as
      // `not_found: chat_session "…" not found.`. Recover by opening a fresh chat
      // (and, in a backend-keyed tab, re-keying it) instead of dead-ending the user
      // on a raw error they can do nothing about.
      if (message.startsWith('not_found:')) {
        backendSessionsRef.current.delete(sessionId);
        persistedIdsRef.current = new Set();
        olderCursorRef.current = null;
        setHasOlderMessages(false);
        const fresh = freshSession();
        if (persist) persistSession(fresh, { writeCurrentCache: useCurrentCache });
        setSession(fresh);
        setError(null);
        if (backendKeyed) {
          // A backend-keyed tab re-keys to the fresh id (otherwise a reload/deep-link
          // reopens the dead conversation). CRITICAL: eagerly create that fresh session
          // server-side first — exactly as reset() does. Re-keying remounts the tab
          // (key={sessionId}), which re-fires this one-shot mount-load against the new
          // id; if that id has no backend row it 404s again and re-keys again — an
          // unbounded remount→404→re-key loop (the "hundreds of 404s"). Creating it up
          // front means the remount's load resolves 200 and the loop terminates.
          if (persist) void ensureSessionInBackend(fresh.id, fresh.title);
          onSessionIdChange?.(fresh.id);
        }
        return;
      }
      setError(message);
    }
  }, [ensureSessionInBackend, persist, useCurrentCache, backendKeyed, onSessionIdChange]);

  // Multi-tab (ADR 0140): a backend-keyed tab hydrates its thread from the BE once
  // on mount — it deliberately did NOT read the singleton localStorage cache, so the
  // initial session is an empty placeholder under the bound id. One-shot (the ref is
  // set synchronously before the await, so a StrictMode double-invoke is a no-op).
  // The promise is parked (in `mountLoadRef`, declared up with the other refs) so
  // `send` can await it (a turn fired before the load resolves would otherwise open
  // a conversation run that the load then discards).
  useEffect(() => {
    if (!backendKeyedSessionId || didMountLoadRef.current) return;
    didMountLoadRef.current = true;
    mountLoadRef.current = loadSessionFromBackend(backendKeyedSessionId)
      .finally(() => { mountLoadRef.current = null; setIsHydrating(false); });
  }, [backendKeyedSessionId, loadSessionFromBackend]);

  /** Page the next-older batch of messages into the loaded thread and PREPEND
   *  them (ADR 0043 Phase 3b). No-op when nothing older remains or a page is
   *  already in flight. New ids are merged into the persisted-id set so a later
   *  append still dedups; ids already present are skipped (idempotent). */
  const loadEarlierMessages = useCallback(async () => {
    const cursor = olderCursorRef.current;
    if (cursor === null || isLoadingEarlier) return;
    setIsLoadingEarlier(true);
    try {
      const sessionId = sessionRef.current.id;
      const page = await listChatSessionMessagesPage(sessionId, { limit: MESSAGE_PAGE_SIZE, before: cursor });
      const older = parsePersistedMessages(page.messages);
      olderCursorRef.current = page.nextCursor;
      setHasOlderMessages(page.nextCursor !== null);
      if (older.length > 0) {
        for (const m of older) persistedIdsRef.current.add(m.id);
        setSession((s) => {
          const have = new Set(s.messages.map((m) => m.id));
          const fresh = older.filter((m) => !have.has(m.id));
          return fresh.length > 0 ? { ...s, messages: [...fresh, ...s.messages] } : s;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingEarlier(false);
    }
  }, [isLoadingEarlier]);

  const setFeedback = useCallback((messageId: string, feedback: 'positive' | 'negative' | null) => {
    // Optimistic local update for instant UX...
    setSession((s) => chatSessionReducer(s, { type: 'setFeedback', id: messageId, feedback }));
    // ...then persist server-side (ADR 0071) so feedback survives reload + feeds
    // quality metrics — no longer only in local ChatMessage.feedback. Best-effort:
    // a failure (e.g. the session isn't persisted yet) keeps the optimistic state.
    const rating = feedback === 'positive' ? 'up' : feedback === 'negative' ? 'down' : 'neutral';
    void setMessageFeedback(messageId, sessionRef.current.id, rating).catch(() => { /* best-effort */ });
  }, []);

  // `send` is declared above but referenced in the regenerate closure;
  // keep this useCallback inside the hook so it picks up the latest
  // `session`/`send` bindings on each render.
  //
  // APPEND, don't replace (architect verdict): the RFC 0005 conversation run is an
  // append-only, linear log (turns are immutable; replay re-folds them), and the
  // spec deliberately rejected in-conversation branching for v1.x (RFC 0005 §195).
  // The old slice-and-replace fought that grain — it dropped the assistant bubble
  // LOCALLY while the run event log + the chat-message store kept it, so the turn
  // resurfaced on the next merge (live) and on hydration (reload). "Try again" is
  // therefore a fresh exchange of the same prompt, APPENDED — correct across every
  // persistence/restore/hydration path, no drift, no tombstone, no wire change.
  // (True "compare answers" is the spec's sibling-conversation mechanism — a
  // separate future feature, not this button.)
  const regenerate = useCallback(async (messageId: string, config: BYOKActiveConfig) => {
    if (isSending) return; // a turn is already in flight
    const idx = session.messages.findIndex((m) => m.id === messageId);
    if (idx < 1) return;
    const assistant = session.messages[idx];
    const prior = session.messages[idx - 1];
    if (!assistant || assistant.role !== 'assistant') return;
    if (!prior || prior.role !== 'user') return;
    const priorText = messageText(prior);
    if (!priorText) return;
    await send(priorText, config);
  }, [isSending, session.messages, send]);

  /** Update a single `workflow_run` message's `workflowRun` state. */
  const updateWorkflowRun = useCallback((
    messageId: string,
    patch: (prev: WorkflowRunState) => WorkflowRunState,
  ): void => {
    setSession((s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.id !== messageId || !m.workflowRun) return m;
        return { ...m, workflowRun: patch(m.workflowRun) };
      }),
    }));
  }, []);

  /** Close + remove a workflow_run's SSE subscription. Safe to call
   *  even if the entry is missing (no-op). */
  function closeWorkflowSub(messageId: string): void {
    const sub = workflowSubsRef.current.get(messageId);
    if (!sub) return;
    sub.close();
    workflowSubsRef.current.delete(messageId);
  }

  /** Tear down EVERY workflow_run subscription for the current session and
   *  empty the registry. Called on unmount and whenever we leave a session
   *  (reset / loadSessionFromBackend). This is load-bearing now that the subs
   *  self-heal: an orphaned sub used to die on its own at the idle/absolute
   *  timeout, but a self-healing one would re-subscribe forever in the
   *  background for an abandoned session. Clearing the map also disarms any
   *  in-flight `heal()` — its identity guard sees the entry is gone. */
  function closeAllWorkflowSubs(): void {
    for (const sub of workflowSubsRef.current.values()) sub.close();
    workflowSubsRef.current.clear();
  }

  /** Open a SELF-HEALING SSE subscription for a workflow_run message: on a stream
   *  timeout/error, reconcile from the authoritative event log then re-subscribe
   *  unless the run terminated (retries bounded when the backend is unreachable;
   *  a successful poll resets the budget so a merely-idle HITL run heals forever).
   *  The identity guard ignores a stale timeout fired after the user cancelled /
   *  switched sessions / a newer sub replaced this one. Shared by the live dispatch
   *  path AND reopen rehydration. */
  const subscribeWorkflowRun = useCallback((ctx: WorkflowRunHandlerContext): void => {
    const { runId, runMsgId } = ctx;
    const MAX_HEAL_FAILURES = 5;
    let healFailures = 0;
    const openSub = (): void => {
      const sub = subscribeToRun(runId, {
        modes: ['updates'],
        idleTimeoutMs: 5 * 60_000,
        absoluteTimeoutMs: 30 * 60_000,
        ...makeWorkflowRunHandlers(ctx),
        onTimeout: () => { void heal(sub); },
        onError: () => { void heal(sub); },
      });
      workflowSubsRef.current.set(runMsgId, sub);
    };
    const heal = async (deadSub: Subscription): Promise<void> => {
      if (workflowSubsRef.current.get(runMsgId) !== deadSub) return;
      const { terminal, polled } = await reconcileWorkflowRunFromLog(ctx);
      if (terminal) return; // reconcile finalized + closed the sub
      if (polled) healFailures = 0;
      else if (++healFailures > MAX_HEAL_FAILURES) return;
      if (workflowSubsRef.current.get(runMsgId) !== deadSub) return;
      openSub();
    };
    openSub();
  }, []);

  /** Re-attach to every NON-terminal workflow_run in a (re)loaded session: rebuild
   *  its node cards + HITL interrupt from the authoritative event log, then RESUME
   *  live streaming unless it already finished. Makes a chat reopened from the rail
   *  continue live — the suspended HITL card is refreshed + actionable and
   *  post-resume progress streams, instead of freezing at the persisted snapshot.
   *  Idempotent: skips runs already subscribed (a same-browser current session keeps
   *  its live subs). */
  const rehydrateWorkflowRuns = useCallback((sess: ChatSession): void => {
    for (const m of sess.messages) {
      if (m.role !== 'workflow_run') continue;
      const wf = m.workflowRun;
      const runId = wf?.runId;
      if (!runId) continue;
      if (wf.status === 'completed' || wf.status === 'failed' || wf.status === 'cancelled') continue;
      if (workflowSubsRef.current.has(m.id)) continue; // already live
      const ctx: WorkflowRunHandlerContext = {
        runId, runMsgId: m.id, setSession, persistMessage: persistOrUpdateMessage,
        sessionId: sess.id, sessionTitle: sess.title, updateWorkflowRun, closeWorkflowSub,
      };
      void (async () => {
        // Rebuild cards + interrupts from the log first; subscribe only if the run
        // is still live (reconcile finalizes + skips the sub for a terminal run).
        const { terminal } = await reconcileWorkflowRunFromLog(ctx);
        if (!terminal && !workflowSubsRef.current.has(m.id)) subscribeWorkflowRun(ctx);
      })();
    }
    // closeWorkflowSub is a stable hoisted fn; setSession is stable. (matches the
    // runWorkflowMention pattern.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistOrUpdateMessage, updateWorkflowRun, subscribeWorkflowRun]);

  // Expose rehydrateWorkflowRuns to the earlier-declared mount effect +
  // loadSessionFromBackend via the ref (avoids a forward reference).
  rehydrateWorkflowRunsRef.current = rehydrateWorkflowRuns;

  /** Built-in fallback inputs for hardcoded sample.* workflows that
   *  ship without a SavedWorkflow defaultInputs blob. Keeps `@uppercase`
   *  from dispatching with an empty `inputs.text` and silently emitting
   *  an empty string. */
  const runWorkflowMention = useCallback(async (entry: WorkflowMentionEntry, trailing?: string) => {
    setError(null);
    // Preserve what the user actually typed so the chat history shows
    // `/hello-uppercase hello` (their intent) and not just the slug.
    //
    // Symbol: `/` post-2026-05-28 mention-symbol swap. `@` now opens
    // the agents picker and goes through the agent-activation path
    // (phase D3), not the workflow dispatch path. Old persisted chat
    // history keeps showing `@slug` for workflows dispatched before
    // the swap — acceptable historical artifact; the wire content is
    // opaque to the BE.
    const trimmedTrailing = trailing?.trim() ?? '';
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmedTrailing.length > 0 ? `/${entry.slug} ${trimmedTrailing}` : `/${entry.slug}`,
      createdAt: new Date().toISOString(),
    };
    const runMsgId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Builder-saved workflows live in localStorage and need to be
    // registered with the backend's in-memory catalog before /v1/runs
    // resolves them. Hardcoded `sample.*` workflows are already in the
    // catalog — skip registration and node-name population.
    const isBuilderWorkflow = entry.workflowId.startsWith('wf_');
    const saved = isBuilderWorkflow ? getSavedWorkflow(entry.workflowId) : undefined;
    if (isBuilderWorkflow && !saved) {
      // The mention pointed to a workflow that's no longer in localStorage.
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'system',
        content: i18n.t('chat:workflowDeleted', { name: entry.displayName }),
        createdAt: new Date().toISOString(),
      };
      // Title-on-first-message + write-through, mirroring `send()` at
      // line 562-572 — without this, an @mention is the only chat
      // entry-point that leaves the session unpersisted, so the
      // history drawer keeps showing "New chat — 0 messages" forever
      // even after the workflow completes.
      const userText = typeof userMsg.content === 'string' ? userMsg.content : `@${entry.slug}`;
      const deletedTitle = session.messages.length === 0 ? userText.slice(0, 60) : session.title;
      setSession((s) => ({
        ...s,
        title: s.messages.length === 0 ? userText.slice(0, 60) : s.title,
        messages: [...s.messages, userMsg, msg],
      }));
      void persistMessage(session.id, deletedTitle, userMsg);
      void persistMessage(session.id, deletedTitle, msg);
      return;
    }

    // Build nodeId → friendly-name map for "running step N of M — <name>".
    // Mirrors serialize.ts:174 nodeId pattern: `${sanitizedKind}_${index}`.
    const nodeNames: Record<string, string> = {};
    let totalNodes = 0;
    let inputs: Record<string, unknown> = SAMPLE_DEFAULT_INPUTS[entry.workflowId] ?? {};
    if (saved) {
      totalNodes = saved.nodes.length;
      saved.nodes.forEach((n, i) => {
        const safeKind = n.kind.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
        nodeNames[`${safeKind}_${i}`] = n.name;
      });
      const raw = saved.defaultInputs?.trim();
      if (raw) {
        try { inputs = JSON.parse(raw) as Record<string, unknown>; } catch { /* empty */ }
      }
    }
    // User typed `/<slug> some text` — override the first key of the
    // resolved inputs object with that text. Keeps the workflow's
    // remaining defaults (e.g., a `tone` knob, a `length` cap) so the
    // user gets to swap the obvious "what do I send" field without
    // having to re-author the whole inputs JSON.
    //
    // If the workflow has no defaultInputs we synthesize `{ text: ... }`
    // since the two ports a sample workflow commonly accepts are
    // `text` (uppercase, etl-extractor) and `prompt` (mock-ai).
    if (trimmedTrailing.length > 0) {
      const keys = Object.keys(inputs);
      if (keys.length > 0) {
        const firstKey = keys[0]!;
        inputs = { ...inputs, [firstKey]: trimmedTrailing };
      } else {
        inputs = { text: trimmedTrailing };
      }
    }

    const initial: WorkflowRunState = {
      slug: entry.slug,
      workflowName: entry.displayName,
      workflowId: entry.workflowId,
      runId: null,
      status: 'pending',
      totalNodes,
      completedNodeIds: [],
      failedNodeIds: [],
      nodeOutputs: {},
      currentNodeName: null,
      nodeNames,
      startedAt,
    };
    const runMsg: ChatMessage = {
      id: runMsgId,
      role: 'workflow_run',
      content: `/${entry.slug} — starting…`,
      createdAt: startedAt,
      workflowRun: initial,
    };
    // Title-on-first-message + write-through, mirroring `send()` at
    // line 562-572. Without this, the @mention chat path is the only
    // entry-point that never persists, so the history drawer always
    // shows "New chat — 0 messages" for chats that only contain
    // workflow runs.
    //
    // We compute `nextTitle` synchronously from the same closure-time
    // `session` that `setSession` will read, so the persist call sees
    // the same value the local state lands on. `userMsg.content` is
    // always a plain string for @mentions (no attachments are
    // composed into a mention dispatch), but the `ChatMessage.content`
    // union is `string | ContentPart[]` — narrow it explicitly so the
    // `title: string` field stays typed.
    const userText = typeof userMsg.content === 'string' ? userMsg.content : `@${entry.slug}`;
    const nextTitle = session.messages.length === 0 ? userText.slice(0, 60) : session.title;
    setSession((s) => ({
      ...s,
      title: s.messages.length === 0 ? userText.slice(0, 60) : s.title,
      messages: [...s.messages, userMsg, runMsg],
    }));
    void persistMessage(session.id, nextTitle, userMsg);
    // The workflow_run message persists at terminal (run.completed /
    // failed / cancelled) below — its `workflowRun` state grows
    // throughout the run, so we want the final shape on disk, not the
    // empty "starting…" snapshot.

    let runId: string;
    try {
      if (saved) {
        // Lazy-load the builder serializer here (only reached when a user runs a
        // saved /wf_… workflow): it statically pulls builder/palette/catalogRegistry,
        // which has no business in the first-paint chat entry chunk.
        const [{ serializeWorkflow }, { registerWorkflow }] = await Promise.all([
          import('../../builder/schema/serialize.js'),
          import('../../builder/persistence/registerClient.js'),
        ]);
        const def = serializeWorkflow(saved);
        await registerWorkflow(def);
      }
      const created = await createRun(
        {
          workflowId: entry.workflowId,
          // Same as the chat-turn createRun above: omit body.tenantId
          // so the BE infers from the authenticated session.
          inputs,
          metadata: { chatSessionId: session.id, chatMessageId: runMsgId, mentionSlug: entry.slug },
        },
        // Per spec/v1/idempotency.md Layer 1: `runMsgId` is generated
        // once per `runWorkflowMention()` invocation and persisted on
        // the workflow_run message. A page refresh or SDK retry that
        // re-submits with this key will collapse onto the original
        // run server-side instead of creating a duplicate.
        { idempotencyKey: runMsgId },
      );
      runId = created.runId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      let finalizedFailed: ChatMessage | null = null;
      setSession((s) => {
        const next = s.messages.map((m) => {
          if (m.id !== runMsgId || !m.workflowRun) return m;
          const updated: ChatMessage = {
            ...m,
            workflowRun: {
              ...m.workflowRun,
              status: 'failed',
              error: { code: 'dispatch_failed', message: msg },
            },
          };
          finalizedFailed = updated;
          return updated;
        });
        return { ...s, messages: next };
      });
      // Persist the dispatch-failed run-bubble so the drawer shows
      // *something* even when /v1/runs never produced a runId.
      if (finalizedFailed) void persistMessage(session.id, nextTitle, finalizedFailed);
      setError(msg);
      return;
    }

    updateWorkflowRun(runMsgId, (prev) => ({ ...prev, runId, status: 'running' }));
    // Persist the running snapshot NOW (not just at terminal): a run that suspends
    // at a HITL gate is never terminal, so without an early write the whole
    // workflow_run card + its node cards + the interrupt card vanished on reopen.
    // `persistOrUpdateMessage` upserts, so the suspend/terminal handlers re-save
    // the evolving state onto this same message.
    void persistOrUpdateMessage(session.id, nextTitle, { ...runMsg, workflowRun: { ...initial, runId, status: 'running' } });

    const ctx = {
      runId,
      runMsgId,
      setSession,
      // Upsert — the run-backed message is re-saved as its state evolves.
      persistMessage: persistOrUpdateMessage,
      sessionId: session.id,
      sessionTitle: nextTitle,
      updateWorkflowRun,
      closeWorkflowSub,
    };

    // Open the self-healing live subscription (extracted so reopen-rehydration
    // reuses the exact same timeout/reconnect/reconcile behavior).
    subscribeWorkflowRun(ctx);
  }, [session.id, session.title, session.messages.length, updateWorkflowRun, persistMessage, persistOrUpdateMessage, subscribeWorkflowRun]);

  const cancelWorkflowRun = useCallback(async (messageId: string) => {
    const msg = session.messages.find((m) => m.id === messageId);
    const runId = msg?.workflowRun?.runId;
    if (!runId || msg?.workflowRun?.status !== 'running') return;
    try {
      await cancelRun(runId, 'User cancelled from chat.');
      // The backend's run.cancelled event will flip the status + close
      // the SSE subscription via the existing terminal-event handler.
      // Optimistic UI: nothing to do here — the bubble updates on the
      // event arriving.
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      updateWorkflowRun(messageId, (prev) => ({
        ...prev,
        status: 'failed',
        error: { code: 'cancel_failed', message: m },
      }));
      closeWorkflowSub(messageId);
    }
  }, [session.messages, updateWorkflowRun]);

  // The useActiveAgents call is unconditional, so rule-of-hooks holds.
  // Placement here (vs at the top of the function) keeps the active-agents
  // API logically grouped with the chat-session result it's exposed on.
  const activeAgents = useActiveAgents(session, setSession);

  return {
    session,
    isSending,
    isHydrating,
    thinkingAgentId: isSending ? thinkingAgentIdState : null,
    error,
    send,
    cancel,
    emitSystem,
    reset,
    resolveInterrupt,
    runWorkflowMention,
    cancelWorkflowRun,
    regenerate,
    setFeedback,
    loadSessionFromBackend,
    hasOlderMessages,
    isLoadingEarlier,
    loadEarlierMessages,
    activeAgents,
  };
}
