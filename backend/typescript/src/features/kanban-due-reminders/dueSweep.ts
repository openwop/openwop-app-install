/**
 * ADR 1138 D4 — the due-soon and overdue reminder sweep.
 *
 * For every tenant with `kanban-due-reminders` on, each open card that has a due
 * date and an assignee sends that assignee one `task.due` notice when it comes
 * within {@link DUE_SOON_MS} of its date, and one when the date passes. The
 * notice id is a hash of (tenant, card, state, dueAt): a re-sweep of the same date
 * hits the primary key and sends nothing, and a MOVED date is a new id, so it
 * re-arms. That is exactly-once across instances without a lease.
 *
 * Cost discipline (openwop-app-14's conditions on ADR 1138):
 *  - the toggle is resolved BEFORE any board or card read, so a tenant with it
 *    off costs zero kanban reads;
 *  - tenants come from the toggle's own overrides (or, when the toggle is on for
 *    everyone, the host's sweep tenant list), never a scan of the boards table;
 *  - cards come from the verified tenant index only (`listOpenDueCards`), capped
 *    at {@link MAX_CARDS_PER_TENANT_TICK} per tenant per tick with a cursor, and
 *    the tenant list is walked a slice per tick so the hour is spread out;
 *  - at send time the assignee must still be able to see the board (workspace
 *    member + subject read, as ADR 1137 D1 checks at assignment), so a person
 *    removed from a project stops getting its reminders.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { resolveOne, toggleCandidateTenants } from '../../host/featureToggles/service.js';
import { assigneeCanSeeBoard, listOpenDueCards, type KanbanBoard, type KanbanCard } from '../../host/kanbanService.js';

const log = createLogger('feature.kanban-due-reminders');

export const KANBAN_DUE_REMINDERS_TOGGLE = 'kanban-due-reminders';
export const DUE_SOON_MS = 2 * 24 * 60 * 60 * 1000;
/** An overdue card older than this is not announced when the toggle is first
 *  turned on — reminders are for work that is late now, not a backlog flood. */
export const OVERDUE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CARDS_PER_TENANT_TICK = 500;
/** Tenants visited per tick; with a 5-minute tick, 12 ticks cover the list once an hour. */
export const TICKS_PER_ROUND = 12;

export type DueState = 'soon' | 'overdue';

/** Pure: which notice (if any) a card is owed at `now`. */
export function dueNoticeFor(dueAt: string, now: number): DueState | null {
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return null;
  if (due <= now) return now - due <= OVERDUE_LOOKBACK_MS ? 'overdue' : null;
  return due - now <= DUE_SOON_MS ? 'soon' : null;
}

export function dueNotificationId(tenantId: string, cardId: string, state: DueState, dueAt: string): string {
  return `kanban-due-${createHash('sha256').update([tenantId, cardId, state, dueAt].join('\u0000')).digest('hex').slice(0, 32)}`;
}

/** The tenants the toggle is on for, without reading any kanban data. */
export async function reminderTenants(listSweepTenants: () => Promise<string[]>): Promise<string[]> {
  const out: string[] = [];
  for (const tenantId of await toggleCandidateTenants(KANBAN_DUE_REMINDERS_TOGGLE, listSweepTenants)) {
    if ((await resolveOne(KANBAN_DUE_REMINDERS_TOGGLE, { tenantId }))?.enabled) out.push(tenantId);
  }
  return out;
}

async function sendDue(tenantId: string, card: KanbanCard, board: KanbanBoard, state: DueState): Promise<boolean> {
  try {
    await getNotificationEmitter().emit({
      notificationId: dueNotificationId(tenantId, card.id, state, card.dueAt!),
      tenantId,
      recipientUserId: card.assigneeId!,
      type: 'task.due',
      priority: state === 'overdue' ? 'high' : 'normal',
      title: state === 'overdue' ? `Overdue: ${card.title}` : `Due soon: ${card.title}`,
      // The source label says where the card came from, and for an adopter's
      // "waiting on" card who to chase ("… · waiting on the client").
      message: `“${card.title}” on ${board.name} is due ${card.dueAt!.slice(0, 10)}.${noticeLabel(card.sourceLabel)}`,
      actionUrl: `/boards?card=${encodeURIComponent(card.id)}`,
      metadata: { kind: 'kanban.due', state, cardId: card.id, boardId: board.id, dueAt: card.dueAt },
    });
    return true;
  } catch {
    // The primary key refused a second insert (already sent), or the emitter is
    // absent. Either way nothing more to do for this card this tick.
    return false;
  }
}

/** Feature-supplied text going into a notification body: control characters
 *  out, whitespace collapsed, capped at {@link NOTICE_LABEL_MAX}. */
export const NOTICE_LABEL_MAX = 120;
export function noticeLabel(sourceLabel: string | undefined): string {
  const clean = (sourceLabel ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return ` ${clean.length > NOTICE_LABEL_MAX ? `${clean.slice(0, NOTICE_LABEL_MAX - 1)}…` : clean}.`;
}

/** Per-tenant card cursor, so a tenant over the cap is finished on later ticks. */
const cardCursor = new Map<string, string>();

/** One tenant's pass. Exported for tests. */
export async function sweepTenantDue(tenantId: string, now: number = Date.now()): Promise<{ sent: number; capped: boolean }> {
  if (!(await resolveOne(KANBAN_DUE_REMINDERS_TOGGLE, { tenantId }))?.enabled) return { sent: 0, capped: false };
  const due = await listOpenDueCards(tenantId);
  if (!due) {
    log.info('due_sweep_index_unverified', { tenantId });
    return { sent: 0, capped: false };
  }
  const after = cardCursor.get(tenantId) ?? '';
  const pending = due.filter(({ card }) => card.id > after);
  const slice = pending.slice(0, MAX_CARDS_PER_TENANT_TICK);
  const capped = pending.length > slice.length;
  let sent = 0;
  for (const { card, board } of slice) {
    const state = dueNoticeFor(card.dueAt!, now);
    if (!state) continue;
    if (!(await assigneeCanSeeBoard(board, card.assigneeId!))) continue;
    if (await sendDue(tenantId, card, board, state)) sent += 1;
  }
  if (capped) {
    cardCursor.set(tenantId, slice[slice.length - 1]!.card.id);
    log.warn('due_sweep_tenant_capped', { tenantId, cap: MAX_CARDS_PER_TENANT_TICK, remaining: pending.length - slice.length });
  } else {
    cardCursor.delete(tenantId);
  }
  return { sent, capped };
}

/** One tick: a slice of the enabled tenants (round robin), each swept once. */
export async function sweepDueTick(listSweepTenants: () => Promise<string[]>, tick: number, now: number = Date.now()): Promise<number> {
  const tenants = await reminderTenants(listSweepTenants);
  if (tenants.length === 0) return 0;
  const per = Math.max(1, Math.ceil(tenants.length / TICKS_PER_ROUND));
  const start = (tick * per) % tenants.length;
  let sent = 0;
  for (let i = 0; i < Math.min(per, tenants.length); i += 1) {
    const tenantId = tenants[(start + i) % tenants.length]!;
    try {
      sent += (await sweepTenantDue(tenantId, now)).sent;
    } catch (err) {
      log.warn('due_sweep_tenant_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return sent;
}

export function __resetDueSweepCursor(): void {
  cardCursor.clear();
}
