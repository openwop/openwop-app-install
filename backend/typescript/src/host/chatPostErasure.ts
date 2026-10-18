/**
 * ADR 0879 D6 — DSAR erasure of a person's chat POSTS (S6).
 *
 * `eraseSubjectConversations` anonymizes conversation METAS (owner, participants,
 * dmKey) and deliberately keeps every conversation, because a channel or group is
 * other people's history too. Nothing reached the messages themselves, so an erased
 * member's words — and their `author_subject` id — stayed readable in every channel
 * they had posted in. This eraser closes that, in ONE tenant-scoped storage write:
 * each of the subject's messages becomes the ADR 0195 tombstone (the same thing a
 * moderator's delete leaves), its author becomes `ERASED_USER_REF`, and the session
 * is re-stamped so the search index stops matching the old text. Every conversation
 * type, not only channels: a DM and a branched copy carry the same words.
 *
 * Matching is the D0 set (`subjectRefForms`): channel rows store
 * `userRef(<id>)`, so `user:<hash>` is written as `user:user:<hash>`. Never an alias
 * principal⇄user. Legal hold is asserted by `eraseSubject` before any eraser runs.
 *
 * Not reached here (stated, ADR 0879 D6): `meta.deletedBy` on OTHER rows the subject
 * moderated, notification excerpts (the notifications eraser's scope), and a run's
 * `configurable.task` (CH2WF-4).
 */
import { hostExtStorage } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED_USER_REF } from './subjectErasureRedaction.js';
import { subjectRefForms } from './conversationStore.js';

export async function eraseSubjectChatPosts(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const refs = [...subjectRefForms(subjectKey)].filter((r) => r !== ERASED_USER_REF);
  await hostExtStorage().redactChatMessagesByAuthor(tenantId, refs, ERASED_USER_REF, new Date().toISOString());
}

/** Idempotent (the seam dedupes by reference). Called from `hostSubjectErasers.ts`. */
export function registerChatPostErasure(): void {
  registerSubjectEraser(eraseSubjectChatPosts);
}
