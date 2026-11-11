/**
 * ADR 1043 CHAN-F12 — age out relay egress that can never be delivered.
 *
 * `relay_outbound` holds each reply queued for a relay device until the device
 * pulls and acks it. A device that never comes back used to keep its queue until
 * someone revoked it: the reply text and the chat id of the person it was meant
 * for (`conversation_id`), indefinitely.
 *
 * The window is the device token's lifetime, and that is exact, not a guess. A
 * device can pull only with a live token, and it gets a fresh one only while it is
 * online (rotation on a heartbeat, ADR 1043 D1). So a device that was last online
 * at `t0` holds a token that expires by `t0 + TTL`. Any egress enqueued at
 * `t >= t0` is therefore unreachable after `t + TTL`: the device must run
 * `relay setup` again, which registers a NEW relay id with a new queue. An egress
 * older than the TTL has no reader left.
 *
 * The sweep runs on the retention daemon's DEFAULT-ON half
 * (`registerDefaultWindowSweep`, ADR 0951 D3), skips tenants under legal hold
 * (resolved through the row's device), clears each egress's attempt counter, and
 * logs it `failed` (`expired`) in the delivery log, the same record a
 * dead-lettered egress gets. A row whose device is already gone (no tenant to
 * check a hold against, and no reader at all) is deleted without a log row.
 *
 * Not in scope: `relay_outbound` has no `tenant_id` column, so the SQL-table
 * erasure ratchet keeps it on its pre-existing unclassified list; classifying it
 * needs a migration (logged as a follow-up in ADR 1043).
 */
import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import { hostExtStorage } from '../host/hostExtPersistence.js';
import { listHeldTenantsFrom } from '../host/retentionHold.js';
import { registerDefaultWindowSweep, type PurgeOutcome } from '../host/retentionPurger.js';
import { clearEgressAttempts } from './relayLifecycle.js';

/** ADR 1043 D1 — a relay device token's lifetime (the routes mint with it). */
export const RELAY_DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Delete queued egress older than the device token's lifetime, except held tenants'. */
export async function sweepExpiredRelayOutbound(nowMs: number = Date.now(), storage: Storage = hostExtStorage()): Promise<PurgeOutcome> {
  const held = await listHeldTenantsFrom(storage);
  const cutoffIso = new Date(nowMs - RELAY_DEVICE_TOKEN_TTL_MS).toISOString();
  const gone = await storage.pruneRelayOutbound(cutoffIso, [...held]);
  const at = new Date(nowMs).toISOString();
  let failed = 0;
  for (const g of gone) {
    try {
      await clearEgressAttempts(g.egressId);
      if (g.tenantId) {
        await storage.appendDeliveryLog({
          logId: `dlv_${randomUUID()}`, tenantId: g.tenantId, relayId: g.relayId, channel: g.channel,
          direction: 'outbound', conversationId: '', status: 'failed',
          detail: `egress ${g.egressId}: expired (undelivered past the device token lifetime)`, at,
        });
      }
    } catch {
      failed += 1; // the egress row itself is already deleted; only its bookkeeping failed
    }
  }
  return { deleted: gone.length, ...(failed ? { failed } : {}) };
}

/** Called from `host/hostSubjectErasers.ts`, beside the delivery-log lifecycle. */
export function registerRelayOutboundRetention(): void {
  registerDefaultWindowSweep({ feature: 'relay-outbound', sweep: (nowMs) => sweepExpiredRelayOutbound(nowMs) });
}
