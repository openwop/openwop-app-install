/**
 * Webhook routes:
 *   GET    /v1/webhooks                — list subscriptions (refs only; no secret)
 *   POST   /v1/webhooks                — register subscription
 *   DELETE /v1/webhooks/{subscriptionId} — unregister
 *   POST   /v1/webhooks/{subscriptionId}/test — fire a signed test delivery
 *
 * Delivery is HMAC-SHA256-signed per spec/v1/webhooks.md §"Signature recipe".
 * Routes ENQUEUE a durable `WebhookDeliveryRecord` per matching subscriber; the
 * background `webhookDeliveryWorker` drains the queue with claim-based leasing
 * (multi-instance-safe) + exponential-backoff retry + dead-lettering, so a
 * process crash or a transient receiver failure no longer drops the delivery.
 * (The signing itself lives in the worker, next to the POST.)
 *
 * Tenant scope (RFC 0093 §A.3): every subscription is owned by the tenant
 * established at registration time (the membership gate below). List, delete,
 * the test fire, AND the delivery fanout are all scoped to that tenant — a
 * subscription receives only events from runs within its tenant, regardless
 * of how broad its `events` filter is. See SECURITY/invariants.yaml
 * `webhook-cross-tenant-isolation`.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
// `RegisterWebhookRequest` / `Response` aren't exported by @openwop/openwop@1.1.1
// even though the in-tree source declares them — define minimal local shapes.
interface RegisterWebhookRequest {
  url: string;
  events: readonly string[];
  secret?: string;
  tags?: readonly string[];
  tenantId?: string;
}
import type { Storage } from '../storage/storage.js';
import { OpenwopError, type EventRecord, type WebhookDeliveryRecord } from '../types.js';
import { getEventLog } from '../executor/eventLog.js';
import { createLogger } from '../observability/logger.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../host/webhookDeliveryWorker.js';
import { isDeniedWebhookHost, webhookPrivateEgressAllowed } from '../host/webhookEgressGuard.js';
import { callerSubject, personalTenantOf, tenantOf } from '../host/requestSubject.js';
import { isWorkspaceMember } from '../host/accessControlService.js';

const log = createLogger('routes.webhooks');

interface Deps {
  storage: Storage;
}

/**
 * Resolve the tenant a webhook operation acts under, enforcing the
 * registration-time membership gate (webhooks.md §Endpoints: "the caller MUST
 * be a member of the tenant the subscription will live under").
 *
 * No explicit tenant ⇒ the caller's ACTIVE tenant (auth-derived; `'default'`
 * for bearer/demo callers). An explicit tenant is honored only when it IS the
 * caller's active/personal tenant or a shared workspace the caller is a
 * member of — anything else is refused 403 (fail closed; a wildcard bearer
 * key does NOT grant membership in arbitrary tenants on this surface).
 */
async function resolveWebhookTenant(req: Request, explicit: string | undefined): Promise<string> {
  const active = tenantOf(req);
  if (explicit === undefined || explicit.length === 0 || explicit === active) return active;
  if (explicit === personalTenantOf(req)) return explicit;
  const subject = callerSubject(req);
  if (subject && (await isWorkspaceMember(subject, explicit))) return explicit;
  throw new OpenwopError(
    'forbidden_tenant',
    'Caller is not a member of the requested tenant.',
    403,
    { tenantId: explicit },
  );
}

export function registerWebhookRoutes(app: Express, deps: Deps): void {
  const { storage } = deps;

  // Subscribe once at boot to fan out events to registered webhooks.
  // The subscription persists for the lifetime of the process.
  getEventLog().subscribe((event) => {
    deliverToSubscribers(storage, event).catch((err) => {
      log.warn('webhook fanout error', { error: err instanceof Error ? err.message : String(err) });
    });
  });

  // List subscriptions — tenant-scoped (RFC 0093 §A.3). Secret is NEVER
  // returned — only refs + metadata, so a leaked list response can't be
  // replayed to forge a signed delivery.
  app.get('/v1/webhooks', async (req, res, next) => {
    try {
      const tenantId = await resolveWebhookTenant(
        req,
        typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
      );
      const subs = await storage.listWebhooks({ tenantId });
      res.status(200).json({
        subscriptions: subs.map((s) => ({
          subscriptionId: s.subscriptionId,
          webhookId: s.subscriptionId,
          url: s.url,
          events: s.events,
          ...(s.tags ? { tags: s.tags } : {}),
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/webhooks', async (req, res, next) => {
    try {
      const body = req.body as RegisterWebhookRequest;
      // Validate required fields per spec/v1/webhooks.md §"Subscription".
      // Per conformance: missing/malformed inputs return 400 validation_error.
      if (!body || typeof body !== 'object') {
        throw new OpenwopError('validation_error', 'Request body must be a JSON object.', 400);
      }
      if (typeof body.url !== 'string' || body.url.length === 0) {
        throw new OpenwopError('validation_error', 'Field `url` is required and MUST be a non-empty string.', 400, {
          field: 'url',
        });
      }
      assertReachableUrl(body.url);
      // events[] is structurally optional per the openwop spec — sample
      // requires non-empty for clarity but uses validation_error code.
      if (!Array.isArray(body.events) || body.events.length === 0) {
        throw new OpenwopError('validation_error', 'Field `events` MUST be a non-empty string array.', 400, {
          field: 'events',
        });
      }
      // Registration-time membership gate (webhooks.md §Endpoints + RFC 0093
      // §A.3): the tenant resolved here owns the subscription and scopes its
      // delivery for its whole lifetime.
      const tenantId = await resolveWebhookTenant(
        req,
        typeof body.tenantId === 'string' ? body.tenantId : undefined,
      );
      const subscriptionId = randomUUID();
      const secret = body.secret ?? randomBytes(32).toString('base64url');
      await storage.insertWebhook({
        subscriptionId,
        tenantId,
        url: body.url,
        events: body.events,
        tags: body.tags,
        secret,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json({
        subscriptionId,
        // Spec field name (webhooks.md §Register response); `subscriptionId`
        // is kept as the host's historical alias.
        webhookId: subscriptionId,
        url: body.url,
        events: body.events,
        ...(body.secret ? {} : { secret }),
        // First 8 hex of sha256(secret) — log-safe cross-reference handle
        // per webhooks.md §Register / §Logging discipline.
        secretFingerprint: createHash('sha256').update(secret).digest('hex').slice(0, 8),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/webhooks/:subscriptionId', async (req, res, next) => {
    try {
      // Tenant scope per webhooks.md §Unregister: 403 when the caller is not
      // a member of the requested tenant; 404 when the subscription doesn't
      // exist IN THAT TENANT (a foreign tenant's subscription is invisible —
      // existence is not leaked across tenants).
      const tenantId = await resolveWebhookTenant(
        req,
        typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
      );
      const sub = await storage.getWebhook(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantId) {
        throw new OpenwopError(
          'subscription_not_found',
          `Webhook subscription ${req.params.subscriptionId} not found.`,
          404,
          { subscriptionId: req.params.subscriptionId },
        );
      }
      await storage.deleteWebhook(req.params.subscriptionId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // Enqueue a synthetic, HMAC-signed `webhook.test` delivery to the
  // subscription's URL so an operator can verify reachability + signature
  // handling end-to-end. The 202 means "test delivery enqueued", not "endpoint
  // acknowledged" — the worker delivers (and retries) it asynchronously.
  app.post('/v1/webhooks/:subscriptionId/test', async (req, res, next) => {
    try {
      const tenantId = await resolveWebhookTenant(
        req,
        typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined,
      );
      const sub = await storage.getWebhook(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantId) {
        throw new OpenwopError(
          'subscription_not_found',
          `Webhook subscription ${req.params.subscriptionId} not found.`,
          404,
          { subscriptionId: req.params.subscriptionId },
        );
      }
      const testEvent: EventRecord = {
        eventId: randomUUID(),
        runId: 'webhook-test',
        sequence: 0,
        type: 'webhook.test',
        payload: { message: 'OpenWOP webhook test delivery', subscriptionId: sub.subscriptionId },
        timestamp: new Date().toISOString(),
      };
      await enqueueDelivery(storage, sub, testEvent);
      res.status(202).json({
        subscriptionId: sub.subscriptionId,
        url: sub.url,
        dispatched: true,
        eventType: 'webhook.test',
      });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Fan one emitted event out to matching subscriptions — tenant-scoped per
 * RFC 0093 §A.3: only subscriptions whose `tenantId` equals the originating
 * RUN's tenant match. An event whose run can't be resolved (synthetic /
 * pre-run events) is attributed to the `'default'` tenant — never broadcast
 * across tenants.
 */
async function deliverToSubscribers(storage: Storage, event: EventRecord): Promise<void> {
  const run = await storage.getRun(event.runId);
  const tenantId = run?.tenantId ?? 'default';
  const subscribers = await storage.listWebhooks({ eventType: event.type, tenantId });
  for (const sub of subscribers) {
    await enqueueDelivery(storage, sub, event);
  }
}

/** Test-only seam: exports the fanout so the RFC 0093 §A.3 cross-tenant
 *  delivery-negative regression can drive it directly. Production callers go
 *  through the event-log subscription registered above. */
export const __deliverToSubscribersForTests = deliverToSubscribers;

/**
 * Enqueue one durable delivery row. The `secret` is captured here (the
 * subscription may be deleted before the worker delivers) and the event is
 * serialized into the exact `payload` body the worker will POST. The worker
 * (`webhookDeliveryWorker`) signs + delivers + retries with backoff.
 */
async function enqueueDelivery(
  storage: Storage,
  sub: { subscriptionId: string; url: string; secret: string },
  event: EventRecord,
): Promise<void> {
  const now = Date.now();
  const record: WebhookDeliveryRecord = {
    deliveryId: randomUUID(),
    subscriptionId: sub.subscriptionId,
    url: sub.url,
    secret: sub.secret,
    eventType: event.type,
    payload: JSON.stringify(event),
    status: 'pending',
    attempts: 0,
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    nextAttemptAt: now,
    claimedBy: null,
    claimExpiresAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  await storage.enqueueWebhookDelivery(record);
}

export function assertReachableUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OpenwopError('validation_error', `Webhook url is not a valid URL.`, 400, { field: 'url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OpenwopError('webhook_url_rejected', `Webhook url must be http: or https:.`, 400, {
      reason: 'unsupported_protocol',
      protocol: parsed.protocol,
    });
  }
  // SSRF guard — always on per spec/v1/webhooks.md §"SSRF guard".
  // Refuses obvious loopback / link-local / RFC 1918 hostnames + IPs via the
  // SAME denied-range predicate the delivery worker re-validates resolved
  // addresses against (host/webhookEgressGuard.ts — one predicate, no drift;
  // RFC 0093 §A.1). Operators can override via OPENWOP_WEBHOOK_ALLOW_PRIVATE=true
  // for local development / testing only — honored at BOTH layers.
  if (webhookPrivateEgressAllowed()) return;
  const hostname = parsed.hostname.toLowerCase();
  if (isDeniedWebhookHost(hostname)) {
    throw new OpenwopError(
      'webhook_url_rejected',
      `Webhook url host "${hostname}" is denied (loopback / link-local / private-IP).`,
      400,
      { reason: 'ssrf_guard', host: hostname },
    );
  }
}
