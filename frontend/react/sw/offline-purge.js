/**
 * The empty-table half of the offline seam (ADR 0873 D3 + D11).
 *
 * `scripts/gen-service-worker.mjs` includes this file instead of
 * `offline-engine.js` when no feature declares `offline`. It adds NO `fetch`
 * listener: a pass-through listener would still start the worker for every
 * request. On activate it deletes every offline cache and turns navigation
 * preload off, so shipping an empty-table build IS the rollback: an installed
 * client picks it up at its next update check (D10 `no-cache`) and is left
 * with nothing an older offline build stored.
 *
 * `OFFLINE_CACHE_PREFIX` is defined by the generated preamble.
 */

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(names
      .filter((name) => name.startsWith(OFFLINE_CACHE_PREFIX))
      .map((name) => caches.delete(name)))),
    self.registration.navigationPreload ? self.registration.navigationPreload.disable() : undefined,
  ]));
});
