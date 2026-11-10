/**
 * ADR 1043 RELAY-LOG-RETENTION-1 — every delete path of `messaging_delivery_log`.
 *
 * A row records one relay/connector delivery: tenant, relay device, channel,
 * direction, status, detail, time, and `conversation_id`, which is the chat id of
 * the person on the other end (an E.164 number, a platform handle). Before this
 * module the table had no delete path except tenant teardown, so every contact a
 * relay ever talked to stayed forever.
 *
 *  - RETENTION: rows older than `OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS`
 *    (default 7, the relay inbound-claim and trigger dead-letter window) are
 *    deleted by the retention daemon's DEFAULT-ON half (`registerDefaultWindowSweep`,
 *    ADR 0951 D3), skipping tenants under legal hold.
 *  - SUBJECT ERASURE (ADR 0464): `eraseRelayDeliveryLogSubject` deletes the rows
 *    whose `conversation_id` EQUALS the key, in that tenant (an external person is
 *    erased by their exact chat id; no normalisation, no prefix match, the
 *    channel-ingress `external` rule). The device OWNER's leg lives in
 *    `eraseRelayOwnerSubject` (it needs the owner row that eraser deletes).
 *  - REVOKE: the revoke route deletes the device's rows (`deleteDeliveryLogForRelay`).
 *  - TENANT TEARDOWN: `deleteAllTenantData` reaches the table through its
 *    `tenant_id` column (ADR 0284 introspection).
 */
import type { Storage } from '../storage/storage.js';
import { hostExtStorage } from '../host/hostExtPersistence.js';
import { listHeldTenantsFrom } from '../host/retentionHold.js';
import { registerDefaultWindowSweep, type PurgeOutcome } from '../host/retentionPurger.js';
import { registerSubjectEraser, type SubjectEraseReport } from '../host/subjectErasure.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DELIVERY_LOG_RETENTION_DEFAULT_DAYS = 7;

/** `OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS` (default 7); unset, non-numeric or ≤ 0 reads as the default. */
export function deliveryLogRetentionDays(): number {
  const days = Number(process.env.OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? days : DELIVERY_LOG_RETENTION_DEFAULT_DAYS;
}

/** Delete delivery-log rows past the window, except those of held tenants. */
export async function sweepExpiredRelayDeliveryLog(nowMs: number = Date.now(), storage: Storage = hostExtStorage()): Promise<PurgeOutcome> {
  const held = await listHeldTenantsFrom(storage);
  const cutoffIso = new Date(nowMs - deliveryLogRetentionDays() * DAY_MS).toISOString();
  return { deleted: await storage.pruneDeliveryLog(cutoffIso, [...held]) };
}

/** Subject erasure: the tenant's rows whose `conversation_id` is exactly `subjectKey`. */
export async function eraseRelayDeliveryLogSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  return { rowsTouched: await hostExtStorage().deleteDeliveryLogForConversation(tenantId, subjectKey) };
}

/** Called from `host/hostSubjectErasers.ts` (rows are written with the feature off too). */
export function registerRelayDeliveryLogLifecycle(): void {
  registerSubjectEraser(eraseRelayDeliveryLogSubject);
  registerDefaultWindowSweep({ feature: 'messaging-delivery-log', sweep: (nowMs) => sweepExpiredRelayDeliveryLog(nowMs) });
}
