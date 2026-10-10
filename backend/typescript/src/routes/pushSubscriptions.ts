/**
 * Web Push subscription routes (PR #174).
 *
 *   POST   /v1/host/openwop-app/notifications/push/subscribe
 *     body: { endpoint, keys: { p256dh, auth }, userAgent? }
 *     → 201 { subscriptionId }
 *
 *   DELETE /v1/host/openwop-app/notifications/push/subscriptions/:id
 *     → 204; 404 when the id is unknown or not owned by the caller
 *
 *   GET    /v1/host/openwop-app/notifications/push/subscriptions
 *     → 200 { subscriptions: [{ subscriptionId, endpoint, createdAt, userAgent? }] }
 *     — the CALLER's own devices only; the `keys` are never returned (treated
 *     like credentials — which is what makes them a proof of possession below).
 *
 * ADR 0816 D3 — a device belongs to a person:
 *   - the endpoint must satisfy `pushEndpointRefusal` (https, a known push
 *     service; no attacker-chosen egress target);
 *   - an endpoint already held by ANOTHER person rebinds only when the request
 *     presents the stored `p256dh`/`auth` keys (a second person signing in on the
 *     same browser does exactly that); otherwise 409 `push_endpoint_taken`;
 *   - list and delete see only the caller's own devices (wildcard: the tenant);
 *   - removal from a workspace deletes the member's devices there
 *     (`registerPushSubscriptionRemovalCascade`).
 *
 * Vendor-prefixed for the same reason the notification surface is:
 * not a normative openwop v1 spec, just the sample-host's add-on
 * (see `host-extensions.md`).
 *
 * Tenant scope follows the rest of the notification surface: every
 * action is authorized against `req.tenantId`, wildcard principals
 * can pass `?tenantId=foo` to operate on a specific tenant.
 */

import type { Express, Request } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import { OpenwopError, type PushSubscriptionRecord } from '../types.js';
import { getVapidPublicKey } from '../notifications/webPush.js';
import { notificationSubject } from '../notifications/audience.js';
import { pushEndpointRefusal } from '../notifications/pushEndpointPolicy.js';
import { isWorkspaceRootPair, onMemberAuthorityLost } from '../host/accessControlService.js';
import { subjectKeyForms } from '../host/subjectErasureRedaction.js';

const BASE = '/host/openwop-app/notifications/push';

interface Deps {
  storage: Storage;
}

export function registerPushSubscriptionRoutes(app: Express, deps: Deps): void {
  const { storage } = deps;

  // Config endpoint — exposes the VAPID public key so the FE can pass
  // it to `pushManager.subscribe()` without hard-coding it in the
  // bundle. Returns `{enabled: false}` when the BE doesn't have VAPID
  // env vars configured (local dev), so the FE can hide the affordance.
  // Unauthenticated — the public key is public by definition.
  app.get(`${BASE}/config`, (_req, res) => {
    const vapidPublicKey = getVapidPublicKey();
    if (vapidPublicKey) {
      res.json({ enabled: true, vapidPublicKey });
    } else {
      res.json({ enabled: false });
    }
  });

  app.post(`${BASE}/subscribe`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      if (!tenantId) throw new OpenwopError('unauthenticated', 'sign in to enable push', 401);
      const body = req.body as {
        endpoint?: unknown;
        keys?: { p256dh?: unknown; auth?: unknown };
        userAgent?: unknown;
      };
      const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
      const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
      const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
      const userAgent = typeof body.userAgent === 'string' ? body.userAgent : undefined;
      if (!endpoint || !p256dh || !auth) {
        throw new OpenwopError(
          'validation_error',
          'endpoint + keys.p256dh + keys.auth are required',
          400,
        );
      }

      // ADR 0816 D3 — the backend POSTs to this URL on every notification, so
      // it must be a real Web Push service, never a caller-chosen target.
      const refusal = pushEndpointRefusal(endpoint);
      if (refusal) {
        throw new OpenwopError('validation_error', `Push endpoint refused: ${refusal}.`, 400, { reason: 'push_endpoint_refused' });
      }

      const subscriptionId = randomBytes(16).toString('hex');
      // ADR 0050 — record the owning user so addressed notifications push only
      // to their devices. ADR 0816 D0 — the same subject every notification lane
      // keys on. May be absent for a tenanted non-user principal.
      const userId = notificationSubject(req) ?? req.principal?.principalId;

      // ADR 0816 D3 — no re-homing someone else's device. The upsert below is
      // ON CONFLICT(endpoint), which moves the row's tenant + user; that is
      // right for the SAME person moving their browser between workspaces, and
      // for a second person on the same browser (who presents the same keys,
      // because the browser hands every page the same subscription). Anyone
      // else learned the endpoint somewhere and holds none of the keys.
      const existing = await storage.getPushSubscriptionByEndpoint(endpoint);
      if (existing && existing.userId !== userId
        && !(sameSecret(existing.p256dhKey, p256dh) && sameSecret(existing.authKey, auth))) {
        throw new OpenwopError('conflict', 'This push endpoint is registered to another device owner.', 409, { reason: 'push_endpoint_taken' });
      }
      const record: PushSubscriptionRecord = {
        subscriptionId,
        tenantId,
        ...(userId ? { userId } : {}),
        endpoint,
        p256dhKey: p256dh,
        authKey: auth,
        userAgent,
        createdAt: new Date().toISOString(),
      };
      await storage.insertPushSubscription(record);
      res.status(201).json({ subscriptionId });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/subscriptions`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      if (!tenantId) {
        res.json({ subscriptions: [] });
        return;
      }
      // ADR 0816 D3 — your own devices only; the wildcard principal keeps the
      // tenant view.
      const owner = ownerFilter(req);
      const subs = (await storage.listPushSubscriptions(tenantId))
        .filter((s) => owner === undefined || s.userId === owner);
      // Project — never return `p256dhKey` / `authKey` since they're
      // effectively credentials. The FE only needs the id + endpoint
      // for listing / revoke flows.
      res.json({
        subscriptions: subs.map((s) => ({
          subscriptionId: s.subscriptionId,
          endpoint: s.endpoint,
          userAgent: s.userAgent,
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/subscriptions/:id`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      if (!tenantId) throw new OpenwopError('unauthenticated', 'sign in to manage push', 401);
      // Look up by id + verify tenant AND owner before delete — a leaked
      // subscriptionId must not revoke another person's device (ADR 0816 D3).
      // 404-on-mismatch hides existence.
      const owner = ownerFilter(req);
      const match = (await storage.listPushSubscriptions(tenantId))
        .find((s) => s.subscriptionId === req.params.id && (owner === undefined || s.userId === owner));
      if (!match) throw new OpenwopError('not_found', 'subscription not found', 404);
      await storage.deletePushSubscription(match.subscriptionId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}

function resolveTenant(req: Request): string | undefined {
  const tenants = req.principal?.tenants ?? [];
  const wildcard = tenants.includes('*');
  const requestedTenant = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  return wildcard ? requestedTenant : (req.tenantId ?? undefined);
}

/** ADR 0816 D3 — whose devices a request may see / delete. `undefined` = the
 *  wildcard principal's tenant view. A non-wildcard caller with no subject owns
 *  nothing (`''` matches no row). */
function ownerFilter(req: Request): string | undefined {
  if ((req.principal?.tenants ?? []).includes('*')) return undefined;
  return notificationSubject(req) ?? req.principal?.principalId ?? '';
}

/**
 * ADR 0816 D3 — removal from a workspace takes the member's devices there with
 * it. Hygiene, not the guard: delivery re-checks membership (D4), because a
 * cascade can fail or not yet have run on another instance. Matches every
 * spelling the subject's rows may carry (`subjectKeyForms`), never an alias
 * across people. Only a ROOT membership removal counts — leaving a sub-org is
 * not leaving the workspace.
 */
export function registerPushSubscriptionRemovalCascade(storage: Storage): void {
  onMemberAuthorityLost('notifications.push-subscriptions', async (lost) => {
    if (lost.reason !== 'removed' || !isWorkspaceRootPair(lost.orgId, lost.tenantId)) return 0;
    const { forms } = subjectKeyForms(lost.subject);
    let removed = 0;
    for (const sub of await storage.listPushSubscriptions(lost.tenantId)) {
      if (sub.userId && forms.has(sub.userId) && await storage.deletePushSubscription(sub.subscriptionId)) removed++;
    }
    return removed;
  });
}

/** Constant-time compare for the subscription keys used as proof of possession. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
