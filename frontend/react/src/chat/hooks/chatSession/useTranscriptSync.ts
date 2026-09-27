/**
 * Voice-transcript + persisted-page sync for the chat session (ADR 0327 P2 —
 * the ADR's `useTranscriptSync`). Owns the RT-9c live transcript upsert and
 * the GRADE-D1 light merge-refresh of the newest persisted page.
 */

import { useCallback } from 'react';
import i18n from '../../../i18n/index.js';
import { listChatSessionMessagesPage } from '../../../client/chatSessionsClient.js';
import { chatSessionReducer } from '../../lib/chatSessionReducer.js';
import type { ChatSessionCore } from './core.js';
import { MESSAGE_PAGE_SIZE, conversationMessageId, parsePersistedMessages } from './lib.js';

export function useTranscriptSync(
  core: ChatSessionCore,
  deps: { persistMessage: (sessionId: string, title: string, msg: import('../../types.js').ChatMessage) => Promise<void> },
) {
  const { setSession, sessionRef, persistedIdsRef } = core;
  const { persistMessage } = deps;

  // RT-9c — a LIVE transcript turn from a realtime voice session (a display bubble,
  // NOT a send: the realtime model already answered by voice, so dispatching would
  // double-respond). UPSERT by the stable `turnId`: interim fragments stream into
  // ONE bubble (isStreaming, live-reveal cadence) and `final` settles it. Rides the
  // session→persistSession effect, so completed voice turns survive reload.
  const upsertTranscriptTurn = useCallback((text: string, role: 'user' | 'assistant', turnId: string, final: boolean, agentId?: string, agentPersona?: string) => {
    // Sanitize ONCE: the store's messageId pattern (`/^[A-Za-z0-9_-]{1,64}$/`) rejects the
    // raw `voice-tx:<uuid>:u0` (colons), and using the SAME canonical id live + persisted
    // means a reload lines up on one id (no dup bubble, dedup consistent) — the send-path scheme.
    const id = conversationMessageId(`voice-tx:${turnId}`);
    // ADR 0304 D4 — the SPEAKER (the realtime session's scoped agent) rides the assistant
    // bubble so a multi-voice call attributes per agent (parity with the OpenAI sideband's
    // server-side row-meta stamp; this is the Gemini client-persisted path).
    const attribution = role === 'assistant' && agentId
      ? { agentId, ...(agentPersona ? { agentPersona } : {}) }
      : {};
    setSession((s) => (
      s.messages.some((m) => m.id === id)
        ? chatSessionReducer(s, { type: 'updateMessage', id, patch: { content: text, isStreaming: !final, ...attribution } })
        : chatSessionReducer(s, { type: 'appendMessage', message: { id, role, content: text, isStreaming: !final, createdAt: new Date().toISOString(), ...attribution } })
    ));
    // RT-9c — durably write the SETTLED turn through to the backend. Interim fragments
    // stay in-memory (streaming reveal); only the final turn is persisted so it survives
    // reload. Without this the bubble lived in localStorage only and `loadSessionFromBackend`
    // wiped it on the next open — "transcripts not added to the chat when done". persistMessage
    // dedups on `id`, so the many interim upserts collapse to one backend append.
    if (final && text.trim()) {
      const s = sessionRef.current;
      // GRADE-D4 — a voice-FIRST session previously created its backend row with
      // the localized "New chat" placeholder (the rail's authoritative title).
      // Placeholder-guarded so a renamed/auto-titled session is never touched;
      // the local title is patched in lockstep so localStorage and the rail agree.
      const isPlaceholder = s.title === i18n.t('chat:newChat');
      const title = isPlaceholder ? i18n.t('chat:voiceChat') : s.title;
      if (isPlaceholder) {
        setSession((prev) => (prev.id === s.id && prev.title === s.title ? { ...prev, title } : prev));
      }
      void persistMessage(s.id, title, { id, role, content: text, createdAt: new Date().toISOString(), ...(role === 'assistant' && agentId ? { agentId, ...(agentPersona ? { agentPersona } : {}) } : {}), meta: { source: 'voice-realtime' } });
    }
  }, [persistMessage, sessionRef, setSession]);

  /** GRADE-D1 — the LIGHT refresh: fetch the newest persisted page and MERGE it
   *  into the live thread. Unlike `loadSessionFromBackend` (the conversation-
   *  SWITCH primitive) this closes NO subscriptions, resets NO run/accumulator/
   *  pagination state, and never removes or reorders what's on screen — so a
   *  voice-transcript frame arriving mid-typed-turn no longer severs that
   *  turn's SSE or un-disables the composer. Merge rules (architect ruling):
   *  the feed renders in ARRAY order — preserve it; append unseen persisted
   *  messages at the END (createdAt-ordered among themselves); update content
   *  only on settled (non-streaming) rows whose content changed; never touch
   *  `olderCursorRef`/`hasOlderMessages` (the pagination owners). */
  const refreshNewestMessages = useCallback(async (sessionId: string, targetMessageIds?: readonly string[]) => {
    try {
      const page = await listChatSessionMessagesPage(sessionId, { limit: MESSAGE_PAGE_SIZE });
      if (sessionRef.current.id !== sessionId) return; // switched away — stale refresh
      let fetched = parsePersistedMessages(page.messages);
      // Only NEWEST-page rows may append as additions — a cursor-walked older
      // row that isn't on screen belongs to pagination, not to the feed tail.
      const newestPageIds = new Set(fetched.map((m) => m.id));
      // GC-CHAT-2 (grade pass 2026-07-10) — a lifecycle frame can target a
      // message OLDER than the newest page (an edit/delete/reaction on an
      // on-screen row loaded via pagination). The newest-page fetch would
      // miss it and the change stayed invisible until a full reload. Walk the
      // SAME `before` cursor the pager owns (bounded — this is a light
      // refresh, not a re-hydration) until every on-screen target is covered,
      // then run the one merge over the accumulated rows. No new route, no
      // second merge path, no session reset (the GRADE-D1 invariants hold).
      const onScreen = new Set(sessionRef.current.messages.map((m) => m.id));
      const MAX_EXTRA_PAGES = 4;
      let cursor = page.nextCursor;
      let missing = (targetMessageIds ?? []).filter((id) => onScreen.has(id) && !fetched.some((m) => m.id === id));
      for (let walked = 0; missing.length > 0 && cursor && walked < MAX_EXTRA_PAGES; walked += 1) {
        const older = await listChatSessionMessagesPage(sessionId, { limit: MESSAGE_PAGE_SIZE, before: cursor });
        if (sessionRef.current.id !== sessionId) return; // switched mid-walk
        fetched = [...parsePersistedMessages(older.messages), ...fetched];
        cursor = older.nextCursor;
        missing = missing.filter((id) => !fetched.some((m) => m.id === id));
      }
      // A target beyond the walk cap degrades to today's behavior (the durable
      // store reconciles on the next real load) — bounded work, documented.
      for (const m of fetched) persistedIdsRef.current.add(m.id); // server rows need no re-persist
      setSession((s) => {
        if (s.id !== sessionId) return s;
        const haveIds = new Set(s.messages.map((m) => m.id));
        const fetchedById = new Map(fetched.map((m) => [m.id, m]));
        const additions = fetched.filter((m) => !haveIds.has(m.id) && newestPageIds.has(m.id))
          .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
        let changed = additions.length > 0;
        const merged = s.messages.map((m) => {
          const server = fetchedById.get(m.id);
          if (!server || m.isStreaming) return m;
          // ADR 0327 P2 slice — channel frames now refresh through HERE (not a
          // full session reload), so the merge must adopt every live-updatable
          // facet: content edits, reactions, and the lifecycle meta (edit/
          // tombstone stamps) that edit/delete/reaction frames announce.
          const contentChanged = typeof server.content === 'string' && typeof m.content === 'string' && server.content !== m.content;
          const reactionsChanged = JSON.stringify(server.reactions ?? null) !== JSON.stringify(m.reactions ?? null);
          const lifecycleChanged = server.meta?.editedAt !== m.meta?.editedAt || server.meta?.deletedAt !== m.meta?.deletedAt;
          if (contentChanged || reactionsChanged || lifecycleChanged) {
            changed = true;
            return {
              ...m,
              ...(contentChanged ? { content: server.content } : {}),
              ...(reactionsChanged ? { reactions: server.reactions } : {}),
              ...(lifecycleChanged ? { meta: { ...m.meta, ...(server.meta?.editedAt !== undefined ? { editedAt: server.meta.editedAt } : {}), ...(server.meta?.deletedAt !== undefined ? { deletedAt: server.meta.deletedAt } : {}), ...(server.meta?.deletedBy !== undefined ? { deletedBy: server.meta.deletedBy } : {}) } } : {}),
            };
          }
          return m;
        });
        return changed ? { ...s, messages: [...merged, ...additions] } : s;
      });
    } catch { /* best-effort — the durable store reconciles on the next real load */ }
  }, [persistedIdsRef, sessionRef, setSession]);

  return { upsertTranscriptTurn, refreshNewestMessages };
}
