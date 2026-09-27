/**
 * The shared mutable core of the chat-session hook family (ADR 0327 P2).
 *
 * Owns EVERY piece of state + every ref the composed hooks share (session,
 * in-flight markers, the conversation-run accumulator, workflow-run subs,
 * write-through dedup sets, pagination cursors), the delta-animation batcher,
 * and the localStorage persist effect. Internal to `useChatSession` — never
 * import this from outside `hooks/chatSession/`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApplyAnimation } from '../useApplyAnimation.js';
import { useStorageSubject } from '../../../platform/useStorageSubject.js';
import type { Subscription } from '../../../client/streamsClient.js';
import type { ConversationTurn } from '../../conversationClient.js';
import { loadSession, persistSession, freshSession } from '../../lib/chatPersistence.js';
import type { ChatSession } from '../../types.js';

export interface UseChatSessionOpts {
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
}

export function useChatSessionCore(opts: UseChatSessionOpts) {
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
  /** Mirror of `isSending` for the IDN-11 settle guard below — read-only, and a
   *  ref so the guard does not re-run every time a turn starts or finishes. */
  const isSendingRef = useRef(isSending);
  useEffect(() => { isSendingRef.current = isSending; }, [isSending]);
  // Reverse-pagination state for the loaded thread (ADR 0043 Phase 3b). The
  // cursor points at the oldest message currently held; null means we're at the
  // start of history (or the session was never paged — a fresh/local chat).
  const olderCursorRef = useRef<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const subRef = useRef<Subscription | null>(null);
  // GRADE-2 — monotonic load epoch; only the newest loadSessionFromBackend call
  // may mutate state after its await (a slower, older load must lose the race).
  const loadEpochRef = useRef(0);
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

  // ADR 0434 / IDN-3 boot-window tri-state (IDN-11) — the LAST `content`
  // consumer, and the one that could not just re-read.
  //
  // The singleton main chat seeds `session` from `loadSession()` in a `useState`
  // INITIALIZER (above), which runs once, during the auth boot window, against
  // the storage subject as it stood then — i.e. the anonymous key. When auth
  // settles a moment later, nothing re-reads, so a returning signed-in user can
  // sit on the anonymous thread.
  //
  // A naive re-read on settle is exactly the clobber this was deferred for: it
  // would discard an in-flight thread. So the re-read is guarded to the case
  // where there is provably NOTHING to lose — the session is still empty and
  // idle. That is precisely the boot-window shape (the user has not typed yet)
  // and excludes every state where a message exists or a turn is in flight.
  // Backend-keyed tabs are excluded outright: they are reconciled from the
  // server by `loadSessionFromBackend`, which is authority, not this cache.
  const subjectState = useStorageSubject();
  const subjectKey = subjectState.status === 'user' ? subjectState.subject : subjectState.status;
  const reseedGuard = useRef(subjectKey);
  useEffect(() => {
    if (reseedGuard.current === subjectKey) return;
    // `subjectKey` is 'pending' exactly when the tri-state is pending, so this
    // one comparison covers the boot window — no separate `status` dependency.
    if (subjectKey === 'pending') return;
    reseedGuard.current = subjectKey;
    if (!persist || backendKeyed) return;
    const current = sessionRef.current;
    if (current.messages.length > 0) return; // a real thread — never discard it
    if (isSendingRef.current) return;         // a turn is in flight
    setSession(loadSession());
  }, [subjectKey, persist, backendKeyed]);

  /** Close + remove a workflow_run's SSE subscription. Safe to call
   *  even if the entry is missing (no-op). Stable (ref-only) so dependent
   *  callbacks in the composed hooks keep their original identities. */
  const closeWorkflowSub = useCallback((messageId: string): void => {
    const sub = workflowSubsRef.current.get(messageId);
    if (!sub) return;
    sub.close();
    workflowSubsRef.current.delete(messageId);
  }, []);

  /** Tear down EVERY workflow_run subscription for the current session and
   *  empty the registry. Called on unmount and whenever we leave a session
   *  (reset / loadSessionFromBackend). This is load-bearing now that the subs
   *  self-heal: an orphaned sub used to die on its own at the idle/absolute
   *  timeout, but a self-healing one would re-subscribe forever in the
   *  background for an abandoned session. Clearing the map also disarms any
   *  in-flight `heal()` — its identity guard sees the entry is gone. */
  const closeAllWorkflowSubs = useCallback((): void => {
    for (const sub of workflowSubsRef.current.values()) sub.close();
    workflowSubsRef.current.clear();
  }, []);

  return {
    // resolved options
    persist, backendKeyedSessionId, backendKeyed, useCurrentCache, onSessionIdChange,
    // state
    session, setSession, isSending, setIsSending, isHydrating, setIsHydrating,
    thinkingAgentIdState, setThinkingAgentIdState, error, setError,
    hasOlderMessages, setHasOlderMessages, isLoadingEarlier, setIsLoadingEarlier,
    // refs
    sessionRef, olderCursorRef, subRef, loadEpochRef, inFlightRunIdRef,
    inFlightAssistantIdRef, conversationRef, conversationTurnsRef,
    conversationCursorRef, workflowSubsRef, rehydrateWorkflowRunsRef,
    backendSessionsRef, persistedIdsRef, didMountLoadRef, mountLoadRef,
    // shared machinery
    animation, closeWorkflowSub, closeAllWorkflowSubs,
  };
}

export type ChatSessionCore = ReturnType<typeof useChatSessionCore>;
