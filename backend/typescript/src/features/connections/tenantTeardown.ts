/**
 * ADR 0590 — connections tenant-teardown pre-hook.
 *
 * The pairing + inbound-session POINTERS (`connections:pairing`,
 * `connections:inbound-session`) key by `connectionId` and carry NO tenant, so
 * the generic `purgeTenantHostExt` content walk cannot reach them (it deletes
 * `connections:connection` via its `tenantId`, but the children are unreachable).
 * This pre-hook runs FIRST — while the tenant's connections still resolve — and
 * deletes each of the tenant's connections' children. Paired with the
 * `connections-children` revoke consumer (which deletes children when a
 * connection is revoked, so none orphan), it reaches every one of the tenant's
 * child rows at account deletion.
 *
 * A leaf module (imported only by `feature.ts` + its witness test) so it can
 * reference both child stores without the `connectionsService → inboundWebhooks`
 * import cycle a same-file hook would create.
 */
import { listTenantConnectionIds } from './connectionsService.js';
import { unpair } from './messagingOutbound.js';
import { purgeInboundSession } from './inboundWebhooks.js';

export async function purgeTenantConnectionChildren(tenantId: string): Promise<number> {
  let removed = 0;
  for (const connectionId of await listTenantConnectionIds(tenantId)) {
    if (await unpair(connectionId)) removed++;
    if (await purgeInboundSession(connectionId)) removed++;
  }
  return removed;
}
