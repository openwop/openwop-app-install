/**
 * Frontend client for the host-extension chat-session routes added
 * in Phase 2C.1. Wraps the seven `/v1/host/openwop-app/chat/sessions/*`
 * endpoints with typed return shapes that mirror the BE's
 * `ChatSessionRecord` + `ChatMessageRecord`.
 *
 * Network errors and non-2xx responses surface as `Error` with the
 * server's `error` code in the message. The collection hook
 * (`useChatSessions`) is responsible for turning these into UI state.
 */

import { authedHeaders, config, fetchOpts } from './config.js';
import { cachedRead } from './requestCache.js';

/** The persistent-conversation types (ADR 0043). Mirrors the backend
 *  `ConversationType`. `channel` is a team-messaging conversation (ADR 0126)
 *  surfaced in the unified chat rail (ADR 0154). `project` slots in later via
 *  the same discriminator. */
export type ConversationType = 'agent' | 'person' | 'group' | 'workspace' | 'channel';

/** A participant subject — the ADR 0041 subjectRef vocabulary, `user:<id>` /
 *  `agent:<id>`. */
export interface ConversationParticipant {
  subjectRef: string;
  role: 'owner' | 'member';
  addedAt: string;
  lastReadAt?: string;
}

export interface ChatSessionHeader {
  sessionId: string;
  tenantId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Conversation type (ADR 0043). Legacy sessions project as `agent`.
   *  Optional so the local-storage fallback index (which predates the
   *  conversation model) still type-checks. */
  type?: ConversationType;
  /** The owning user's stable id (ADR 0005), when known. */
  ownerUserId?: string;
  /** Source advisory board when this group was seeded from one (ADR 0040). */
  boardId?: string;
  /** The owning Subject for a container-bound group (ADR 0054 D6) — a
   *  `kind:'project'` Subject for a project's group chat; lets the UI offer
   *  "Convene the team". */
  ownerSubject?: { kind: string; id: string };
  /** Active participants — owner + members. Empty for legacy sessions. */
  participants?: ConversationParticipant[];
}

export interface ChatMessagePersisted {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'workflow_run';
  /** Serialized FE ChatMessage payload — the caller parses. */
  content: string;
  meta: string | null;
  createdAt: string;
}

const PATH = '/v1/host/openwop-app/chat/sessions';

async function http<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  if (res.status === 204) return undefined as unknown as T;
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

export async function listChatSessions(): Promise<ChatSessionHeader[]> {
  const r = await http<{ sessions: ChatSessionHeader[] }>(PATH);
  return r.sessions;
}

/** A conversation/message full-text search hit (ADR 0112). */
export interface ConversationSearchHit {
  conversationId: string;
  title: string;
  type?: string;
  /** The best-matching message (absent ⇒ a title-only hit). */
  messageId?: string;
  snippet: string;
  score: number;
  matchedAt?: string;
  role?: string;
}

/** A provider's capability set (ADR 0124 / RFC 0031) for the model selector. */
export interface ModelOption { id: string; label: string; capabilities: string[]; recommended: boolean }
export interface ProviderCapabilities { provider: string; capabilities: string[]; models?: ModelOption[] }

/** Read per-provider model capabilities so the composer can badge/disable a model
 *  by what it supports (vision/tools/long-context). Returns [] on any error — the
 *  selector degrades to "no capability info" rather than blocking the composer. */
export async function fetchModelCapabilities(): Promise<ProviderCapabilities[]> {
  // Tenant-global + immutable within a session, yet fetched from every composer
  // (i.e. every chat tab). Cache 5 min and coalesce concurrent reads so a
  // multi-tab load is one request, not one per tab. The try/catch wraps
  // cachedRead, so a failed load (incl. a 429) is never cached — it self-heals.
  try {
    return await cachedRead('chat.model-capabilities', 300_000, async () => {
      const r = await http<{ providers: ProviderCapabilities[] }>('/v1/host/openwop-app/chat/model-capabilities');
      return r.providers ?? [];
    });
  } catch {
    return [];
  }
}

const SEARCH_PATH = '/v1/host/openwop-app/chat/search';

/** Server-side full-text search over the caller's conversations + messages
 *  (ADR 0112). Returns `[]` when the `conversation-search` toggle is off (the
 *  route 404s) OR on any transient error — message search is a best-effort
 *  ENHANCEMENT over the client-side title filter, so the rail degrades silently
 *  to titles-only rather than surfacing an error. */
export async function searchChatConversations(q: string): Promise<ConversationSearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  try {
    const r = await http<{ hits: ConversationSearchHit[] }>(`${SEARCH_PATH}?q=${encodeURIComponent(query)}`);
    return r.hits ?? [];
  } catch {
    return []; // toggle off (404) / transient → no message hits, titles-only
  }
}

export async function createChatSession(opts?: {
  title?: string;
  sessionId?: string;
  /** Conversation type (ADR 0043). Defaults to `agent` on the backend. */
  type?: ConversationType;
  /** Initial participant subjectRefs; the caller is always added as owner. */
  participants?: string[];
  /** Seed a group from an advisory board (ADR 0040). */
  boardId?: string;
}): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>(PATH, {
    method: 'POST',
    body: JSON.stringify(opts ?? {}),
  });
}

/** Open-or-resume a 1:1 conversation with a single subject (ADR 0043).
 *  Idempotent on the backend via the canonical dmKey — a second open with the
 *  same subjectRef resolves to the SAME conversation rather than forking. */
export async function openConversation(opts: {
  type: 'agent' | 'person';
  subjectRef: string;
  title?: string;
}): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>('/v1/host/openwop-app/chat/conversations/open', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
}

/** Promote a conversation to the group chat for an advisory board (ADR 0043
 *  Phase 4): type → group, link the board, seed the cohort. Idempotent. */
export async function attachBoardToConversation(
  sessionId: string,
  opts: { boardId: string; participants: string[] },
): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/board`,
    { method: 'POST', body: JSON.stringify(opts) },
  );
}

/** Open-or-resume the single Workspace conversation for the caller (ADR 0043
 *  Phase 6 — W-A): a `type:'workspace'` chat routed to the tenant's assistant.
 *  Lives on the assistant feature's surface (it resolves the assistant agent).
 *  Throws (with `not_found`) when no workspace assistant is configured. */
export async function openWorkspaceConversation(): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>('/v1/host/openwop-app/assistant/workspace-conversation', { method: 'POST' });
}

export async function listConversationParticipants(sessionId: string): Promise<ConversationParticipant[]> {
  const r = await http<{ participants: ConversationParticipant[] }>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/participants`,
  );
  return r.participants;
}

export async function addConversationParticipant(sessionId: string, subjectRef: string): Promise<ConversationParticipant[]> {
  const r = await http<{ participants: ConversationParticipant[] }>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/participants`,
    { method: 'PUT', body: JSON.stringify({ subjectRef }) },
  );
  return r.participants;
}

export async function removeConversationParticipant(sessionId: string, subjectRef: string): Promise<ConversationParticipant[]> {
  const r = await http<{ participants: ConversationParticipant[] }>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(subjectRef)}`,
    { method: 'DELETE' },
  );
  return r.participants;
}

/** Mark the caller's read position in a conversation (ADR 0043 Phase 3). */
export async function markConversationRead(sessionId: string): Promise<void> {
  await http<void>(`/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: 'POST',
  });
}

export async function getChatSession(sessionId: string): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>(`/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}`);
}

export async function renameChatSession(sessionId: string, title: string): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    },
  );
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await http<void>(`/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

/** Branch a conversation at a settled turn (ADR 0117) — returns the new child
 *  conversation (seeded with the parent's first `fromSeq` messages). Omit
 *  `fromSeq` to branch from the end. The caller navigates to the child. */
export async function branchConversation(sessionId: string, fromSeq?: number): Promise<ChatSessionHeader> {
  return http<ChatSessionHeader>(`/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/branch`, {
    method: 'POST',
    body: JSON.stringify(fromSeq === undefined ? {} : { fromSeq }),
  });
}

export async function listChatSessionMessages(sessionId: string): Promise<ChatMessagePersisted[]> {
  const r = await http<{ messages: ChatMessagePersisted[] }>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return r.messages;
}

export interface ChatMessagePage {
  messages: ChatMessagePersisted[];
  /** Cursor to fetch the next OLDER page, or null at the start of history
   *  (ADR 0043 Phase 3b). Pass it back as `before`. */
  nextCursor: string | null;
  /** The conversation RUN id backing this chat, if recorded server-side
   *  (ADR 0067 continuity). The client restores it on open so continuing the
   *  chat reuses the same suspended run instead of opening a fresh one. */
  conversationRunId?: string;
}

/** Reverse-paginated message fetch (ADR 0043 Phase 3b): the most-recent `limit`
 *  messages (ASC), or — with `before` — the `limit` messages older than that
 *  cursor. Backs "load earlier messages" without loading the whole thread. */
export async function listChatSessionMessagesPage(
  sessionId: string,
  opts: { limit: number; before?: string },
): Promise<ChatMessagePage> {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.before) params.set('before', opts.before);
  return http<ChatMessagePage>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`,
  );
}

export async function appendChatMessage(
  sessionId: string,
  msg: { messageId: string; role: string; content: string; meta?: string },
): Promise<ChatMessagePersisted> {
  return http<ChatMessagePersisted>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(msg),
    },
  );
}

/** Update an existing message's content in place (ADR 0067) — a run-backed
 *  `workflow_run` message's state (node cards + HITL card) grows across its
 *  lifecycle, so it's re-saved as it evolves rather than appended. 404 if the
 *  message doesn't exist yet (caller falls back to append). */
export async function updateChatMessage(
  sessionId: string,
  messageId: string,
  body: { content: string; meta?: string },
): Promise<void> {
  await http<void>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

/** The caller's 👍/👎 across a whole session (ADR 0102 Phase 3) — so reopening a
 *  chat re-displays feedback in one round-trip. Maps `messageId → rating`
 *  (`up`/`down`/`neutral`). Best-effort; the caller merges onto restored messages. */
export async function getSessionFeedback(sessionId: string): Promise<Record<string, 'up' | 'down' | 'neutral'>> {
  const r = await http<{ feedback?: Record<string, 'up' | 'down' | 'neutral'> }>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/feedback`,
  );
  return r.feedback ?? {};
}

/** Record the conversation RUN id backing a chat (ADR 0067 continuity) so a
 *  later open reuses the same suspended run. Best-effort; 204 No Content. */
export async function setConversationRun(sessionId: string, conversationRunId: string): Promise<void> {
  await http<void>(
    `/v1/host/openwop-app/chat/sessions/${encodeURIComponent(sessionId)}/conversation-run`,
    { method: 'PUT', body: JSON.stringify({ conversationRunId }) },
  );
}
