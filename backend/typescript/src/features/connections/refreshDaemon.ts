/**
 * Connections warm-refresh daemon (ADR 0024 Phase B §4). On-demand refresh in
 * `liveSecretFor` already guarantees a run never uses a lapsed oauth2 token, but
 * that pays a token-mint latency on the first use after expiry AND only flips a
 * dead connection to `needs-reconsent` when something happens to resolve it. This
 * daemon proactively refreshes connections whose access token is nearing expiry
 * so the cost is paid off the hot path and a broken connection surfaces in the UI
 * before a run trips over it.
 *
 * MULTI-INSTANCE: every fleet instance runs this loop. `warmRefreshConnection`
 * is idempotent (a redundant mint is harmless), but to avoid N instances hitting
 * a provider's token endpoint at once we guard each refresh with
 * `claimIdempotency((connectionId, expiresAt-slot))` — the same fire-once lease
 * `scheduleDaemon` uses. The claim row is pruned by age each tick.
 *
 * @see src/host/scheduleDaemon.ts — the daemon pattern this follows.
 */

import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';
import { getInstanceId } from '../../host/instanceId.js';
import { listExpiringOAuthConnections, warmRefreshConnection } from './connectionsService.js';
import { sweepExpiredPendingAuth } from './oauthFlow.js';

const log = createLogger('connections.refreshDaemon');

/** Poll cadence. Tokens live ~1h, so a minute-granularity poll is ample. */
const POLL_INTERVAL_MS = 60_000;
/** Refresh a token this far ahead of its expiry — wider than the on-demand skew
 *  so the daemon wins the race and the hot path rarely refreshes. */
const REFRESH_AHEAD_MS = 5 * 60_000;
/** Backstop against a misconfiguration flooding provider token endpoints. */
const REFRESH_BATCH = 50;
const CLAIM_KEY_PREFIX = 'connections-refresh:';
const CLAIM_PRUNE_AGE_MS = 30 * 60_000;

/** Refresh every due oauth2 connection once across the fleet. Returns the count
 *  refreshed by THIS instance. Exported for deterministic tests (pass `now`). */
export async function processExpiringConnections(storage: Storage, now: number = Date.now()): Promise<number> {
  const due = (await listExpiringOAuthConnections(REFRESH_AHEAD_MS, now)).slice(0, REFRESH_BATCH);
  let refreshed = 0;
  for (const connection of due) {
    const slot = connection.expiresAt ?? connection.updatedAt;
    const claimKey = `${CLAIM_KEY_PREFIX}${connection.connectionId}:${slot}`;
    const claim = await storage.claimIdempotency(claimKey, new Date(now).toISOString());
    if (!claim.claimed) continue; // another instance owns this slot
    try {
      const status = await warmRefreshConnection(connection);
      if (status === 'active') refreshed++;
      else log.warn('warm refresh left connection needing reconsent', { connectionId: connection.connectionId, provider: connection.provider });
    } catch (err) {
      log.warn('warm refresh threw', { connectionId: connection.connectionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return refreshed;
}

export interface RefreshDaemon {
  stop(): void;
}

/** Start the polling warm-refresh daemon for the running server. */
export function startConnectionsRefreshDaemon(storage: Storage): RefreshDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processExpiringConnections(storage);
      // GC abandoned OAuth consent flows so the pending-auth store stays bounded.
      await sweepExpiredPendingAuth().catch(() => undefined);
      await storage
        .pruneIdempotencyByPrefix(CLAIM_KEY_PREFIX, new Date(Date.now() - CLAIM_PRUNE_AGE_MS).toISOString())
        .catch(() => undefined);
    } catch (err) {
      log.warn('connections refresh tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('connections refresh daemon started', { pollIntervalMs: POLL_INTERVAL_MS, instanceId: getInstanceId() });
  return { stop: () => clearInterval(timer) };
}
