/**
 * deleteConversationCompletely — the ONE owner of "remove a conversation and
 * everything hanging off it".
 *
 * Extracted from the `DELETE /chat/sessions/:sessionId` route body (ADR 0288 P2)
 * during UX_UPGRADE-projects R2, because a second caller appeared and getting
 * the cascade PARTIALLY right there was worse than not doing it at all.
 *
 * The trap, measured: `deleteConversationMeta` alone looks like a reasonable
 * subset — "drop the sidecar, leave the row". It is not a subset, it is an
 * INVERSION. The meta is what makes an owned conversation private:
 * `conversationVisibility.ts` reads `if (!meta || !meta.ownerUserId) return
 * true; // legacy / unowned — tenant-visible`. Delete the meta and the session
 * and its messages survive with their lock removed, so a thread that no one
 * could read becomes readable — and rail-listed — for every member of the
 * tenant. A projects delete that cascaded only the meta turned a private
 * project's chat history into workspace-wide reading.
 *
 * So: session FIRST (messages cascade in SQL), then the meta, then the
 * host-owned sidecars, then the feature seam. Any caller that cannot run all
 * of it should run NONE of it and leave the conversation locked.
 */

import type { Storage } from '../storage/storage.js';
import { deleteConversationMeta } from './conversationStore.js';
import { fireConversationDeleted } from './conversationLifecycle.js';
import { deleteFeedbackForConversation } from './messageFeedbackStore.js';
import { deleteReactionsForConversation } from './messageReactionsStore.js';
import { deleteReadStateForConversation } from './conversationReadState.js';
import { deleteExchangeClaimsForConversation } from './conversationExchangeIdem.js';

/**
 * Delete a conversation and every sidecar keyed to it. Returns `false` when
 * there was no such session (the meta is still cleaned, so a stranded meta
 * from an older partial delete cannot keep advertising a thread that is gone).
 *
 * AUTHORITY IS THE CALLER'S JOB — this helper performs no visibility or
 * ownership check. The chat route does `requireVisibleAsync` +
 * `requireManageAsync` before calling; a feature cascading its own subject's
 * conversation has already authorized the parent delete.
 */
export async function deleteConversationCompletely(
  storage: Storage,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const existed = !!(await storage.getChatSession(tenantId, conversationId));
  // ADR 0288 P2 — capture the message ids BEFORE the SQL cascade removes them;
  // message-keyed consumers (comments) need them to find their rows.
  const messageIds = existed
    ? (await storage.listChatSessionMessages(conversationId)).map((m) => m.messageId)
    : [];
  if (existed) await storage.deleteChatSession(tenantId, conversationId);
  await deleteConversationMeta(tenantId, conversationId);
  await deleteFeedbackForConversation(tenantId, conversationId);
  await deleteReactionsForConversation(tenantId, conversationId);
  await deleteReadStateForConversation(tenantId, conversationId);
  await deleteExchangeClaimsForConversation(tenantId, conversationId);
  await fireConversationDeleted({ tenantId, conversationId, messageIds });
  return existed;
}
