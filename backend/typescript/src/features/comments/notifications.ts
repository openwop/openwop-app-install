/**
 * Comment notification emit (ADR 0021 Phase 2).
 *
 * The feature contributes its notification TYPES as **namespaced strings** — it does
 * NOT edit the core `NotificationType` union (`/architect`, 2026-06-11; the union is
 * `NotificationType | string`, the emit seam is type-agnostic, and the FE presentation
 * maps are string-keyed with fallbacks). The feature owns its literals here.
 *
 * Port correction (recorded in the ADR): MyndHyve notified an individual recipient,
 * but this host's Notifications (ADR 0010) inbox is **tenant-scoped** — there is no
 * per-user recipient on `NotificationRecord`. So a comment notification is emitted
 * tenant-scoped, with the intended recipient (`ownerId` / `parentAuthorId`) + actor
 * carried in `metadata` for when per-subject targeting lands (open question).
 */

import { getNotificationEmitter } from '../../notifications/emitter.js';
import type { Comment, CommentNotifyTargets } from './commentsService.js';

/** Feature-owned notification types — namespaced strings, no core-union edit. */
export const COMMENT_NOTIF = { added: 'comment.added', reply: 'comment.reply' } as const;

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
        recipientId: recipient,        // intended recipient (tenant-scoped inbox until per-subject targeting lands)
        actorId: comment.authorId,
      },
    });
  } catch { /* notifications subsystem unavailable — comment write already succeeded */ }
}
