/**
 * ADR 0049 — kanban assignment notifications.
 *
 * When a card is assigned to a person, that person gets an ADDRESSED
 * notification (ADR 0050 `recipientUserId`) that lands in their inbox and
 * pushes only to their devices. When the card is reassigned, unassigned,
 * completed, or deleted, the stale assignment notification is WITHDRAWN
 * (archived) so the inbox item resolves with the work.
 *
 * Shared by the `host.kanban` `taskAssign` surface op (agent/workflow callers)
 * and the REST assign route (human callers), so both honor the same lifecycle.
 * All emits are best-effort: a notification failure must never abort the
 * assignment mutation (the emitter may be uninstalled in tests).
 */

import { getNotificationEmitter } from '../notifications/emitter.js';
import { __hostExtStorage } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import type { KanbanCard } from './kanbanService.js';

const log = createLogger('host.kanban.assign');

const ASSIGNED_TYPE = 'task.assigned';

/** Deep-link the assignee to the card on their personal board's "Assigned to
 *  me" rail (ADR 0049; was the standalone `/my-work` page until 2026-06-16).
 *  `/my-work` still redirects here, preserving `?card=`, for older links. */
function cardActionUrl(card: Pick<KanbanCard, 'id'>): string {
  return `/boards?card=${encodeURIComponent(card.id)}`;
}

/** Notify a newly-assigned user. Best-effort. */
export async function emitAssignmentNotification(args: {
  tenantId: string;
  card: Pick<KanbanCard, 'id' | 'boardId' | 'title'>;
  assigneeId: string;
  comment?: string;
  boardName?: string;
}): Promise<void> {
  try {
    await getNotificationEmitter().emit({
      tenantId: args.tenantId,
      recipientUserId: args.assigneeId,
      type: ASSIGNED_TYPE,
      priority: 'normal',
      title: `Assigned: ${args.card.title}`,
      message:
        args.comment?.trim() ||
        `You were assigned “${args.card.title}”${args.boardName ? ` on ${args.boardName}` : ''}.`,
      actionUrl: cardActionUrl(args.card),
      metadata: { kind: 'kanban.assigned', cardId: args.card.id, boardId: args.card.boardId },
    });
  } catch (err) {
    // Emitter may be uninstalled (some tests) — never block the assignment.
    log.debug('assignment_notify_emit_failed', { cardId: args.card.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Withdraw (archive) a prior recipient's unresolved assignment notifications
 *  for this card — on reassign / unassign / complete / delete. Best-effort. */
export async function withdrawAssignmentNotification(args: {
  tenantId: string;
  cardId: string;
  recipientUserId: string;
}): Promise<void> {
  const storage = __hostExtStorage();
  if (!storage) return;
  try {
    const rows = await storage.listNotifications({
      tenantId: args.tenantId,
      recipientUserId: args.recipientUserId,
      includeArchived: false,
      limit: 500,
    });
    const now = new Date().toISOString();
    for (const n of rows) {
      if (n.type !== ASSIGNED_TYPE) continue;
      if (n.status === 'archived') continue;
      const meta = n.metadata as { cardId?: string } | undefined;
      if (meta?.cardId !== args.cardId) continue;
      await storage.updateNotificationStatus(n.notificationId, 'archived', now);
    }
  } catch (err) {
    // Storage hiccup — never block the assignment mutation.
    log.debug('assignment_notify_withdraw_failed', { cardId: args.cardId, error: err instanceof Error ? err.message : String(err) });
  }
}
