/**
 * ADR 0992 D8 — the ONE access question for every conversation-export exit.
 *
 * Before this, the HTTP export route and the `conversations.export-document` tool
 * each inlined their own copy of "load the session, load the meta, ask
 * `isVisibleToAsync`". The copies agreed, but nothing made them agree (CLAUDE.md:
 * a chat tool SHARES its route's access predicate; one helper, both call it).
 *
 * - {@link authorizeConversationRead}: may `actor` read this conversation? Absent
 *   and invisible fold to the same 404 (no existence leak). The route, the tool and
 *   `exportConversationAsDocument` all call it.
 * - {@link refuseUnlessSoleOwner}: export-as-Document copies the transcript into an
 *   org Document, which every member of that org can read. Only a conversation
 *   that is the actor's ALONE may go there:
 *   - the actor owns it (architect B1: an owner-less legacy meta is
 *     tenant-visible, so "no other participants" alone would let any member
 *     copy it);
 *   - it is a 1:1 `agent` conversation (not a channel, group, workspace chat or
 *     person-to-person DM);
 *   - it is not bound to a subject (a project chat is the project's);
 *   - no other human is a participant (`agent:` refs are not people);
 *   - a client-bound conversation goes only to that client's org (ADR 0944);
 *   - no stored message was written by another person (grade-code CX2CD-1: an
 *     owner can REMOVE a participant, whose messages stay, so the current
 *     participant list alone is not the authority — {@link refuseUnlessSoleAuthor}).
 *
 *   The download needs none of this: the person can already read what they
 *   download.
 */
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getConversationMeta, type ConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { OpenwopError, type ChatSessionRecord } from '../../types.js';

export async function authorizeConversationRead(
  tenantId: string,
  sessionId: string,
  /** The caller as `req.userId ?? principalId`, the spelling `ownerUserId` is stamped with. */
  actor: string | undefined,
): Promise<{ session: ChatSessionRecord; meta: ConversationMeta | null }> {
  const notFound = new OpenwopError('not_found', 'Conversation not found.', 404, { sessionId });
  const session = await hostExtStorage().getChatSession(tenantId, sessionId);
  if (!session) throw notFound;
  const meta = await getConversationMeta(tenantId, sessionId);
  if (!(await isVisibleToAsync(meta, tenantId, actor))) throw notFound;
  return { session, meta };
}

export type SoleOwnerRefusal = 'shared_conversation' | 'client_mismatch';

/** Null when `actor` may copy this conversation into `targetOrgId`'s Documents. */
export function refuseUnlessSoleOwner(meta: ConversationMeta | null, actor: string, targetOrgId: string): SoleOwnerRefusal | null {
  const mine = subjectKeyForms(actor).forms;
  if (!meta || !meta.ownerUserId || !mine.has(meta.ownerUserId)) return 'shared_conversation';
  // ADR 0043: 'person' is a 1:1 with another human; 'workspace' is tenant-wide.
  if (meta.type !== 'agent' || meta.channel) return 'shared_conversation';
  if (meta.ownerSubject) return 'shared_conversation';
  const otherPerson = meta.participants.some((p) => !p.subjectRef.startsWith('agent:') && !mine.has(p.subjectRef));
  if (otherPerson) return 'shared_conversation';
  if (meta.client && meta.client.orgId !== targetOrgId) return 'client_mismatch';
  return null;
}

/** CX2CD-1 — null when every stored message is the actor's, an agent's, or legacy
 *  unattributed (`null`, written before ADR 0102 stamped authors). A tombstone
 *  erased by a DSAR carries `ERASED_USER_REF`, which is someone else's. */
export function refuseUnlessSoleAuthor(rows: ReadonlyArray<{ authorSubject: string | null }>, actor: string): SoleOwnerRefusal | null {
  const mine = subjectKeyForms(actor).forms;
  const other = rows.some((r) => r.authorSubject !== null && !r.authorSubject.startsWith('agent:') && !mine.has(r.authorSubject));
  return other ? 'shared_conversation' : null;
}
