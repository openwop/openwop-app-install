/**
 * Web Push (RFC 8030) wrapper around the `web-push` npm library.
 *
 * Two config knobs via env vars:
 *   OPENWOP_VAPID_PUBLIC_KEY   — base64url EC P-256 public key
 *   OPENWOP_VAPID_PRIVATE_KEY  — base64url EC P-256 private key
 *   OPENWOP_VAPID_SUBJECT      — mailto: or https: URL the push
 *                                 service contacts the app operator
 *                                 at if a delivery misbehaves
 *
 * Generate the keypair once at deploy time:
 *
 *   npx web-push generate-vapid-keys
 *
 * Store both as Secret Manager secrets and bind to the Cloud Run
 * env (see `DEPLOY.md` for the pattern). The
 * public key is also served via discovery (`/.well-known/openwop`)
 * so the FE can pass it to `pushManager.subscribe()` without
 * hard-coding it in the bundle.
 *
 * When the env vars are absent the module loads but every `pushTo()`
 * call no-ops — useful for local dev where setting up VAPID is
 * friction, and for the in-memory smoke tests.
 */

import webpush from 'web-push';
import type { Storage } from '../storage/storage.js';
import type { NotificationRecord, PushSubscriptionRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { isDevicePushSuppressed } from '../host/notificationPolicy.js';
import { isCurrentNotificationAudience } from './audience.js';
import { pushEndpointRefusal } from './pushEndpointPolicy.js';

const log = createLogger('notifications.webPush');

let configured = false;
let publicKey: string | null = null;

/**
 * Read the VAPID config from env and call `webpush.setVapidDetails`.
 * Idempotent — calling twice is a no-op after the first success.
 * Returns true when push is wired and emit calls will actually deliver.
 */
export function configureWebPush(): boolean {
  if (configured) return true;
  const pub = process.env.OPENWOP_VAPID_PUBLIC_KEY;
  const priv = process.env.OPENWOP_VAPID_PRIVATE_KEY;
  const subj = process.env.OPENWOP_VAPID_SUBJECT ?? 'mailto:admin@openwop.dev';
  if (!pub || !priv) {
    log.info('web-push disabled — OPENWOP_VAPID_{PUBLIC,PRIVATE}_KEY env vars not set');
    return false;
  }
  webpush.setVapidDetails(subj, pub, priv);
  publicKey = pub;
  configured = true;
  log.info('web-push configured', { vapidSubject: subj });
  return true;
}

/** The VAPID public key, after `configureWebPush()` has run. Exposed
 *  via discovery so the FE can pass it to `pushManager.subscribe()`.
 *  Returns null when push is disabled. */
export function getVapidPublicKey(): string | null {
  return publicKey;
}

/**
 * Deliver a notification to every active subscription owned by the
 * notification's tenant.
 *
 * Errors are swallowed at the per-subscription level — one stale
 * browser shouldn't abort fanout to the user's other devices. 410
 * Gone responses (subscription expired / revoked) are common and
 * trigger a row delete so the same dead endpoint isn't tried on
 * every future notification.
 */
export async function pushNotification(
  storage: Storage,
  notification: NotificationRecord,
): Promise<{ delivered: number; pruned: number }> {
  if (!configured) return { delivered: 0, pruned: 0 };
  const allSubs = await storage.listPushSubscriptions(notification.tenantId);
  return deliverToSubs(storage, notification, filterSubsForRecipient(notification, allSubs));
}

/**
 * ADR 0214 D3 — BATCHED fan-out: deliver many records (all the SAME tenant) while
 * loading the tenant's subscription table ONCE. The per-record `pushNotification`
 * re-scans that table on every call, so an N-member channel post would be N scans;
 * this collapses it to one. Per-record delivery is otherwise identical (addressed
 * filter + dead-endpoint prune).
 */
export async function pushNotificationsBatch(
  storage: Storage,
  notifications: NotificationRecord[],
): Promise<{ delivered: number; pruned: number }> {
  if (!configured || notifications.length === 0) return { delivered: 0, pruned: 0 };
  const allSubs = await storage.listPushSubscriptions(notifications[0]!.tenantId);
  let delivered = 0;
  let pruned = 0;
  const cache: GateCache = new Map();
  for (const n of notifications) {
    const r = await deliverToSubs(storage, n, filterSubsForRecipient(n, allSubs), cache);
    delivered += r.delivered;
    pruned += r.pruned;
  }
  return { delivered, pruned };
}

/** ADR 0050 — an addressed notification pushes ONLY to its recipient's devices;
 *  legacy owner-less subs (no userId) receive broadcasts only. A broadcast (no
 *  recipientUserId, no recipientRole) still fans out to every tenant device.
 *
 *  ADR 0816 D1 — an UNADDRESSED role row reaches nobody's device. The inbox has
 *  always default-denied it to non-holders; this lane used to treat it as a
 *  broadcast, so an operator notice reached every member's phone (NTFWF-1). In a
 *  shared workspace the emitter now materialises role notices per holder, so an
 *  unaddressed role row only survives where nobody could be resolved — and then
 *  default-deny is the inbox's own answer. */
function filterSubsForRecipient(n: NotificationRecord, allSubs: readonly PushSubscriptionRecord[]): readonly PushSubscriptionRecord[] {
  if (n.recipientUserId) return allSubs.filter((s) => s.userId === n.recipientUserId);
  if (n.recipientRole) return [];
  return allSubs;
}

/**
 * ADR 0816 D3/D4/D5 — the per-device gates, applied at delivery to every
 * subscription the audience filter kept:
 *  - D3: the endpoint still satisfies the endpoint policy (a row stored before
 *    the policy existed stops egressing rather than being grandfathered);
 *  - D4: in a shared workspace the device's owner is still a member (a removal
 *    cascade on another instance may not have run yet);
 *  - D5: the owner's preferences allow a device toast for this notice now.
 */
async function deliverableSubs(
  notification: NotificationRecord,
  subs: readonly PushSubscriptionRecord[],
  cache: GateCache = new Map(),
): Promise<PushSubscriptionRecord[]> {
  const gate = (sub: PushSubscriptionRecord): Promise<boolean> => {
    // Per (device owner, type, priority): a batch is usually ONE notice fanned
    // out per person, so each owner's membership + prefs are read once.
    const key = `${sub.userId ?? ''}|${notification.type}|${notification.priority}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        if (!(await isCurrentNotificationAudience(notification.tenantId, sub.userId))) return false;
        if (sub.userId && await isDevicePushSuppressed(notification.tenantId, sub.userId, {
          type: notification.type, priority: notification.priority,
        })) return false;
        return true;
      })();
      cache.set(key, pending);
    }
    return pending;
  };
  const verdicts = await Promise.all(subs.map(async (sub) =>
    pushEndpointRefusal(sub.endpoint) === null && await gate(sub)));
  return subs.filter((_, i) => verdicts[i]);
}

/** Per-call memo of the D4/D5 gates, keyed `${userId}|${type}|${priority}`. */
type GateCache = Map<string, Promise<boolean>>;

/** Send ONE record's payload to a pre-filtered subscription list, pruning dead
 *  (404/410) endpoints. The shared core of the single + batched push paths. */
async function deliverToSubs(
  storage: Storage,
  notification: NotificationRecord,
  subs: readonly PushSubscriptionRecord[],
  cache?: GateCache,
): Promise<{ delivered: number; pruned: number }> {
  const gated = await deliverableSubs(notification, subs, cache);
  if (gated.length === 0) return { delivered: 0, pruned: 0 };
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.message,
    tag: notification.notificationId,
    type: notification.type,
    priority: notification.priority,
    actionUrl: notification.actionUrl ?? null,
  });
  let delivered = 0;
  let pruned = 0;
  await Promise.all(gated.map(async (sub) => {
    try {
      await webpush.sendNotification(toWebPushSubscription(sub), payload, {
        // Higher urgency for action-needed types so battery-saving browsers deliver promptly.
        urgency: notification.priority === 'urgent' || notification.priority === 'high' ? 'high' : 'normal',
        // TTL: low (4h) so a phone offline for a day doesn't get a stale stack on reconnect.
        TTL: 4 * 60 * 60,
      });
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Subscription is dead (uninstalled extension, revoked perm).
        try { await storage.deletePushSubscription(sub.subscriptionId); pruned++; } catch { /* best-effort */ }
      } else {
        // Don't log the error message — push services occasionally include endpoint URLs (sensitive).
        log.warn('web-push delivery failed', { subscriptionId: sub.subscriptionId, status });
      }
    }
  }));
  return { delivered, pruned };
}

function toWebPushSubscription(sub: PushSubscriptionRecord): webpush.PushSubscription {
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
  };
}
