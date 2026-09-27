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
}

const pending = new DurableCollection<PendingRegistrantPush>(
  'webinars:pending-push',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

const keyOf = (tenantId: string, eventId: string, email: string): string => `${tenantId}:${eventId}:${email.toLowerCase()}`;

export async function enqueuePendingPush(input: { tenantId: string; orgId: string; eventId: string; providerEventId: string; email: string; name?: string }): Promise<void> {
  await pending.put({
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
