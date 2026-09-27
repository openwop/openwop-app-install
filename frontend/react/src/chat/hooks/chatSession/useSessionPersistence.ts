/**
 * Write-through persistence + session lifecycle for the chat session
 * (ADR 0327 P2 — the ADR's `useSessionPersistence`).
 *
 * Owns: lazy backend session creation, best-effort message write-through
 * (append + upsert), reset (branch to a fresh chat), the backend session
 * switch (`loadSessionFromBackend` + the backend-keyed one-shot mount load),
 * reverse pagination (`loadEarlierMessages`), and feedback persistence.
 */

import { useCallback, useEffect } from 'react';
import i18n from '../../../i18n/index.js';
import {
  appendChatMessage,
  createChatSession,
  getSessionFeedback,
  listChatSessionMessagesPage,
  updateChatMessage,
} from '../../../client/chatSessionsClient.js';
import { closeConversationSession } from '../../conversationTransport.js';
import { persistSession, freshSession } from '../../lib/chatPersistence.js';
import { chatSessionReducer } from '../../lib/chatSessionReducer.js';
import { setMessageFeedback } from '../../state/messageFeedbackClient.js';
import type { ChatMessage, ChatSession } from '../../types.js';
import type { ChatSessionCore } from './core.js';
import { MESSAGE_PAGE_SIZE, parsePersistedMessages } from './lib.js';

export function useSessionPersistence(core: ChatSessionCore) {
  const {
    persist, useCurrentCache, backendKeyed, backendKeyedSessionId, onSessionIdChange,
    setSession, setError, setIsSending, setIsHydrating,
    setHasOlderMessages, isLoadingEarlier, setIsLoadingEarlier,
    sessionRef, olderCursorRef, subRef, loadEpochRef, inFlightRunIdRef,
    inFlightAssistantIdRef, conversationRef, conversationTurnsRef,
    conversationCursorRef, rehydrateWorkflowRunsRef, backendSessionsRef,
    persistedIdsRef, didMountLoadRef, mountLoadRef, closeAllWorkflowSubs,
  } = core;

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
  }, [backendSessionsRef]);

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
  }, [ensureSessionInBackend, persist, persistedIdsRef]);

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
  }, [ensureSessionInBackend, persist, persistedIdsRef]);

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
  }, [ensureSessionInBackend, persist, useCurrentCache, backendKeyed, onSessionIdChange, closeAllWorkflowSubs, conversationCursorRef, conversationRef, conversationTurnsRef, olderCursorRef, persistedIdsRef, setError, setHasOlderMessages, setIsSending, setSession, subRef]);

  const loadSessionFromBackend = useCallback(async (sessionId: string) => {
    // GRADE-2 — load-epoch staleness guard: two overlapping loads (a rapid rail
    // switch, or a stray refresh racing a switch) previously let the SLOWER
    // fetch win — its post-await block replaced the session/subscriptions with
    // the OLD conversation while the rail said the new one. Only the newest
    // call may mutate; older resolutions return silently.
    loadEpochRef.current += 1;
    const epoch = loadEpochRef.current;
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
      if (epoch !== loadEpochRef.current) return; // GRADE-2 — a newer load superseded this one
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
  }, [ensureSessionInBackend, persist, useCurrentCache, backendKeyed, onSessionIdChange, backendSessionsRef, closeAllWorkflowSubs, conversationCursorRef, conversationRef, conversationTurnsRef, inFlightAssistantIdRef, inFlightRunIdRef, loadEpochRef, olderCursorRef, persistedIdsRef, rehydrateWorkflowRunsRef, setError, setHasOlderMessages, setIsSending, setSession, subRef]);

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
  }, [backendKeyedSessionId, loadSessionFromBackend, didMountLoadRef, mountLoadRef, setIsHydrating]);

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
  }, [isLoadingEarlier, olderCursorRef, persistedIdsRef, sessionRef, setError, setHasOlderMessages, setIsLoadingEarlier, setSession]);

  const setFeedback = useCallback((messageId: string, feedback: 'positive' | 'negative' | null) => {
    // Optimistic local update for instant UX...
    setSession((s) => chatSessionReducer(s, { type: 'setFeedback', id: messageId, feedback }));
    // ...then persist server-side (ADR 0071) so feedback survives reload + feeds
    // quality metrics — no longer only in local ChatMessage.feedback. Best-effort:
    // a failure (e.g. the session isn't persisted yet) keeps the optimistic state.
    const rating = feedback === 'positive' ? 'up' : feedback === 'negative' ? 'down' : 'neutral';
    void setMessageFeedback(messageId, sessionRef.current.id, rating).catch(() => { /* best-effort */ });
  }, [sessionRef, setSession]);

  return { ensureSessionInBackend, persistMessage, persistOrUpdateMessage, reset, loadSessionFromBackend, loadEarlierMessages, setFeedback };
}
