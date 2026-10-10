/**
 * Web Push service worker for openwop notifications.
 *
 * Handles two events:
 *   - `push`           — incoming push from the BE; render an OS toast
 *   - `notificationclick` — user clicked the toast; focus the tab
 *                            (opening one if none exists) and route
 *                            to `data.actionUrl`
 *
 * Lifecycle:
 *   - registered by the FE at `/sw-push.js` when the user grants
 *     Notifications permission AND clicks "Enable push" in the panel
 *   - the BE sends payloads of the shape
 *       { title, body, tag, type, priority, actionUrl }
 *     mirroring the in-tab toast we already render via the Web
 *     Notifications API
 *
 * Hosted at the FE origin (app.openwop.dev), scope `/` so the
 * notification click can navigate anywhere in the SPA.
 */

self.addEventListener('install', () => {
  // Activate immediately so the first push delivery after subscribe
  // doesn't wait for a tab refresh.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim every open tab so they all start using this SW version.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    // Malformed payload — log via the SW console and bail.
    return;
  }
  const title = String(payload.title ?? 'OpenWOP');
  const body = String(payload.body ?? '');
  const tag = String(payload.tag ?? '');
  const actionUrl = isSafeActionUrl(payload.actionUrl) ? payload.actionUrl : '/inbox';
  const priority = String(payload.priority ?? 'normal');

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Dedupes — same notificationId tag replaces a prior toast
      // instead of stacking two of the same row.
      tag,
      // Stays on screen until dismissed for urgent rows.
      requireInteraction: priority === 'urgent',
      icon: '/OpenWOP.svg',
      badge: '/OpenWOP.svg',
      // Click handler reads this to know where to navigate.
      data: { actionUrl },
    }),
  );
});

/**
 * ADR 0816 D7 — the SPA's `isSafeActionUrl` rule (`src/notifications/actionLabels.ts`),
 * inlined because a service worker cannot import the SPA bundle; a parity test
 * (`src/notifications/__tests__/swPushActionUrlParity.test.ts`) pins the copy.
 * In-app paths only: a leading `/`, not protocol-relative `//`, no backslash,
 * whitespace or control characters, bounded length. Anything else opens the
 * inbox instead — `openWindow` would otherwise follow an absolute URL off-origin.
 */
function isSafeActionUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  if (url.includes('\\') || /\s/.test(url)) return false;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.actionUrl;
  const targetUrl = isSafeActionUrl(raw) ? raw : '/inbox';
  event.waitUntil((async () => {
    // Reuse the open tab when one exists rather than spawning a new
    // one — better UX for users who already have the app open.
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const tab of tabs) {
      // Same-origin tab — focus + navigate via the History API by
      // posting a message the SPA can pick up. Falls back to a hard
      // navigation when the SPA isn't running (rare — tab closed).
      const url = new URL(tab.url);
      if (url.origin === self.location.origin) {
        await tab.focus();
        try {
          tab.postMessage({ type: 'openwop:navigate', actionUrl: targetUrl });
        } catch { /* tab lost focus / closed during postMessage */ }
        return;
      }
    }
    // No open tab — open a new window.
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
