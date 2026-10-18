/**
 * Web Push subscription lifecycle (PR #174).
 *
 * Surface:
 *   - `getPushConfig()`           — read BE config (`{enabled, vapidPublicKey?}`)
 *   - `enablePush(vapidPublicKey)` — register SW, subscribe, POST to BE
 *   - `disablePush(subscriptionId)` — unsubscribe + DELETE on BE
 *   - `getCurrentSubscription()`   — read browser-side subscription state
 *
 * Composes with the existing desktop-notification flow:
 *   1. user clicks "Enable desktop alerts" → grants Notifications perm
 *   2. user clicks "Enable push" → this module's `enablePush` runs
 *
 * Step 2 only makes sense after step 1 because the OS toast is what
 * a push delivers; without Notifications perm the push arrives but
 * the SW can't show it.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { SW_SCOPE, SW_URL } from '../sw/swUrl.js';

export interface PushConfig {
  enabled: boolean;
  vapidPublicKey?: string;
}

export async function getPushConfig(): Promise<PushConfig> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/notifications/push/config`, fetchOpts({}));
  if (!res.ok) return { enabled: false };
  return res.json() as Promise<PushConfig>;
}

/** Read the current browser-side push subscription, if any. Returns
 *  null when the browser doesn't support Push at all or the user
 *  hasn't subscribed yet. */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Subscribe the current browser to push for the signed-in tenant.
 *
 * Sequence:
 *   1. register the SW (idempotent — `register()` returns the existing
 *      registration if one is already active)
 *   2. call `pushManager.subscribe()` with the VAPID public key
 *   3. POST the resulting endpoint + keys to the BE so the emitter
 *      knows where to deliver
 *
 * MUST run inside a user gesture (click handler) — `subscribe()`
 * shares the same gesture requirement as `requestPermission()`.
 */
export async function enablePush(vapidPublicKey: string): Promise<{ subscriptionId: string }> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push not supported in this browser');
  }
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  // Wait for it to become active so `pushManager.subscribe()` doesn't
  // race against the install/activate cycle.
  if (reg.installing || reg.waiting) {
    await new Promise<void>((resolve) => {
      const target = reg.installing ?? reg.waiting;
      if (!target) { resolve(); return; }
      target.addEventListener('statechange', () => {
        if (target.state === 'activated') resolve();
      });
    });
  }
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  const subJson = sub.toJSON();
  const endpoint = subJson.endpoint ?? sub.endpoint;
  const p256dh = subJson.keys?.p256dh ?? '';
  const auth = subJson.keys?.auth ?? '';
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Push subscription is missing endpoint or keys');
  }
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/notifications/push/subscribe`,
    fetchOpts({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authedHeaders() },
      body: JSON.stringify({
        endpoint,
        keys: { p256dh, auth },
        userAgent: navigator.userAgent,
      }),
    }),
  );
  if (!res.ok) {
    const reason = await res.json()
      .then((b: { details?: { reason?: unknown } }) => (typeof b?.details?.reason === 'string' ? b.details.reason : undefined))
      .catch(() => undefined);
    // Roll back the browser subscription so we don't have a dangling
    // browser-side state pointing at a BE that doesn't know about it — EXCEPT
    // when the endpoint is held by someone else (409): this browser's one
    // subscription is THEIR device binding, and unsubscribing it would silently
    // turn their push off (ADR 0816 NTFUX-3).
    if (res.status !== 409) await sub.unsubscribe().catch(() => undefined);
    throw new PushSubscribeError(res.status, reason);
  }
  return res.json() as Promise<{ subscriptionId: string }>;
}

/** ADR 0816 D3 — a subscribe the server refused, with its typed reason
 *  (`push_endpoint_refused` 400 · `push_endpoint_taken` 409). */
export class PushSubscribeError extends Error {
  constructor(readonly status: number, readonly reason: string | undefined) {
    super(`subscribe returned ${status}`);
    this.name = 'PushSubscribeError';
  }
}

/** The caller's OWN server-side device row for this browser's subscription, if
 *  any. ADR 0816 D3 — the list now holds only the caller's devices in the active
 *  workspace, so "the browser has a subscription" no longer means "push reaches
 *  ME here": it may be bound to another account or workspace. */
async function ownServerRow(endpoint: string): Promise<{ subscriptionId: string } | null> {
  const listRes = await fetch(
    `${config.baseUrl}/host/openwop-app/notifications/push/subscriptions`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!listRes.ok) throw new Error(`subscriptions returned ${listRes.status}`);
  const body = (await listRes.json()) as { subscriptions: Array<{ subscriptionId: string; endpoint: string }> };
  return body.subscriptions.find((s) => s.endpoint === endpoint) ?? null;
}

/** Where this browser's push goes: `none` (no browser subscription), `here`
 *  (the caller's own row in this workspace), or `elsewhere` (bound to another
 *  account or workspace). */
export async function currentPushBinding(): Promise<'none' | 'here' | 'elsewhere'> {
  const sub = await getCurrentSubscription();
  if (!sub) return 'none';
  return (await ownServerRow(sub.endpoint)) ? 'here' : 'elsewhere';
}

/** Unsubscribe + DELETE on BE. Returns true if a row was removed on at least
 *  one side. ADR 0816 NTFUX-3 — only a subscription the caller OWNS here is
 *  touched: this browser's one subscription may be another account's device
 *  binding, and unsubscribing it would silently end their push. */
export async function disablePush(): Promise<boolean> {
  const sub = await getCurrentSubscription();
  if (!sub) return false;
  // BE delete keyed by endpoint — the FE doesn't know its own subscriptionId
  // (the BE assigns it on POST). We list our subs and delete the matching one.
  const match = await ownServerRow(sub.endpoint);
  if (!match) return false;
  await fetch(
    `${config.baseUrl}/host/openwop-app/notifications/push/subscriptions/${encodeURIComponent(match.subscriptionId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  try {
    return await sub.unsubscribe();
  } catch {
    return true; // the server row is gone, which is what stops delivery
  }
}

/**
 * `pushManager.subscribe()` requires the VAPID public key as a
 * Uint8Array. The BE returns it as a base64url string; convert here.
 * Source: https://web.dev/articles/push-notifications-subscribing-a-user
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  // Explicit ArrayBuffer (not ArrayBufferLike) so the resulting view
  // satisfies `BufferSource`'s narrower `ArrayBufferView<ArrayBuffer>`
  // arm. The default `new Uint8Array(n)` infers `ArrayBufferLike`
  // which includes `SharedArrayBuffer` and TypeScript rejects that
  // for `pushManager.subscribe`'s `applicationServerKey`.
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
