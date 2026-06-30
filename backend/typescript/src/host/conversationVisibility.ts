/**
 * Conversation READ-visibility predicate (ADR 0043 Phase 6 + ADR 0054 subject
 * access) — the single source of truth for "may this user see this conversation".
 *
 * Extracted from `routes/chatSessions.ts` (ADR 0112) so a SECOND consumer — the
 * conversation-search feature — gates results through the EXACT same rule instead
 * of a drifting copy. `chatSessions.ts` re-exports nothing new; it now imports
 * these. Keep this the only home for the predicate.
 */
import type { ConversationMeta } from './conversationStore.js';
import { userRef } from './conversationStore.js';
import { resolveSubjectAccess, levelSatisfies } from './subjectAccess.js';

/** Owner-or-participant visibility (ADR 0043 Phase 6). A conversation is visible
 *  to the acting user iff they own it OR are a participant.
 *
 *  Back-compat: a legacy conversation with NO recorded owner (created before the
 *  conversation model) stays tenant-visible — those predate ownership. An OWNED
 *  conversation is hidden from an anonymous (no-userId) caller — fail-closed,
 *  since an anon caller can never be its owner/participant. */
export function isVisibleTo(meta: ConversationMeta | null, userId: string | undefined): boolean {
  if (!meta || !meta.ownerUserId) return true; // legacy / unowned — tenant-visible
  if (!userId) return false; // owned conversation, unattributable caller → deny
  if (meta.ownerUserId === userId) return true;
  return meta.participants.some((p) => p.subjectRef === userRef(userId));
}

/** Membership-aware READ visibility (ADR 0054). When a conversation is bound to a
 *  Subject whose access is org/membership-scoped (a project group chat), THAT ACL
 *  is authoritative — members read; non-members AND a removed owner are denied —
 *  superseding the ADR 0043 participant/owner heuristic. A subject with no
 *  registered resolution (`null` — agents, DMs, personal boards) falls back to the
 *  participant gate, identical to before. */
export async function isVisibleToAsync(
  meta: ConversationMeta | null,
  tenantId: string,
  userId: string | undefined,
): Promise<boolean> {
  if (meta?.ownerSubject) {
    const level = await resolveSubjectAccess(tenantId, meta.ownerSubject, userId);
    if (level !== null) return levelSatisfies(level, 'read');
  }
  return isVisibleTo(meta, userId);
}
