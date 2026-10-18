/**
 * ADR 0873 D8 — purge every offline cache on sign-out; never unregister.
 *
 * The page deletes the caches itself through CacheStorage, which it shares with
 * the worker, so the purge does not depend on a worker being installed or
 * awake. Unregistering is not an option: the push subscription belongs to the
 * registration. D4 already keeps tenant data out of these caches; this is
 * defence in depth, so no shell outlives the session on a shared machine.
 */

/** Pinned equal to `OFFLINE_CACHE_PREFIX` in `scripts/gen-service-worker.mjs`. */
export const OFFLINE_CACHE_PREFIX = 'openwop-offline-';

/** Delete every offline cache. Never throws; a no-op where CacheStorage is absent. */
export async function purgeOfflineCaches(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(OFFLINE_CACHE_PREFIX)).map((n) => caches.delete(n)));
  } catch {
    // Storage blocked or unavailable: nothing was cached either.
  }
}
