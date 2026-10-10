/**
 * Per-tenant operation lock (ADR 0837 D3, extracted from the SEED lock).
 *
 * Serializes one kind of operation per tenant across instances: a second caller
 * gets `false` (the wrapper turns that into a 409) instead of racing. Built on
 * the atomic `kvCompareAndSwap` primitive. A lock left by a request the platform
 * killed expires after `ttlMs` and the next caller steals it, so a crash never
 * wedges the tenant.
 *
 * Two corrections over the seed lock this was lifted from (ADR 0837 architect
 * pass A2):
 *   - The held value is a TOKEN (`<ms>:<uuid>`), not a bare timestamp, so two
 *     acquirers in the same millisecond never hold the same value.
 *   - Release is a CAS from THAT token to a `released` sentinel, never a blind
 *     delete. The seed lock's `kvDelete` meant: holder X outlives the TTL, Y
 *     steals it, X's `finally` deletes Y's lock, and Z acquires while Y is still
 *     running. `Storage` has no compare-and-delete, so the sentinel stands in for
 *     "absent"; acquire treats `null` and `released` alike.
 * A holder whose release CAS loses (it was stolen) logs `tenant_op_lock_lost`,
 * the one signal that a TTL was sized below a real run.
 */

import { randomUUID } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.tenantOpLock');

const RELEASED = 'released';

function heldSinceMs(token: string): number {
  return Number(token.split(':')[0]);
}

/** Claim `key`. Returns the held token, or null when a live holder has it. */
async function acquire(storage: Storage, key: string, ttlMs: number): Promise<string | null> {
  const nowMs = Date.now();
  const token = `${nowMs}:${randomUUID()}`;
  const fresh = await storage.kvCompareAndSwap(key, null, token);
  if (fresh.swapped) return token;
  const actual = fresh.actual;
  if (actual === null) {
    // Lost a race with a releaser that then vanished — one more insert attempt.
    return (await storage.kvCompareAndSwap(key, null, token)).swapped ? token : null;
  }
  // Free (a released sentinel) or stale (its holder was killed): take it by a CAS
  // on the exact value observed, so a holder that just took it is never stomped.
  const heldMs = heldSinceMs(actual);
  const stale = actual !== RELEASED && Number.isFinite(heldMs) && nowMs - heldMs > ttlMs;
  if (actual !== RELEASED && !stale) return null;
  const taken = await storage.kvCompareAndSwap(key, actual, token);
  if (!taken.swapped) return null;
  if (stale) log.warn('tenant_op_lock_stolen', { key, ageMs: nowMs - heldMs });
  return token;
}

async function release(storage: Storage, key: string, token: string): Promise<void> {
  try {
    const out = await storage.kvCompareAndSwap(key, token, RELEASED);
    if (!out.swapped) log.warn('tenant_op_lock_lost', { key });
  } catch (err) {
    log.warn('tenant_op_lock_release_failed', { key, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Run `fn` holding `key`. Returns `{ held: false }` without running `fn` when a
 * live holder has the lock; the caller decides the refusal (a typed 409). The
 * lock is released once `fn` settles or throws.
 */
export async function withTenantOpLock<T>(
  storage: Storage,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ held: true; value: T } | { held: false }> {
  const token = await acquire(storage, key, ttlMs);
  if (token === null) return { held: false };
  try {
    return { held: true, value: await fn() };
  } finally {
    await release(storage, key, token);
  }
}
