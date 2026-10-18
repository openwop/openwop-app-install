/**
 * Offline engine for the ONE generated service worker, `/sw.js` (ADR 0873 D4–D7).
 *
 * Not served as-is: `scripts/gen-service-worker.mjs` includes this file ONLY when
 * the build's offline table is non-empty, after a generated preamble that defines
 * `OFFLINE_CACHE_PREFIX` and `OFFLINE`:
 *
 *   OFFLINE = {
 *     version,       // hash of the precache list and its contents (D6)
 *     shellUrl,      // '/app-shell.html', the post-predeploy shell name (D5)
 *     precache,      // shell + each declared feature's chunk graph + extras
 *     navigations,   // declared route paths; a path matches itself and below
 *     neverCache,    // RegExp sources derived from firebase.json `run` rewrites (D4)
 *     runtime,       // [{ match (RegExp source), strategy, maxEntries }]
 *   }
 *
 * An empty table never includes this file, so that worker has no `fetch`
 * listener at all (D3); `offline-purge.js` runs instead (D11).
 */

const SHELL_CACHE = `${OFFLINE_CACHE_PREFIX}shell-${OFFLINE.version}`;
const RUNTIME_CACHE = `${OFFLINE_CACHE_PREFIX}runtime-${OFFLINE.version}`;
const META_CACHE = `${OFFLINE_CACHE_PREFIX}meta`;
const META_KEY = '/__openwop_offline_versions';
const NEVER_CACHE = OFFLINE.neverCache.map((src) => new RegExp(src));
const RUNTIME = OFFLINE.runtime.map((r) => ({ ...r, re: new RegExp(r.match) }));
const PRECACHED_EXTRAS = new Set(OFFLINE.precache.filter((url) => url !== OFFLINE.shellUrl && !url.startsWith('/assets/')));

function isNeverCache(pathname) {
  return NEVER_CACHE.some((re) => re.test(pathname));
}

function isDeclaredNavigation(pathname) {
  return OFFLINE.navigations.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isHtml(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

// D6 — install the current version atomically. Every response is fetched and
// checked before anything is stored, the shell is stored LAST, and any failure
// deletes the cache, so "the shell is present" means "the whole version is". A
// failure never fails the install: the push handlers must still update, and an
// incomplete version simply leaves offline unavailable for this build.
async function precacheCurrentVersion() {
  const cache = await caches.open(SHELL_CACHE);
  if (await cache.match(OFFLINE.shellUrl)) return;
  try {
    const entries = await Promise.all(OFFLINE.precache.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      // The ** rewrite answers a missing file with 200 text/html; never store that
      // under a script, style or asset name (D6: never HTML for a script).
      if (url !== OFFLINE.shellUrl && isHtml(response)) throw new Error(`${url}: answered with HTML`);
      return [url, response];
    }));
    for (const [url, response] of entries) {
      if (url !== OFFLINE.shellUrl) await cache.put(url, response);
    }
    const shell = entries.find(([url]) => url === OFFLINE.shellUrl);
    if (shell) await cache.put(shell[0], shell[1]);
  } catch (err) {
    await caches.delete(SHELL_CACHE);
    console.warn('[sw] offline precache skipped for this version:', err);
  }
}

// D6 — keep the current and the previous version, purge the rest. The order of
// versions is kept in a small meta cache, since cache names carry no order.
async function retainVersions() {
  const meta = await caches.open(META_CACHE);
  const stored = await meta.match(META_KEY);
  const previous = stored ? await stored.json().catch(() => []) : [];
  const keep = [OFFLINE.version, ...previous.filter((v) => v !== OFFLINE.version)].slice(0, 2);
  await meta.put(META_KEY, new Response(JSON.stringify(keep), { headers: { 'content-type': 'application/json' } }));
  const live = new Set([META_CACHE]);
  for (const v of keep) {
    live.add(`${OFFLINE_CACHE_PREFIX}shell-${v}`);
    live.add(`${OFFLINE_CACHE_PREFIX}runtime-${v}`);
  }
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => name.startsWith(OFFLINE_CACHE_PREFIX) && !live.has(name))
    .map((name) => caches.delete(name)));
  return keep;
}

async function retainedShellCaches() {
  const meta = await caches.open(META_CACHE);
  const stored = await meta.match(META_KEY);
  const versions = stored ? await stored.json().catch(() => [OFFLINE.version]) : [OFFLINE.version];
  return versions.map((v) => `${OFFLINE_CACHE_PREFIX}shell-${v}`);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheCurrentVersion());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    retainVersions(),
    self.registration.navigationPreload ? self.registration.navigationPreload.enable() : undefined,
  ]));
});

// D5 — network-first, with no timeout race. The cached shell is served only when
// the network itself fails; a slow response or an HTTP error passes through.
async function networkFirstNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match(OFFLINE.shellUrl);
    if (shell) return shell;
    throw err;
  }
}

// An undeclared navigation behaves exactly as the network does. It is answered
// here only so the navigation-preload request is used rather than duplicated.
async function passThroughNavigation(event) {
  const preloaded = await event.preloadResponse;
  return preloaded || fetch(event.request);
}

// D6 — hashed assets are immutable by name: serve them from ANY retained version,
// so a tab left open across a deploy still finds its chunks. A miss goes to the
// network unchanged; the worker never manufactures a response.
async function cacheFirstAsset(request) {
  for (const name of await retainedShellCaches()) {
    const cache = await caches.open(name);
    const hit = await cache.match(request);
    if (hit) return hit;
  }
  return fetch(request);
}

// D1 `precache` extras are NOT immutable by name (public files such as marks and
// fonts), so the network wins while it answers and the precached copy is the
// offline fallback.
async function networkFirstExtra(request) {
  try {
    return await fetch(request);
  } catch (err) {
    for (const name of await retainedShellCaches()) {
      const hit = await (await caches.open(name)).match(request);
      if (hit) return hit;
    }
    throw err;
  }
}

async function trimRuntime(cache, rule) {
  const keys = (await cache.keys()).filter((req) => rule.re.test(new URL(req.url).pathname));
  for (const req of keys.slice(0, Math.max(0, keys.length - rule.maxEntries))) await cache.delete(req);
}

async function storeRuntime(rule, request, response) {
  if (!response.ok || isHtml(response)) return;
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response);
  await trimRuntime(cache, rule);
}

async function runtimeStrategy(event, rule) {
  const { request } = event;
  const cache = await caches.open(RUNTIME_CACHE);
  if (rule.strategy === 'swr') {
    const cached = await cache.match(request);
    const network = fetch(request).then(async (response) => {
      await storeRuntime(rule, request, response.clone());
      return response;
    });
    if (cached) {
      event.waitUntil(network.catch(() => undefined));
      return cached;
    }
    return network;
  }
  try {
    const response = await fetch(request);
    await storeRuntime(rule, request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // D4 — cross-origin requests and every Cloud Run rewrite are never touched by
  // the cache, so tenant data cannot reach it.
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (!isNeverCache(url.pathname) && isDeclaredNavigation(url.pathname)) {
      event.respondWith(networkFirstNavigation(event));
    } else {
      event.respondWith(passThroughNavigation(event));
    }
    return;
  }
  if (isNeverCache(url.pathname)) return;
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request));
    return;
  }
  if (PRECACHED_EXTRAS.has(url.pathname)) {
    event.respondWith(networkFirstExtra(request));
    return;
  }
  const rule = RUNTIME.find((r) => r.re.test(url.pathname));
  if (rule) event.respondWith(runtimeStrategy(event, rule));
});
