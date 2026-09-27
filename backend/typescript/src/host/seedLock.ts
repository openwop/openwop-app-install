/**
 * Per-tenant demo-seed lock (SEED concurrency fix).
 *
 * Every demo seeder guards each create with a read-then-create-by-name/key/id
 * check. That is idempotent for a SEQUENTIAL re-run, but it is NOT atomic across
 * CONCURRENT runs: when a user mashes "Provision demo tenant" — because the long
 * full reseed looks stuck (it outruns Cloud Run's request-duration cap) — two
 * overlapping seed passes on different instances each read "absent" and each
 * create, duplicating rows across many entity types (advisory boards are the
 * worst, since `createBoard` auto-uniquifies its handle so even the service's own
 * dedupe can't collapse them). This lock serializes seeding per tenant so
 * re-clicks can't overlap: a second concurrent run gets a clean 409 instead of
 * racing.
 *
 * Built on the atomic `kvCompareAndSwap` primitive — the same building block the
 * first-seed marker in `exampleDataSeed.ts` uses. A lock left behind by a request
 * the platform KILLED (the request-timeout cap) auto-expires after `LOCK_TTL_MS`
 * and the next caller steals it, so a crashed provision never wedges the tenant.
 */

import type { Storage } from '../storage/storage.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.seedLock');

/** A held lock older than this is assumed orphaned (its request was killed
 *  mid-run) and may be stolen. Sized well above the longest full reseed so a
 *  genuinely-running seed is never stolen out from under itself. */
const LOCK_TTL_MS = 60 * 60 * 1000; // 1 hour

function lockKey(tenantId: string): string {
  return `demo-seed-lock:${tenantId}`;
}

/** Claim the lock. Returns true iff acquired. Steals a stale (orphaned) lock via
 *  a CAS on its exact value, so a live run that just refreshed is never stomped. */
async function acquire(storage: Storage, tenantId: string): Promise<boolean> {
  const key = lockKey(tenantId);
  const nowMs = Date.now();
  const claim = await storage.kvCompareAndSwap(key, null, String(nowMs));
  if (claim.swapped) return true;
  // A lock is held — steal it only if it is stale (the prior holder was killed
  // without releasing). `claim.actual` is the value observed at the CAS above.
  const heldMs = claim.actual ? Number(claim.actual) : NaN;
  if (claim.actual && Number.isFinite(heldMs) && nowMs - heldMs > LOCK_TTL_MS) {
    const steal = await storage.kvCompareAndSwap(key, claim.actual, String(nowMs));
    if (steal.swapped) {
      log.warn('seed_lock_stolen', { tenantId, ageMs: nowMs - heldMs });
      return true;
    }
  }
  return false;
}

async function release(storage: Storage, tenantId: string): Promise<void> {
  await storage.kvDelete(lockKey(tenantId)).catch((err) => {
    log.warn('seed_lock_release_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * Run `fn` while holding the per-tenant seed lock. Throws a 409 `conflict` when a
 * seed is already running for the tenant (the concurrent-re-click case). The lock
 * is always released once `fn` settles (or throws).
 */
export async function withSeedLock<T>(storage: Storage, tenantId: string, fn: () => Promise<T>): Promise<T> {
  if (!(await acquire(storage, tenantId))) {
    throw new OpenwopError(
      'conflict',
      'A demo seed is already running for this workspace. Wait for it to finish before starting another.',
      409,
      { tenantId },
    );
  }
  try {
    return await fn();
  } finally {
    await release(storage, tenantId);
  }
}
