/**
 * Comment notification emit (ADR 0021 Phase 2).
 *
 * The feature contributes its notification TYPES as **namespaced strings** — it does
 * NOT edit the core `NotificationType` union (`/architect`, 2026-06-11; the union is
 * `NotificationType | string`, the emit seam is type-agnostic, and the FE presentation
 * maps are string-keyed with fallbacks). The feature owns its literals here.
 *
 * Port correction (recorded in the ADR): MyndHyve notified an individual recipient.
 *
 * C11 (chat-first port) — this now uses the per-recipient rail. The original port
 * note claimed `NotificationRecord` had no per-user recipient, so it emitted the
 * comment notification tenant-scoped (`recipientUserId` omitted) — which the
 * notifications route treats as a BROADCAST, surfacing every comment to every
 * member of the tenant. But `recipientUserId` DOES exist (channelActivityNotify /
 * escalationNotify address it), and the intended recipient (`ownerId` /
 * `parentAuthorId`) is a bare userId. So the notification is now ADDRESSED to that
 * one person — no tenant-wide broadcast — exactly as MyndHyve did.
 */

import { getNotificationEmitter } from '../../notifications/emitter.js';
import { createLogger } from '../../observability/logger.js';
import type { Comment, CommentNotifyTargets } from './commentsService.js';

const log = createLogger('features.comments');

/** Feature-owned notification types — namespaced strings, no core-union edit. */
const COMMENT_NOTIF = { added: 'comment.added', reply: 'comment.reply' } as const;

/** A SPA deep-link to the comment thread (the FE CommentsPage reads these params). */
export function threadActionUrl(c: Pick<Comment, 'orgId' | 'resourceType' | 'resourceId'>): string {
  const q = new URLSearchParams({ orgId: c.orgId, resourceType: c.resourceType, resourceId: c.resourceId });
  return `/comments?${q.toString()}`;
}

/**
 * Emit one tenant-scoped notification for a freshly-created comment (best-effort —
 * a notification failure MUST NOT fail the comment write). A reply notifies the
 * parent author (`comment.reply`); a top-level comment notifies the resource owner
 * (`comment.added`). Self-activity (owner comments on own resource / reply to self)
 * emits nothing.
 */
export async function emitCommentNotification(comment: Comment, notify: CommentNotifyTargets): Promise<void> {
  const isReply = comment.parentId != null;
  const recipient = isReply ? notify.parentAuthorId : (notify.ownerId !== comment.authorId ? notify.ownerId : undefined);
  if (!recipient) return; // nothing new to tell (self-activity)

  const type = isReply ? COMMENT_NOTIF.reply : COMMENT_NOTIF.added;
  try {
    await getNotificationEmitter().emit({
      tenantId: comment.tenantId,
      recipientUserId: recipient,      // C11 — addressed to the owner / parent-author, never broadcast tenant-wide
      type,
      priority: 'normal',
      title: isReply ? 'New reply' : 'New comment',
      message: `${isReply ? 'A new reply was posted' : 'A new comment was added'} on “${notify.resourceTitle}”.`,
      actionUrl: threadActionUrl(comment),
      metadata: {
        commentId: comment.commentId,
        orgId: comment.orgId,
        resourceType: comment.resourceType,
        resourceId: comment.resourceId,
        recipientId: recipient,        // mirrored in metadata for the FE presentation map
        actorId: comment.authorId,
      },
    });
  } catch (err) {
    // CMNT-9 / WF-CMNT-7 — best-effort (the comment write already succeeded and
    // must not be rolled back for a notifications outage) but NEVER SILENT. This
    // was a bare `catch { }` in a feature that imported no logger at all, so a
    // notifications outage dropped every comment notification with no counter,
    // no log line and no trace: the only way to notice was a user asking why
    // they were never told. The repo convention for exactly this trade is one
    // file over — `cms/cmsService.ts` "Best-effort … but never silent (CMSGAP-2)".
    log.warn('comment_notify_failed', {
      commentId: comment.commentId,
      tenantId: comment.tenantId,
      resourceType: comment.resourceType,
      type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * CMNT-11 — the comment is erased; the notification it produced was not.
 *
 * Each row this module emits carries `recipientUserId` (a bare userId),
 * `metadata.actorId` (the author's userId), `metadata.recipientId`, and the
 * parent resource's TITLE in its message body. `deleteSubjectComments` removed
 * the comment rows and nothing removed these.
 *
 * The FIX lives with the store that owns the rows, not here:
 * `host/notificationSubjectErasure.ts` registers the subject eraser and
 * `Storage.deleteNotificationsForSubject` (both adapters) does the reclamation —
 * because this residual is not comments-specific (every emitter writes the same
 * three subject-bearing places) and comments must not reach across a feature
 * boundary to delete another feature's rows. That file also states the
 * GATE-BLINDNESS mechanism, which is a fifth distinct one.
 */
