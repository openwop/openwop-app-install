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
  // ADR 0195 gate correction #3 — channel semantics live HERE (the one
  // predicate), not in per-route branches: a PUBLIC channel is visible to any
  // AUTHENTICATED tenant caller (mirroring `canAccessChannel`'s read/post
  // grant, which lets a tenant member post without joining — the chat-sessions
  // family must agree so that member can edit/react to their own post); a
  // PRIVATE channel stays owner-or-participant. An archived channel keeps its
  // membership visibility (history stays readable; writes are gated at the
  // routes). Anonymous callers stay denied (CHN-3).
  if (meta?.type === 'channel' && meta.channel) {
    if (!userId) return false;
    if (meta.channel.visibility === 'public') return true;
    if (meta.ownerUserId === userId) return true;
    return meta.participants.some((p) => p.subjectRef === userRef(userId));
  }
  if (!meta || !meta.ownerUserId) return true; // legacy / unowned — tenant-visible
  if (!userId) return false; // owned conversation, unattributable caller → deny
  if (meta.ownerUserId === userId) return true;
  return meta.participants.some((p) => p.subjectRef === userRef(userId));
}

/** RAIL-LIST scope (ADR 0195 companion to the channel-aware predicate above):
 *  visibility answers "may this caller READ it by id"; the conversation LIST is
 *  a narrower DISPLAY question. A public channel is readable by any tenant
 *  member (above) but only rail-listed for its members/owner — otherwise every
 *  public channel would flood every member's rail, contradicting ADR 0154
 *  ("the rail only lists channels you're in"; browse is the discovery
 *  surface). Non-channel conversations list wherever they're visible. */
export function isRailListed(meta: ConversationMeta | null, userId: string | undefined): boolean {
  if (meta?.type === 'channel') {
    if (!userId) return false;
    if (meta.ownerUserId === userId) return true;
    return meta.participants.some((p) => p.subjectRef === userRef(userId));
  }
  return true; // non-channels: the visibility predicate is the only gate
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
