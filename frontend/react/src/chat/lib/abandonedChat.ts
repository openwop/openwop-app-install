/**
 * ADR 0978 D3 — the ONE predicate every AUTOMATIC conversation delete in the chat must
 * pass: the deck's stale-empty sweep, the deck's close-time adoption, and the
 * ChatSidebar one-shot purge. A user's own ⋯ Delete is a deliberate act and does not
 * use it.
 *
 * It matches exactly the shape a deck "New chat" has when it was never used: an empty
 * plain `agent` conversation whose ONLY participant is its recorded owner, bound to no
 * board, project/notebook subject, or client.
 *
 * Why that proves the caller owns it: the list route shows a non-channel, unbound
 * conversation only to its owner or a participant (`isVisibleTo`,
 * backend `host/conversationVisibility.ts`). A listed row whose sole participant is its
 * owner was listed BECAUSE the caller is that owner. A meta-less legacy row (no owner,
 * no participants) is tenant-visible to every member, so it never matches: one member's
 * browser must not delete another's rows.
 *
 * Not `isSelf`: the server never stamps it for anonymous or OIDC callers
 * (`callerSubject` is `session:<sid>`, the owner participant `user:session:<sid>`).
 * That is filed as MT2WF-R2.
 */
import type { ChatSessionHeader } from '../../client/chatSessionsClient.js';

export function isAbandonedEmptyChat(c: ChatSessionHeader): boolean {
  if (c.messageCount !== 0) return false;
  if (c.type !== 'agent') return false;
  if (c.boardId || c.ownerSubject || c.client) return false;
  if (!c.ownerUserId) return false;
  const parts = c.participants ?? [];
  if (parts.length !== 1) return false;
  const only = parts[0]!;
  return only.role === 'owner' && only.subjectRef === `user:${c.ownerUserId}`;
}

/** The ChatSidebar one-shot purge's selection (ADR 0978 D3): abandoned empty chats the
 *  caller owns alone, never the active session (it may be a fresh chat the user is
 *  about to type into). Before D3 the purge took every `messageCount === 0` row. */
export function selectPurgeableEmptyChats(sessions: readonly ChatSessionHeader[], activeSessionId: string): ChatSessionHeader[] {
  return sessions.filter((s) => isAbandonedEmptyChat(s) && s.sessionId !== activeSessionId);
}
