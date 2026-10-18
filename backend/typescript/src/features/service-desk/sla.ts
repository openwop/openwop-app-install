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
import { resolveOne } from '../../host/featureToggles/service.js';
import { listMembers } from '../../host/accessControlService.js';
import { orgScopeGranted } from './orgScope.js';
import type { Ticket, TicketPriority } from './ticketTypes.js';

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

/** How a notification names a ticket. A WhatsApp / widget subject IS the
 *  customer's own first words, and a notification body outlives a DSAR of them
 *  (the notification eraser matches people refs, not text — grade-code SD2CD-7),
 *  so those are named by channel; a form title or a member-typed subject is not
 *  the customer's text and is quoted. */
export function ticketLabel(t: Pick<Ticket, 'channel' | 'subject'>): string {
  if (t.channel === 'whatsapp') return 'A WhatsApp conversation';
  if (t.channel === 'widget') return 'A website chat';
  return `"${t.subject.slice(0, 120)}"`;
}

/**
 * ADR 0878 D8 — the people who work a ticket: its assignee, else every member of
 * the ticket's org holding `workspace:write`. Each is notified by member subject
 * (the spelling the inbox keys on). Never a tenant broadcast — that was the old
 * breach notice, and it named no ticket. Returns who was addressed (an org with
 * nobody to address notifies nobody; the caller logs it).
 */
export async function notifyTicketTeam(
  t: Pick<Ticket, 'tenantId' | 'ticketId' | 'orgId' | 'assigneeMemberId'>,
  n: { title: string; message: string; type: string; priority?: 'normal' | 'high' },
): Promise<string[]> {
  let recipients: string[];
  // The assignee only while they can still work the ticket: someone removed from
  // the org must not keep receiving its customer's content (grade-code SD2CD-9).
  if (t.assigneeMemberId && (await orgScopeGranted(t.tenantId, t.assigneeMemberId, t.orgId, 'workspace:write'))) {
    recipients = [t.assigneeMemberId];
  } else {
    recipients = [];
    for (const m of await listMembers(t.tenantId, t.orgId)) {
      if (m.subject && (await orgScopeGranted(t.tenantId, m.subject, t.orgId, 'workspace:write'))) recipients.push(m.subject);
    }
  }
  for (const recipientUserId of recipients) {
    try {
      await getNotificationEmitter().emit({
        tenantId: t.tenantId,
        recipientUserId,
        type: n.type,
        priority: n.priority ?? 'high',
        title: n.title,
        message: n.message,
        actionUrl: `/support?org=${encodeURIComponent(t.orgId)}&ticket=${encodeURIComponent(t.ticketId)}`,
        metadata: { ticketId: t.ticketId, orgId: t.orgId },
      });
    } catch (err) {
      log.warn('servicedesk notification failed', { ticketId: t.ticketId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (recipients.length === 0) log.info('servicedesk_notification_no_recipients', { tenantId: t.tenantId, ticketId: t.ticketId });
  return recipients;
}

/** One sweep pass — exported for tests; the daemon interval calls it.
 *  ADR 0878 D9: a timer whose tenant has Service desk OFF is SETTLED SILENTLY
 *  (marked fired, never alerted) — it used to fire breach events + notifications
 *  for a disabled feature. Settling, not skipping: a skipped row would be
 *  re-listed every minute and burst on re-enable. The toggle is read once per
 *  tenant per pass (an operator lane: `resolveOne`, tenant only). */
export async function sweepSlaTimers(now = new Date()): Promise<number> {
  const due = (await slaTimers.list()).filter((t) => !t.fired && t.dueAt <= now.toISOString());
  const enabledByTenant = new Map<string, Promise<'on' | 'off' | 'unknown'>>();
  const enabled = (tenantId: string): Promise<'on' | 'off' | 'unknown'> => {
    let p = enabledByTenant.get(tenantId);
    if (!p) {
      // A toggle READ that fails is not "off": settling on it would lose the breach
      // for good (grade-code SD2CD-6). Unknown ⇒ leave the timer for the next pass.
      p = resolveOne('service-desk', { tenantId }).then((a): 'on' | 'off' => (a?.enabled === true ? 'on' : 'off'), (): 'unknown' => 'unknown');
      enabledByTenant.set(tenantId, p);
    }
    return p;
  };
  let fired = 0;
  let suppressed = 0;
  for (const timer of due) {
    const state = await enabled(timer.tenantId);
    if (state === 'unknown') continue;
    const won = await slaTimers.compareAndSwap(timer, { ...timer, fired: true });
    if (!won) continue; // another instance fired it
    if (state === 'off') { suppressed += 1; continue; }
    fired += 1;
    void emitHostEvent({
      type: 'openwop-app.servicedesk.ticket-sla-breached',
      tenantId: timer.tenantId,
      payload: { ticketId: timer.ticketId, orgId: timer.orgId, dueAt: timer.dueAt },
    });
    // Addressed to the ticket's team (D8). The ticket is re-read for its CURRENT
    // assignee and subject; a ticket deleted since is not announced.
    const { getTicket } = await import('./tickets.js');
    const ticket = await getTicket(timer.tenantId, timer.ticketId).catch(() => null);
    if (!ticket) continue;
    await notifyTicketTeam(ticket, {
      type: 'servicedesk.sla-breached',
      title: 'Support SLA breached',
      message: `${ticketLabel(ticket)} passed its response due time.`,
    });
  }
  if (suppressed > 0) log.info('sla_breaches_settled_while_off', { suppressed });
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
