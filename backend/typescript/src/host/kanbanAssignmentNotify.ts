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

import { createHash } from 'node:crypto';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { __hostExtStorage } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import type { KanbanCard } from './kanbanService.js';

const log = createLogger('host.kanban.assign');

const ASSIGNED_TYPE = 'task.assigned';
/** ADR 1138 D4 — the type the due sweep (`kanban-due-reminders/dueSweep.ts`) emits. */
const DUE_TYPE = 'task.due';

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
  /** A workflow-supplied key produces a stable notification primary key, so a
   * reclaimed durable operation cannot double-notify the same assignee. */
  idempotencyKey?: string;
}): Promise<void> {
  try {
    const notificationId = args.idempotencyKey
      ? `kanban-assignment-${createHash('sha256')
        .update([args.tenantId, args.card.id, args.assigneeId, args.idempotencyKey].join('\u0000'))
        .digest('hex').slice(0, 32)}`
      : undefined;
    await getNotificationEmitter().emit({
      ...(notificationId ? { notificationId } : {}),
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
 *  for this card — on reassign / unassign / complete / delete. A batch notice
 *  naming this card (`metadata.cardIds`) is archived only when none of its other
 *  cards is still the recipient's open work. Best-effort. */
export async function withdrawAssignmentNotification(args: {
  tenantId: string;
  cardId: string;
  recipientUserId: string;
}): Promise<void> {
  await withdrawCardNotifications(args, ASSIGNED_TYPE, 'assignment_notify_withdraw_failed');
}

/** ADR 1155 D6 — withdraw (archive) the assignee's unresolved due-date notices
 *  (ADR 1138) for this card when its `dueAt` is cleared or changed, so a stale
 *  "Overdue" does not outlive the date it was about. Best-effort. */
export async function withdrawDueNotifications(args: {
  tenantId: string;
  cardId: string;
  recipientUserId: string;
}): Promise<void> {
  await withdrawCardNotifications(args, DUE_TYPE, 'due_notify_withdraw_failed');
}

function batchCardIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((id): id is string => typeof id === 'string' && id !== '');
  return ids.length > 0 ? ids : null;
}

/** Is any of these cards still open work for this recipient: it exists, is in this
 *  tenant, is assigned to them, and is not in a finished lane? Withdrawals are not
 *  recorded, so this is read from the cards now. A lookup that fails counts as
 *  "still theirs": a notice left in the inbox is better than one hidden too early. */
async function anyStillTheirs(cardIds: string[], tenantId: string, recipientUserId: string): Promise<boolean> {
  if (cardIds.length === 0) return false;
  // Dynamic: kanbanService imports this module.
  const { getBoard, getCard, isTerminalColumn } = await import('./kanbanService.js');
  for (const id of cardIds) {
    try {
      const card = await getCard(id);
      if (!card || card.assigneeId !== recipientUserId) continue;
      const board = await getBoard(card.boardId);
      if (!board || board.tenantId !== tenantId) continue;
      if (isTerminalColumn(board, card.columnId)) continue;
      return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function withdrawCardNotifications(
  args: { tenantId: string; cardId: string; recipientUserId: string },
  type: string,
  failureEvent: string,
): Promise<void> {
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
      if (n.type !== type) continue;
      if (n.status === 'archived') continue;
      const meta = n.metadata as { cardId?: string; cardIds?: unknown } | undefined;
      if (meta?.cardId === args.cardId) {
        await storage.updateNotificationStatus(n.notificationId, 'archived', now);
        continue;
      }
      // A BATCH notice (adopters emit `{ kind: 'kanban.assigned.batch', cardIds }`)
      // resolves only when none of its cards is still this recipient's work, so
      // withdrawing one card never hides the others.
      const batch = batchCardIds(meta?.cardIds);
      if (!batch?.includes(args.cardId)) continue;
      if (await anyStillTheirs(batch.filter((id) => id !== args.cardId), args.tenantId, args.recipientUserId)) continue;
      await storage.updateNotificationStatus(n.notificationId, 'archived', now);
    }
  } catch (err) {
    // Storage hiccup — never block the card mutation.
    log.debug(failureEvent, { cardId: args.cardId, error: err instanceof Error ? err.message : String(err) });
  }
}
