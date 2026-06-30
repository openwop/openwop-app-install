/**
 * Knowledge sync cadence daemon (ADR 0107 Phase 3b) — the missing scheduler tick
 * that makes a SyncSource's `cadence` actually fire. Polls every active source and
 * runs `syncNow` when it's due (the same path "Sync now" uses), so a Drive/OneDrive
 * folder mirrors on its schedule without a manual click.
 *
 * Multi-instance safe: each due source is gated by a per-source `claimIdempotency`
 * slot, so N Cloud Run instances (prod runs `--max-instances`>1) — and a daemon tick
 * overlapping a manual "Sync now" — can't double-run a source and race its diff
 * cursor. Atomic + self-expiring (the slot rotates) + crash-safe, the same pattern
 * the heartbeat/refresh daemons use. A per-tick wall-clock budget keeps one busy
 * tenant from starving the rest.
 */

import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';
import { syncNow } from './knowledgeSyncRunner.js';
import { listActiveSyncSourcesForTenant, type SyncSource, type SyncCadence } from './knowledgeSyncService.js';

const log = createLogger('knowledge-sync');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const TICK_BUDGET_MS = 4 * 60 * 1000;
/** One run per source per 10-min window wins the claim (prevents multi-instance
 *  fan-out + daemon/manual overlap). > the poll interval so a claimed source isn't
 *  re-run on the next tick. */
const CLAIM_SLOT_MS = 10 * 60 * 1000;

const CADENCE_MS: Record<SyncCadence, number> = {
  '15m': 15 * 60 * 1000,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/** Is this source due for a scheduled sync at `now` (ms)? */
export function isSyncDue(source: SyncSource, now: number): boolean {
  if (source.status !== 'active') return false;
  const interval = CADENCE_MS[source.cadence];
  if (!interval) return false;
  const last = source.lastSyncedAt ? Date.parse(source.lastSyncedAt) : 0;
  return !Number.isFinite(last) || now - last >= interval;
}

/** Win the single-runner claim for `sourceId` in the current slot. */
export async function claimSyncRun(storage: Storage, tenantId: string, sourceId: string, now: number): Promise<boolean> {
  const slot = Math.floor(now / CLAIM_SLOT_MS);
  const claim = await storage.claimIdempotency(`knowledge-sync:${tenantId}:${sourceId}:${slot}`, new Date(now).toISOString());
  return claim.claimed;
}

/** One daemon pass: run every due active source across all tenants, under the
 *  per-source claim and a wall-clock budget. Returns the number actually run. */
export async function processDueSyncs(deps: { storage: Storage }, listTenants: () => Promise<string[]>, now: number): Promise<number> {
  const deadline = Date.now() + TICK_BUDGET_MS;
  let ran = 0;
  for (const tenantId of await listTenants()) {
    if (Date.now() >= deadline) break;
    let due: SyncSource[];
    try {
      due = (await listActiveSyncSourcesForTenant(tenantId)).filter((s) => isSyncDue(s, now));
    } catch (err) {
      log.warn('knowledge_sync_tenant_scan_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const source of due) {
      if (Date.now() >= deadline) break;
      if (!(await claimSyncRun(deps.storage, tenantId, source.id, now))) continue;
      try {
        await syncNow(deps, tenantId, source.id, new Date(now).toISOString());
        ran += 1;
      } catch {
        // syncNow records status/lastError on the source; keep going.
      }
    }
  }
  return ran;
}

export interface KnowledgeSyncDaemon { stop: () => void; }

/** Start the polling cadence daemon (mirrors heartbeat/refresh). */
export function startKnowledgeSyncDaemon(deps: { storage: Storage }, listTenants: () => Promise<string[]>): KnowledgeSyncDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processDueSyncs(deps, listTenants, Date.now());
    } catch (err) {
      log.warn('knowledge_sync_daemon_tick_error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  // MKP-6: self-rescheduling timer with ±20% jitter instead of a fixed-boundary
  // setInterval, so N Cloud Run instances don't all poll (and scan every tenant's
  // active sources) on the same wall-clock tick. The claim-idempotency slot already
  // prevents double-runs; jitter spreads the read load.
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const nextDelay = (): number => POLL_INTERVAL_MS * (0.8 + Math.random() * 0.4);
  const schedule = (): void => {
    timer = setTimeout(() => {
      void tick().finally(() => { if (!stopped) schedule(); });
    }, nextDelay());
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();
  log.info('knowledge_sync_daemon_started', { pollIntervalMs: POLL_INTERVAL_MS, jitter: '±20%' });
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}
