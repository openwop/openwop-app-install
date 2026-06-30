/**
 * Collection hook for the chat-session sidebar (Phase 2C.1).
 *
 * Holds the list of session HEADERS (id + title + counts + timestamps)
 * fetched from the host-extension `/v1/host/openwop-app/chat/sessions`
 * route family. The per-session MESSAGE thread lives in `useChatSession`;
 * this hook just owns the cross-session list.
 *
 * UX surfaces:
 *   - load() / refresh() — fetch + replace
 *   - createSession() — POST + prepend to local state
 *   - rename(id, title) — PATCH + update local copy
 *   - remove(id) — DELETE + drop from local state
 *
 * Sample-grade: no optimistic updates, no retry. Errors surface as
 * `error` state so the drawer can show a banner; the caller can retry
 * by calling `refresh()`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../../i18n/index.js';
import {
  addConversationParticipant,
  attachBoardToConversation,
  createChatSession,
  deleteChatSession,
  listChatSessions,
  markConversationRead,
  openConversation,
  openWorkspaceConversation,
  removeConversationParticipant,
  renameChatSession,
  type ChatSessionHeader,
  type ConversationParticipant,
  type ConversationType,
} from '../../client/chatSessionsClient.js';
import {
  LS_SESSION_INDEX_KEY,
  LS_SESSION_INDEX_VERSION,
} from '../lib/storageKeys.js';

/** Cross-tab message envelope. JSON-RPC-style discriminated union so we
 *  can extend with new event kinds (e.g., `session:message-appended`)
 *  without breaking older tabs. Older tabs ignore unknown kinds. */
type CrossTabEvent =
  | { kind: 'session:created'; sessionId: string }
  | { kind: 'session:renamed'; sessionId: string }
  | { kind: 'session:deleted'; sessionId: string };

const CHANNEL_NAME = 'openwop-sample-chat';

export interface UseChatSessionsResult {
  sessions: readonly ChatSessionHeader[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Create a new session on the BE; returns the persisted header.
   *  The new session is prepended to the local list. */
  createSession: (title?: string) => Promise<ChatSessionHeader>;
  /** Open-or-resume a typed 1:1 conversation with a subject (ADR 0043).
   *  Idempotent — resolves to the existing conversation when one exists.
   *  The returned header is upserted into the local list. */
  openWith: (type: 'agent' | 'person', subjectRef: string, title?: string) => Promise<ChatSessionHeader>;
  /** Create a typed multi-party conversation (group / workspace). The caller is
   *  the owner; `participants` are added as members. */
  createConversation: (init: { type: ConversationType; title?: string; participants?: string[]; boardId?: string }) => Promise<ChatSessionHeader>;
  /** Open-or-resume the single Workspace conversation (ADR 0043 Phase 6 — the
   *  assistant's tenant-graph chat). Returns null when no workspace assistant is
   *  configured (the caller surfaces that, rather than opening a dead chat). */
  openWorkspace: () => Promise<ChatSessionHeader | null>;
  rename: (sessionId: string, title: string) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  /** Mark a conversation read for the owner (ADR 0043 Phase 3) — clears its
   *  unread badge. Optimistic + best-effort: the local owner read-marker is
   *  advanced immediately; a failed write reconciles on the next refresh. */
  markRead: (sessionId: string) => Promise<void>;
  /** Promote a conversation to a board group chat (ADR 0043 Phase 4) — the
   *  `@@<board>` summon stamps the current chat so the Board of Advisors shows
   *  under Groups. Best-effort; upserts the enriched header locally. */
  attachBoard: (sessionId: string, boardId: string, participants: string[]) => Promise<void>;
  /** Persist an agent joining a conversation (ADR 0043) — the server-side
   *  membership the lineup is derived from. Best-effort; syncs the local header.*/
  addParticipant: (sessionId: string, subjectRef: string) => Promise<void>;
  /** Persist an agent leaving a conversation. Best-effort; syncs the header. */
  removeParticipant: (sessionId: string, subjectRef: string) => Promise<void>;
}

export function useChatSessions(): UseChatSessionsResult {
  const [sessions, setSessions] = useState<ChatSessionHeader[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Re-entrant load guard — if a second refresh fires while the first
  // is in flight (e.g., user clicks New + refresh near-simultaneously),
  // drop the duplicate to avoid trampling state.
  const inFlightRef = useRef(false);
  // BroadcastChannel for cross-tab session-list sync (Phase 2C.2).
  // Feature-detected — Safari + older Edge in private mode lack it; the
  // hook still works inside the originating tab, just doesn't propagate.
  const channelRef = useRef<BroadcastChannel | null>(null);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    try {
      const list = await listChatSessions();
      // BE-first: if the backend returns chat sessions, use them.
      // If the BE list is empty (Cloud Run cold start, 401 between
      // deploys, fresh tenant), fall back to the local session index
      // populated by `persistSession` in useChatSession. This is what
      // keeps the History drawer from being permanently empty on the
      // public demo when write-through is degraded.
      if (list.length > 0) {
        setSessions(list);
      } else {
        const local = readLocalSessionIndex();
        setSessions(local);
      }
    } catch (err) {
      // BE errored — fall back to local index. The user still sees
      // their chats; we just can't sync across tabs/devices.
      const local = readLocalSessionIndex();
      if (local.length > 0) {
        setSessions(local);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  /** Read the localStorage session index written by `persistSession`
   *  in `useChatSession`. Mirrors the BE `ChatSessionHeader` shape so
   *  the drawer doesn't need to know which source provided each row.
   *  `tenantId` is synthetic ('local'); the drawer doesn't gate on it.
   *
   *  On-disk envelope is `{ v: LS_SESSION_INDEX_VERSION, items: [...] }`.
   *  Mismatched-version payloads are dropped to prevent rendering with
   *  a stale shape (see lib/storageKeys.ts for the bump protocol). */
  function readLocalSessionIndex(): ChatSessionHeader[] {
    try {
      const raw = localStorage.getItem(LS_SESSION_INDEX_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { v?: number; items?: unknown };
      if (parsed.v !== LS_SESSION_INDEX_VERSION) return [];
      if (!Array.isArray(parsed.items)) return [];
      return parsed.items.map((raw) => {
        const it = raw as Record<string, unknown>;
        return {
          sessionId: String(it.sessionId),
          tenantId: 'local',
          title: String(it.title ?? i18n.t('chat:untitled')),
          createdAt: String(it.createdAt ?? new Date().toISOString()),
          updatedAt: String(it.updatedAt ?? it.createdAt ?? new Date().toISOString()),
          messageCount: Number(it.messageCount ?? 0),
        };
      });
    } catch {
      return [];
    }
  }

  // Open the channel on mount; listen for events from other tabs and
  // re-fetch the headers on any mutation. Posting our own events is
  // best-effort — channel.postMessage NEVER fires on the originating
  // tab's own listener, so this is a clean fan-out.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = ch;
    ch.onmessage = (event: MessageEvent<CrossTabEvent>) => {
      const kind = event.data?.kind;
      if (kind === 'session:created' || kind === 'session:renamed' || kind === 'session:deleted') {
        void refresh();
      }
    };
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const broadcast = useCallback((event: CrossTabEvent) => {
    try {
      channelRef.current?.postMessage(event);
    } catch {
      /* channel closed mid-render; harmless */
    }
  }, []);

  const createSession = useCallback(async (title?: string) => {
    const created = await createChatSession(title !== undefined ? { title } : {});
    setSessions((s) => [created, ...s.filter((x) => x.sessionId !== created.sessionId)]);
    broadcast({ kind: 'session:created', sessionId: created.sessionId });
    return created;
  }, [broadcast]);

  const openWith = useCallback(async (type: 'agent' | 'person', subjectRef: string, title?: string) => {
    const opened = await openConversation({ type, subjectRef, ...(title !== undefined ? { title } : {}) });
    // Upsert — `open` is idempotent, so a resumed conversation is moved to the
    // top rather than duplicated.
    setSessions((s) => [opened, ...s.filter((x) => x.sessionId !== opened.sessionId)]);
    broadcast({ kind: 'session:created', sessionId: opened.sessionId });
    return opened;
  }, [broadcast]);

  const createConversation = useCallback(async (init: { type: ConversationType; title?: string; participants?: string[]; boardId?: string }) => {
    const created = await createChatSession(init);
    setSessions((s) => [created, ...s.filter((x) => x.sessionId !== created.sessionId)]);
    broadcast({ kind: 'session:created', sessionId: created.sessionId });
    return created;
  }, [broadcast]);

  const openWorkspace = useCallback(async (): Promise<ChatSessionHeader | null> => {
    let opened: ChatSessionHeader;
    try {
      opened = await openWorkspaceConversation();
    } catch {
      // No workspace assistant configured (404) — the caller surfaces it.
      return null;
    }
    setSessions((s) => [opened, ...s.filter((x) => x.sessionId !== opened.sessionId)]);
    broadcast({ kind: 'session:created', sessionId: opened.sessionId });
    return opened;
  }, [broadcast]);

  const rename = useCallback(async (sessionId: string, title: string) => {
    const updated = await renameChatSession(sessionId, title);
    setSessions((s) => s.map((x) => (x.sessionId === sessionId ? updated : x)));
    broadcast({ kind: 'session:renamed', sessionId });
  }, [broadcast]);

  const remove = useCallback(async (sessionId: string) => {
    try {
      await deleteChatSession(sessionId);
    } catch (err) {
      // Idempotent delete: a `not_found` means the conversation is already gone
      // server-side (deleted on another device, or a reset/re-seeded demo backend).
      // The goal state — absent — already holds, so DON'T rethrow (an uncaught
      // rejection) and DON'T skip the local removal below: otherwise the row the
      // user just deleted lingers in the library/modal ("deleted conversations
      // showing up"). Any other error still propagates.
      if (!(err instanceof Error && err.message.startsWith('not_found:'))) throw err;
    }
    setSessions((s) => s.filter((x) => x.sessionId !== sessionId));
    broadcast({ kind: 'session:deleted', sessionId });
  }, [broadcast]);

  const markRead = useCallback(async (sessionId: string) => {
    const at = new Date().toISOString();
    // Optimistic: advance the owner's read marker locally so the unread dot
    // clears the instant a conversation is opened, without waiting on the round
    // trip. There is exactly one `owner` participant (the acting user).
    setSessions((s) => s.map((c) => (c.sessionId === sessionId
      ? { ...c, participants: (c.participants ?? []).map((p) => (p.role === 'owner' ? { ...p, lastReadAt: at } : p)) }
      : c)));
    try { await markConversationRead(sessionId); } catch { /* best-effort; refresh reconciles */ }
  }, []);

  const attachBoard = useCallback(async (sessionId: string, boardId: string, participants: string[]) => {
    try {
      const updated = await attachBoardToConversation(sessionId, { boardId, participants });
      setSessions((s) => (s.some((x) => x.sessionId === sessionId)
        ? s.map((x) => (x.sessionId === sessionId ? updated : x))
        : [updated, ...s]));
      broadcast({ kind: 'session:renamed', sessionId });
    } catch { /* best-effort; the boardroom turn proceeds regardless */ }
  }, [broadcast]);

  // Sync the local header's participants after a membership write so the rail's
  // participant count + the derived lineup stay consistent without a refetch.
  const applyParticipants = useCallback((sessionId: string, participants: ConversationParticipant[]) => {
    setSessions((s) => s.map((x) => (x.sessionId === sessionId ? { ...x, participants } : x)));
    broadcast({ kind: 'session:renamed', sessionId });
  }, [broadcast]);

  const addParticipant = useCallback(async (sessionId: string, subjectRef: string) => {
    try { applyParticipants(sessionId, await addConversationParticipant(sessionId, subjectRef)); }
    catch { /* best-effort; the FE lineup still reflects the activation locally */ }
  }, [applyParticipants]);

  const removeParticipant = useCallback(async (sessionId: string, subjectRef: string) => {
    try { applyParticipants(sessionId, await removeConversationParticipant(sessionId, subjectRef)); }
    catch { /* best-effort */ }
  }, [applyParticipants]);

  return { sessions, isLoading, error, refresh, createSession, openWith, createConversation, openWorkspace, rename, remove, markRead, attachBoard, addParticipant, removeParticipant };
}
