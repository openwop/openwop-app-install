/**
 * The legacy-cache purge (ADR 0873 D13). Included only when the build sets
 * `VITE_SW_LEGACY_CACHE_PURGE`; the default build carries none of this.
 *
 * A distribution that replaces an older app at the same origin inherits that
 * app's worker registration at `/sw.js`. The browser's update check installs
 * this worker over it, but the old worker's caches stay, and the tab that the
 * old worker served is still running the old app: a Workbox worker answers the
 * navigation from its precached HTML, so the first visit after a cutover shows
 * the old build (often a blank page, once its lazy chunks are gone).
 *
 * On activate this deletes every cache `LEGACY_CACHE_PURGE` names. When it
 * deleted one, the browser was running the old app, so it claims the open tabs
 * and reloads them onto the network. Once the caches are gone nothing matches,
 * so a browser is reloaded at most once, and a browser that never ran the old
 * app is never reloaded.
 *
 * `LEGACY_CACHE_PURGE` (`{ names, prefixes }`) is defined by the generated preamble.
 */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const legacy = (await caches.keys()).filter((name) => LEGACY_CACHE_PURGE.names.includes(name)
      || LEGACY_CACHE_PURGE.prefixes.some((prefix) => name.startsWith(prefix)));
    if (legacy.length === 0) return;
    await Promise.all(legacy.map((name) => caches.delete(name)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map((client) => client.navigate(client.url).catch(() => undefined)));
  })());
});
