/**
 * The subjectRef a chat-message row is stamped with for the request's caller
 * (ADR 0102 Phase 2): a user session gives `userRef(req.userId)`, a bearer or anon
 * principal gives its `principalId`, and nothing gives `null`.
 *
 * ONE function, because two writers disagreeing on this spelling is how a row goes
 * unerasable or uneditable. The chat-sessions append route stamps it, and so does
 * the conversation importer (ADR 0992 D3). For a signed-in user it is the doubled
 * `user:user:<hash>` form, since `req.userId` is already `user:`-shaped. ADR 0464 §8
 * fixed the MATCHER (`subjectKeyForms`) rather than the writers, so the chat-post
 * eraser and `isAuthorOf` both match it. Do not "normalise" it here without the
 * re-key migration §8 defers.
 */
import type { Request } from 'express';
import { userRef } from './conversationStore.js';

export function chatAuthorSubject(req: Request): string | null {
  if (req.userId) return userRef(req.userId);
  return req.principal?.principalId ?? null;
}
