/**
 * ADR 0422 P4 — SLA clocks. A dedicated timer-row collection (NOT a scan over
 * tickets — the timerSweepDaemon discipline: the sweep lists ONLY live timers,
 * a small bounded set): a row is written when a ticket gains an SLA due time,
 * advanced on status change, and deleted when the ticket settles. The sweep
 * fires `openwop-app.servicedesk.ticket-sla-breached` (ids-only) + a notification,
 * exactly once per breach (CAS on the row's fired flag).
 */
import { createLogger } from '../../observability/logger.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import type { TicketPriority } from './ticketTypes.js';

const log = createLogger('service-desk.sla');

export interface SlaTimer {
  key: string; // `${tenantId}:${ticketId}`
  tenantId: string;
  ticketId: string;
  orgId: string;
  dueAt: string;
  fired: boolean;
}

export const slaTimers = new DurableCollection<SlaTimer>(
  'service-desk:sla-timer',
  (t) => t.key,
  undefined,
  (t) => t.tenantId,
);

/** Default SLA hours per priority — operator-overridable via the intake
 *  config (`slaHoursByPriority`). 0/absent = no SLA clock for that priority. */
export const DEFAULT_SLA_HOURS: Record<TicketPriority, number> = { urgent: 4, high: 8, normal: 24, low: 72 };

export function slaDueAtFor(priority: TicketPriority, hoursByPriority: Partial<Record<TicketPriority, number>> | undefined, from: Date): string | undefined {
  const hours = hoursByPriority?.[priority] ?? DEFAULT_SLA_HOURS[priority];
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  return new Date(from.getTime() + hours * 3_600_000).toISOString();
}

export async function armSlaTimer(t: { tenantId: string; ticketId: string; orgId: string; slaDueAt?: string }): Promise<void> {
  const key = `${t.tenantId}:${t.ticketId}`;
  if (!t.slaDueAt) { await slaTimers.delete(key); return; }
  await slaTimers.put({ key, tenantId: t.tenantId, ticketId: t.ticketId, orgId: t.orgId, dueAt: t.slaDueAt, fired: false });
}

export async function settleSlaTimer(tenantId: string, ticketId: string): Promise<void> {
  await slaTimers.delete(`${tenantId}:${ticketId}`);
}

/** One sweep pass — exported for tests; the daemon interval calls it. */
export async function sweepSlaTimers(now = new Date()): Promise<number> {
  const due = (await slaTimers.list()).filter((t) => !t.fired && t.dueAt <= now.toISOString());
  let fired = 0;
  for (const timer of due) {
    const won = await slaTimers.compareAndSwap(timer, { ...timer, fired: true });
    if (!won) continue; // another instance fired it
    fired += 1;
    void emitHostEvent({
      type: 'openwop-app.servicedesk.ticket-sla-breached',
      tenantId: timer.tenantId,
      payload: { ticketId: timer.ticketId, orgId: timer.orgId, dueAt: timer.dueAt },
    });
    try {
      await getNotificationEmitter().emit({
        tenantId: timer.tenantId,
        type: 'servicedesk.sla-breached',
        priority: 'high',
        title: 'Support SLA breached',
        message: `A ticket passed its SLA due time (${timer.dueAt}).`,
        actionUrl: '/support',
        metadata: { ticketId: timer.ticketId },
      });
    } catch (err) {
      log.warn('sla notification failed', { ticketId: timer.ticketId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return fired;
}

let handle: ReturnType<typeof setInterval> | null = null;

/** Boot the sweep interval (idempotent). */
export function startSlaSweep(): void {
  if (handle) return;
  const intervalMs = Number(process.env.OPENWOP_SERVICE_DESK_SLA_SWEEP_MS) || 60_000;
  handle = setInterval(() => { void sweepSlaTimers().catch((err) => log.warn('sla sweep failed', { error: String(err) })); }, intervalMs);
  handle.unref?.();
}
