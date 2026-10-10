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
import { withTenantOpLock } from './tenantOpLock.js';

/** A held lock older than this is assumed orphaned (its request was killed
 *  mid-run) and may be stolen. Sized well above the longest full reseed so a
 *  genuinely-running seed is never stolen out from under itself. */
const LOCK_TTL_MS = 60 * 60 * 1000; // 1 hour

function lockKey(tenantId: string): string {
  return `demo-seed-lock:${tenantId}`;
}

/**
 * Run `fn` while holding the per-tenant seed lock. Throws a 409 `conflict` when a
 * seed is already running for the tenant (the concurrent-re-click case). The lock
 * is always released once `fn` settles (or throws).
 *
 * ADR 0837 D3 — the acquire/steal/release now live in `tenantOpLock.ts`, shared
 * with the CRM merge lock. Same key and TTL; the release is a CAS on this
 * holder's token rather than a blind delete (architect A2: a delete after a steal
 * freed the NEW holder's lock).
 */
export async function withSeedLock<T>(storage: Storage, tenantId: string, fn: () => Promise<T>): Promise<T> {
  const out = await withTenantOpLock(storage, lockKey(tenantId), LOCK_TTL_MS, fn);
  if (!out.held) {
    throw new OpenwopError(
      'conflict',
      'A demo seed is already running for this workspace. Wait for it to finish before starting another.',
      409,
      { tenantId },
    );
  }
  return out.value;
}
