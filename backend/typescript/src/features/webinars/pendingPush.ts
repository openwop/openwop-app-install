/**
 * R2 WB-SP-2 — the pending registrant-push queue.
 *
 * The forms sink records the LOCAL registration always, and best-effort pushes
 * the registrant to the provider — but the sink runs with no acting user, so
 * the D2 org-connection gate fail-closes the push every time: registrants were
 * recorded locally and NEVER got a Zoom join link, with only an info log to
 * show for it (the campaign-connectors CC-SP-6 write-only-queue shape).
 *
 * This queue makes the dropped pushes durable and DRAINABLE: the sink enqueues
 * what it could not push; an operator (a real acting user, whose connection the
 * broker CAN resolve) drains it from the page. Keyed by (event, email) so a
 * re-submission never duplicates a pending row.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';

export interface PendingRegistrantPush {
  key: string; // `${tenantId}:${eventId}:${email.toLowerCase()}`
  tenantId: string;
  orgId: string;
  eventId: string;
  providerEventId: string;
  email: string;
  name?: string;
  queuedAt: string;
  /** ADR 1054 review (WEB86-14 / WEB-19) — failed drain attempts, and Zoom's last answer.
   *  The drain takes the fewest-attempted rows first, so rows Zoom keeps refusing sink to
   *  the back and never block a newer registrant; the operator sees them and can remove one. */
  attempts?: number;
  lastError?: string;
  lastAttemptAt?: string;
  /** ADR 1054 review (WEB-23) — a RANDOM handle for the page's list and remove action. It
   *  used to be an unsalted hash of the key, which a dictionary of emails reverses. */
  pendingId?: string;
}

const pending = new DurableCollection<PendingRegistrantPush>(
  'webinars:pending-push',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const keyOf = (tenantId: string, eventId: string, email: string): string => `${tenantId}:${eventId}:${email.toLowerCase()}`;

/** ADR 1054 D3 — insert-once: a retry or a replay keeps the FIRST `queuedAt`, so the
 *  confidential-PII retention clock below is not restarted by every failed attempt. */
export async function enqueuePendingPush(input: { tenantId: string; orgId: string; eventId: string; providerEventId: string; email: string; name?: string }): Promise<void> {
  await pending.putIfAbsent({
    pendingId: randomUUID(),
    key: keyOf(input.tenantId, input.eventId, input.email),
    tenantId: input.tenantId, orgId: input.orgId, eventId: input.eventId,
    providerEventId: input.providerEventId, email: input.email,
    ...(input.name ? { name: input.name } : {}),
    queuedAt: new Date().toISOString(),
  });
}

export async function listPendingPushes(tenantId: string, orgId: string, eventId?: string): Promise<PendingRegistrantPush[]> {
  const rows = await pending.listByPrefix(`${tenantId}:`);
  return rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId && (!eventId || r.eventId === eventId));
}

/** The drain's order: fewest attempts first, then oldest (ADR 1054 review WEB-19). */
export function drainOrder(rows: PendingRegistrantPush[]): PendingRegistrantPush[] {
  return [...rows].sort((a, b) => (a.attempts ?? 0) - (b.attempts ?? 0) || a.queuedAt.localeCompare(b.queuedAt));
}

/** Record one failed drain attempt on a row (compare-and-swap; a row deleted meanwhile,
 *  e.g. by the subject eraser, stays deleted). */
export async function recordPushFailure(row: PendingRegistrantPush, error: string): Promise<void> {
  const next: PendingRegistrantPush = { ...row, attempts: (row.attempts ?? 0) + 1, lastError: error, lastAttemptAt: new Date().toISOString() };
  await pending.compareAndSwap(row, next).catch(() => false);
}

/** The row's random handle; a row queued before handles existed gets one now
 *  (compare-and-swap; a concurrent writer's handle wins and is re-read). */
export async function ensurePendingId(row: PendingRegistrantPush): Promise<string> {
  if (row.pendingId) return row.pendingId;
  const next = { ...row, pendingId: randomUUID() };
  if (await pending.compareAndSwap(row, next).catch(() => false)) return next.pendingId;
  return (await pending.get(row.key))?.pendingId ?? next.pendingId;
}

/** `a…@example.com` — enough for an operator to tell people apart (with the name), not to
 *  harvest a list. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '…';
  return `${email.slice(0, Math.min(2, at))}…${email.slice(at)}`;
}

export async function deletePendingPush(tenantId: string, eventId: string, email: string): Promise<void> {
  await pending.delete(keyOf(tenantId, eventId, email)).catch(() => undefined);
}

/** Per-event pending counts in one scan (the WEB-1 batch discipline). */
export async function pendingPushCounts(tenantId: string, orgId: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await listPendingPushes(tenantId, orgId)) out.set(r.eventId, (out.get(r.eventId) ?? 0) + 1);
  return out;
}

// ── Lifecycle (review fold-in, M2) — this is a durable RAW-EMAIL store, and it
// must not outlive the person or the retention window. ──────────────────────

// A never-drained queue (a connection broken forever) must not retain emails
// indefinitely: rows ride the tenant's confidential-pii window on their
// enqueue age (the conversions-relay precedent — pixelService FM-D1-RET).
registerRetentionPurger({
  feature: 'webinars-pending-push',
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return { deleted: 0, failed: 0 };
    return purgeRowsByAge('webinars-pending-push', await pending.listByPrefix(`${tenantId}:`), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.queuedAt, id: r.key }),
      (id) => pending.delete(id));
  },
});

/** An erased subject's queued rows die too — otherwise a later "Push to Zoom"
 *  would register a person the platform has already erased. Exported named (the
 *  consent-R2 eraser-attribution discipline). */
export async function eraseSubjectPendingPushes(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms, raw } = subjectKeyForms(subjectKey);
  const emails = new Set([...forms, raw].map((f) => f.toLowerCase()));
  for (const r of await pending.listByPrefix(`${tenantId}:`)) {
    if (r.tenantId !== tenantId) continue;
    if (emails.has(r.email.toLowerCase())) await pending.delete(r.key).catch(() => undefined);
  }
}
registerSubjectEraser(eraseSubjectPendingPushes);
