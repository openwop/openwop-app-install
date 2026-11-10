/**
 * ADR 1042 D5 (CHAN-P0-5) — inbound dedup for the device relay.
 *
 * A relay device retries a POST it did not see acknowledged (a dropped
 * connection, a restart mid-send), and the platform can hand it the same
 * message twice. This claims `(relayId, conversationId, platformMessageId)` with
 * a cross-instance compare-and-swap BEFORE any work, so a second delivery of one
 * message does nothing. The conversation is part of the key because a platform's
 * message id can be unique only within one chat (security review H1): two chats
 * that both have message 7 are two messages. A claim is released when its
 * processing throws, so a failed attempt can be retried.
 *
 * Rows expire (security review L7): a claim older than the TTL no longer blocks
 * (checked on read), and the webhook-delivery worker's tick sweeps them, bounded.
 */
import { DurableCollection } from '../host/hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('messaging.inboundClaims');

interface RelayInboundClaim { key: string; relayId: string; tenantId: string; claimedAt: string }

const claims = new DurableCollection<RelayInboundClaim>('messaging:inbound-claim', (c) => c.key, undefined, (c) => c.tenantId);

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_DELETE_CAP = 500;
/** How long a claim blocks a redelivery (`OPENWOP_RELAY_INBOUND_CLAIM_TTL_DAYS`, default 7). */
function ttlMs(): number {
  const days = Number(process.env.OPENWOP_RELAY_INBOUND_CLAIM_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : 7 * DAY_MS;
}

const keyOf = (relayId: string, conversationId: string, platformMessageId: string): string =>
  `${relayId}\u0000${conversationId}\u0000${platformMessageId}`;

/** True when this call won the claim (first delivery); false for a live duplicate. */
export async function claimRelayInbound(
  device: { relayId: string; tenantId: string },
  conversationId: string,
  platformMessageId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const fresh: RelayInboundClaim = {
    key: keyOf(device.relayId, conversationId, platformMessageId),
    relayId: device.relayId, tenantId: device.tenantId, claimedAt: new Date(now).toISOString(),
  };
  if (await claims.compareAndSwap(null, fresh)) return true;
  // TTL on read: an expired claim no longer blocks, and is replaced atomically.
  const existing = await claims.get(fresh.key);
  if (existing && Date.parse(existing.claimedAt) < now - ttlMs()) return claims.compareAndSwap(existing, fresh);
  return false;
}

/** Give a claim back after a failed attempt, so the device's retry is processed. */
export async function releaseRelayInbound(relayId: string, conversationId: string, platformMessageId: string): Promise<void> {
  await claims.delete(keyOf(relayId, conversationId, platformMessageId));
}

/** The conversation id inside a claim key (`relayId \0 conversationId \0 platformMessageId`), or null. */
function conversationOfKey(key: string): string | null {
  const parts = key.split('\u0000');
  return parts.length === 3 ? parts[1]! : null;
}

/**
 * ADR 1043 RELAY-LOG-RETENTION-1 — delete this tenant's claims for one of the
 * given relays, or whose conversation id EQUALS `conversationId` (exact: no
 * normalisation, no prefix match). Returns the rows deleted. Subject erasure
 * calls it from `eraseRelayOwnerSubject` (the one eraser for this store); revoke
 * passes the revoked relay alone.
 */
export async function deleteRelayInboundClaims(
  tenantId: string,
  match: { relayIds?: readonly string[]; conversationId?: string },
): Promise<number> {
  const relays = new Set(match.relayIds ?? []);
  const conversation = match.conversationId || null;
  if (!tenantId || (relays.size === 0 && !conversation)) return 0;
  let deleted = 0;
  for (const c of await claims.listForTenantIndexed(tenantId)) {
    if (c.tenantId !== tenantId) continue;
    const hit = relays.has(c.relayId) || (conversation !== null && conversationOfKey(c.key) === conversation);
    if (hit && (await claims.delete(c.key))) deleted += 1;
  }
  return deleted;
}

/** Delete expired claims, bounded and fail-contained (the webhook-delivery worker tick). */
export async function sweepRelayInboundClaims(now: number = Date.now()): Promise<number> {
  const cutoff = now - ttlMs();
  let all: RelayInboundClaim[];
  try { all = await claims.list(); } catch { return 0; }
  let deleted = 0;
  for (const c of all) {
    if (deleted >= SWEEP_DELETE_CAP) break;
    const at = Date.parse(c.claimedAt);
    if (!Number.isFinite(at) || at >= cutoff) continue;
    try { if (await claims.delete(c.key)) deleted += 1; } catch { /* next tick */ }
  }
  if (deleted > 0) log.info('relay inbound claim sweep', { deleted });
  return deleted;
}
