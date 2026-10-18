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
import type { Comment, CommentNotifyPlan, CommentNotifyType } from './commentsService.js';

const log = createLogger('features.comments');

/** A SPA deep-link to the comment thread (the FE CommentsPage reads these params). */
export function threadActionUrl(c: Pick<Comment, 'orgId' | 'resourceType' | 'resourceId'>): string {
  const q = new URLSearchParams({ orgId: c.orgId, resourceType: c.resourceType, resourceId: c.resourceId });
  return `/comments?${q.toString()}`;
}

/** Feature-owned notification copy — namespaced string types, no core-union edit. */
const COPY: Record<CommentNotifyType, { title: string; message: (title: string) => string }> = {
  'comment.added': { title: 'New comment', message: (t) => `A new comment was added on “${t}”.` },
  'comment.reply': { title: 'New reply', message: (t) => `A new reply was posted on “${t}”.` },
  'comment.mention': { title: 'You were mentioned', message: (t) => `You were mentioned in a comment on “${t}”.` },
  'comment.resolved': { title: 'Comment resolved', message: (t) => `Your comment on “${t}” was resolved.` },
};

/**
 * Deliver a write's notification plan (ADR 0881 D3/D4). The plan's recipients were
 * already filtered by the service (`deliverable`: a human, not the actor, an org
 * member, able to see the target), so this only addresses and emits — one row per
 * recipient, never a tenant-wide broadcast (C11).
 *
 * Best-effort: the comment write already succeeded and must not be rolled back for a
 * notifications outage — but NEVER SILENT (CMNT-9 / WF-CMNT-7).
 */
export async function emitCommentNotification(comment: Comment, plan: CommentNotifyPlan): Promise<void> {
  for (const r of plan.recipients) {
    const copy = COPY[r.type];
    try {
      await getNotificationEmitter().emit({
        tenantId: comment.tenantId,
        recipientUserId: r.userId,
        type: r.type,
        priority: 'normal',
        title: copy.title,
        message: copy.message(plan.resourceTitle),
        actionUrl: threadActionUrl(comment),
        metadata: {
          commentId: comment.commentId,
          orgId: comment.orgId,
          resourceType: comment.resourceType,
          resourceId: comment.resourceId,
          recipientId: r.userId,        // mirrored in metadata for the FE presentation map
          actorId: plan.actorId,       // CM2CD-7 — the resolver on a resolution, the author otherwise
        },
      });
    } catch (err) {
      log.warn('comment_notify_failed', {
        commentId: comment.commentId,
        tenantId: comment.tenantId,
        resourceType: comment.resourceType,
        type: r.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
