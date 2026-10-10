/**
 * Webhook routes:
 *   GET    /v1/webhooks                — list subscriptions (refs only; no secret)
 *   POST   /v1/webhooks                — register subscription
 *   DELETE /v1/webhooks/{subscriptionId} — unregister
 *   POST   /v1/webhooks/{subscriptionId}/test — fire a signed test delivery
 *   POST   /v1/webhooks/{subscriptionId}/rotate-secret — RFC 0201 §E rotation
 *
 * RFC 0201 (ADR 0747): a registration MAY opt into the `standard-webhooks-1`
 * companion scheme via `signatureAlgorithms`; it then carries a caller-supplied
 * `whsec_` secret and is verified (one signed challenge) before it is stored.
 * A registration that does not opt in is untouched by every part of that.
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
  /** RFC 0201 §B.4 — absent means `["v1"]`, today's behaviour byte for byte. */
  signatureAlgorithms?: unknown;
}
import { wireEventType } from '../storage/eventEra.js';
import { v2WireEventType, wireEventTypeSpellings } from '../host/hostEventNames.js';
import {
  hostEventEnvelope,
  hostEventEntryForEmitted,
  hostEventEntryForSubscriptionName,
  hostEventsV2Enabled,
  type HostEventEnvelope,
} from '../host/hostEventTypes.js';
import { publishHostEventToStream } from '../host/hostEventStream.js';
import { projectV2Payload, stampV2SchemaVersion } from '../storage/v2PayloadProjection.js';
import type { Storage } from '../storage/storage.js';
import { hostExtStorage } from '../host/hostExtPersistence.js';
import { OpenwopError, type EventRecord, type WebhookDeliveryRecord } from '../types.js';
import { getEventLog } from '../executor/eventLog.js';
import { createLogger } from '../observability/logger.js';
import { sealWebhookSecret } from '../host/webhookSecretCodec.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../host/webhookDeliveryWorker.js';
import { projectV2RunIds } from '../host/v2Ids.js';
import { runOwnerV2 } from '../host/runOwner.js';
import { assertEgressUrlAllowed, EgressUrlRejectedError } from '../host/webhookEgressGuard.js';
import { callerSubject, personalTenantOf, tenantOf } from '../host/requestSubject.js';
import { isWorkspaceMember } from '../host/accessControlService.js';
import { decodeWhsec, STANDARD_WEBHOOKS_ALG } from '../host/webhookSignature.js';
import { requireProtocolScope, requireProtocolScopeIn } from '../host/protocolAuthorization.js';
import { verifyWebhookEndpoint } from '../host/webhookEndpointVerification.js';
import {
  isStandardWebhooksOptIn,
  secretRotationOverlapSeconds,
  SUPPORTED_SIGNATURE_ALGORITHMS,
  takeVerificationBudget,
} from '../host/webhookStandardWebhooks.js';

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
  // ADR 0755 D1 — every webhook operation is `webhooks:manage` (rest-endpoints.md
  // §Webhooks). The ONE gate for all five handlers, because each already resolves
  // its tenant here first: an `owk_` key declaring other scopes is refused
  // (always), and under RFC 0049 enforcement so is a member without the scope.
  await requireProtocolScope(req, 'webhooks:manage');
  const active = tenantOf(req);
  if (explicit === undefined || explicit.length === 0 || explicit === active) return active;
  if (explicit === personalTenantOf(req)) return explicit;
  const subject = callerSubject(req);
  if (subject && (await isWorkspaceMember(subject, explicit))) {
    // The gate above resolved `webhooks:manage` in the caller's ACTIVE tenant; the
    // operation runs in `explicit`. Under RFC 0049 enforcement the scope must hold
    // THERE too — admin at home, viewer in the shared workspace, is a viewer here.
    await requireProtocolScopeIn(req, explicit, 'webhooks:manage');
    return explicit;
  }
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
  app.get('/webhooks', async (req, res, next) => {
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
          // ADR 0755 (WIT-WH-9) — the non-secret RFC 0201 state, so a client can
          // tell which subscriptions opted in and whether a rotation overlap is
          // running. Same ISO rendering as the rotate response; never a secret.
          ...(s.signatureAlgorithms ? { signatureAlgorithms: s.signatureAlgorithms } : {}),
          ...(s.rotatedAt !== undefined ? { rotatedAt: new Date(s.rotatedAt).toISOString() } : {}),
          ...(s.previousSecretExpiresAt !== undefined ? { previousSecretExpiresAt: new Date(s.previousSecretExpiresAt).toISOString() } : {}),
          createdAt: s.createdAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/webhooks', async (req, res, next) => {
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
      // ADR 0825 P1 / RFC 0236 §E — a major-2 `events[]` may name an advertised
      // DURABLE host-event type; an ephemeral one is refused. Flag-gated, so the
      // registration is byte-identical with the flag off.
      if (hostEventsV2Enabled()) assertNoEphemeralHostEventTypes(body.events);
      // RFC 0201 §B — the per-subscription opt-in. Validated AFTER the tenant
      // gate so a non-member learns nothing from the order of refusals, and
      // BEFORE anything leaves the process.
      const signatureAlgorithms = parseSignatureAlgorithms(body.signatureAlgorithms);
      const optedIn = signatureAlgorithms?.includes(STANDARD_WEBHOOKS_ALG) === true;
      if (optedIn) {
        // §B.6 — the SUBSCRIBER supplies the secret (so it can authenticate the
        // §D verification request); the host never mints or returns one here.
        if (typeof body.secret !== 'string' || decodeWhsec(body.secret) === null) {
          throw new OpenwopError(
            'validation_error',
            'An opt-in to standard-webhooks-1 MUST carry `secret` as whsec_<base64> decoding to 24–64 bytes.',
            400,
            { field: 'secret' },
          );
        }
        if (!takeVerificationBudget(tenantId)) {
          res.setHeader('Retry-After', '60');
          throw new OpenwopError('rate_limited', 'Too many Standard Webhooks registrations for this tenant; retry in a minute.', 429, {
            retryAfterSeconds: 60,
          });
        }
        // §D.13–§D.14 — consent BEFORE persistence: one signed request, no
        // retry, nothing stored on refusal.
        const outcome = await verifyWebhookEndpoint(body.url, body.secret);
        if (!outcome.ok) {
          log.info('webhook_endpoint_unverified', {
            tenantId,
            reason: outcome.reason,
            detail: outcome.detail,
            secretFingerprint: createHash('sha256').update(body.secret).digest('hex').slice(0, 8),
          });
          throw new OpenwopError(
            'webhook_endpoint_unverified',
            'The endpoint did not confirm the verification challenge; no subscription was created.',
            400,
            { reason: outcome.reason },
          );
        }
      }
      const subscriptionId = randomUUID();
      const secret = body.secret ?? randomBytes(32).toString('base64url');
      // At-rest sealing (TODO-3 closed): KMS envelope when configured (always,
      // in the enterprise/auth posture); plaintext passthrough in local/demo.
      // The response below still returns the PLAINTEXT once (the webhooks.md
      // contract — the subscriber needs it to verify signatures); the sealed
      // copy also rides into every per-delivery snapshot via enqueueDelivery.
      await storage.insertWebhook({
        subscriptionId,
        tenantId,
        url: body.url,
        events: body.events,
        tags: body.tags,
        secret: await sealWebhookSecret(secret),
        createdAt: new Date().toISOString(),
        // The contract this subscriber speaks, fixed at registration: tenant-bound
        // runIds in its deliveries. Only major 2 registers (ADR 0812).
        protocolMajor: 2,
        ...(signatureAlgorithms !== undefined ? { signatureAlgorithms } : {}),
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
        // RFC 0201 §B.7 — the list the dispatcher will apply, whenever the
        // request carried the field (and only then: an unchanged 201 for
        // everyone else, §B.8).
        ...(signatureAlgorithms !== undefined ? { signatureAlgorithms } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0201 §E — `rotateWebhookSecret`. Tenant checks are exactly those of
  // unregister (§E.18): the membership gate here, and under major 2 the
  // `403 id_tenant_mismatch` that `v2IdentityMiddleware` raises on a foreign
  // bound id BEFORE this handler looks anything up.
  app.post('/webhooks/:subscriptionId/rotate-secret', async (req, res, next) => {
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
      // A `v1`-only subscription's single-valued header cannot carry two
      // signatures, so there is no overlap to offer it (§E.18, UQ2).
      if (!isStandardWebhooksOptIn(sub)) {
        throw new OpenwopError(
          'validation_error',
          'Only a subscription registered with standard-webhooks-1 can rotate its secret; delete and re-register to rotate a v1-only subscription.',
          400,
          { field: 'signatureAlgorithms' },
        );
      }
      const newSecret = (req.body as { secret?: unknown } | undefined)?.secret;
      if (typeof newSecret !== 'string' || decodeWhsec(newSecret) === null) {
        throw new OpenwopError(
          'validation_error',
          'Field `secret` MUST be whsec_<base64> decoding to 24–64 bytes.',
          400,
          { field: 'secret' },
        );
      }
      const rotatedAt = Date.now();
      const previousSecretExpiresAt = rotatedAt + secretRotationOverlapSeconds() * 1000;
      // §E.21 — no re-verification: the URL has not changed.
      const updated = await storage.rotateWebhookSecret(sub.subscriptionId, {
        secret: await sealWebhookSecret(newSecret),
        rotatedAt,
        previousSecretExpiresAt,
      });
      if (!updated) {
        // Deleted between the lookup and the UPDATE.
        throw new OpenwopError('subscription_not_found', `Webhook subscription ${req.params.subscriptionId} not found.`, 404, {
          subscriptionId: req.params.subscriptionId,
        });
      }
      log.info('webhook_secret_rotated', {
        subscriptionId: sub.subscriptionId,
        tenantId,
        secretFingerprint: createHash('sha256').update(newSecret).digest('hex').slice(0, 8),
      });
      // §E.19 — carries no secret.
      res.status(200).json({
        rotatedAt: new Date(rotatedAt).toISOString(),
        previousSecretExpiresAt: new Date(previousSecretExpiresAt).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/webhooks/:subscriptionId', async (req, res, next) => {
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
  app.post('/webhooks/:subscriptionId/test', async (req, res, next) => {
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
  // H72 (ADR 0533 correction) — `replay.md` §"Host-initiated fan-out is an
  // external effect": a `mode:'replay'` fork re-emits recorded history from
  // the event log (caveat 5 REQUIRES it), so delivering those events outward
  // would assert to a subscriber that something happened in this run which
  // did not. Suppressed at the BOUNDARY, unconditionally — not gated on
  // `sideEffectSuppression`, and read from the RUN rather than the event
  // type so types added later are covered without touching a list.
  //
  // Dedup cannot cover this: re-emission correctly mints a fresh envelope
  // `eventId` and the delivery key is `(subscriptionId, eventId)`, so a more
  // correct host is MORE exposed.
  //
  // `branch` is deliberately untouched — a branch fork is new execution, not
  // a re-run of recorded history, so its effects are genuinely first-time.
  //
  // This is NOT routed through `runEffectContext`'s guard, and that remains
  // deliberate: this function is invoked from a best-effort event-log
  // subscriber whose throws `eventLog.ts` catches and discards, so a guard
  // here would suppress SILENTLY instead of failing loudly.
  if (run?.forkMode === 'replay') return;
  // A run event whose run row cannot be read falls back to the DEFAULT tenant,
  // which routes this fan-out at a tenant that is almost certainly not the
  // event's owner — silently, since every downstream step then behaves
  // correctly for the wrong tenant. Worth a line: it is a correctness cliff,
  // not a nuisance (ADR 0735).
  if (run === null && typeof event.runId === 'string' && event.runId.length > 0) {
    log.warn('webhook_fanout_run_unresolved', { runId: event.runId, type: event.type });
  }
  const tenantId = run?.tenantId ?? 'default';
  const subscribers = await matchingSubscribers(storage, event.type, tenantId);
  // The owner block is a PROJECTION of the run record (`host/runOwner.ts`), not a
  // field on it; `workspace` is present only for a sub-tenant workspace (RFC 0048).
  const workspaceId = run ? runOwnerV2(run).workspace : undefined;
  for (const sub of subscribers) {
    await enqueueDelivery(storage, { ...sub, ...(typeof workspaceId === 'string' ? { workspaceId } : {}) }, event);
  }
}

/** Test-only seam: exports the fanout so the RFC 0093 §A.3 cross-tenant
 *  delivery-negative regression can drive it directly. Production callers go
 *  through the event-log subscription registered above. */
export const __deliverToSubscribersForTests = deliverToSubscribers;

/**
 * Deliver a HOST-EXTENSION lifecycle event (one with no backing run — e.g. a
 * CMS page publish, ADR 0204 C1) to matching webhook subscriptions. Reuses the
 * SAME subscription matching, durable enqueue, backoff worker, egress guard,
 * and HMAC signing as run events — one delivery pipeline, one more door. The
 * difference is tenant attribution: a host-ext event carries its tenant
 * EXPLICITLY (a run-less event must never fall back to the `'default'`
 * tenant). Event types use the vendor pattern `host.<feature>.<noun>.<verb>`
 * (`openwop-app.crm.contact-triaged` precedent) — schema-legal per
 * `run-event.schema.json`'s vendor-extension branch; the normative
 * `RunEventType` enum is untouched, so no RFC applies. Best-effort: failures
 * are logged, never thrown into the emitting feature's write path.
 */
export async function deliverHostExtEvent(input: { type: string; tenantId: string; payload: Record<string, unknown>; eventId?: string }): Promise<void> {
  let storage: Storage;
  try {
    storage = hostExtStorage(); // unwired (unit tests without boot) ⇒ no-op
  } catch {
    return;
  }
  try {
    // ADR 0825 P1 / RFC 0236 — behind the flag, a major-2 subscriber gets the
    // runless `{ hostEvent }` body instead of the synthetic `hostext:` run. With
    // the flag off, nothing below this branch changes.
    if (hostEventsV2Enabled()) {
      await deliverHostEventV2(storage, input);
      return;
    }
    const event: EventRecord = {
      // Caller-supplied id when the SAME event also starts runs (the ADR 0208
      // dispatcher stamps it into run.metadata.hostEvent.eventId) — a receiver
      // can correlate the delivery with the run it triggered. Absent ⇒ minted.
      eventId: input.eventId ?? randomUUID(),
      // Synthetic marker — no run backs a lifecycle event. Consumers key on
      // `type` + `payload`; the run-scoped fields are inert here.
      runId: `hostext:${input.type}`,
      sequence: 0,
      type: input.type,
      payload: input.payload,
      timestamp: new Date().toISOString(),
    };
    const subscribers = await matchingSubscribers(storage, input.type, input.tenantId);
    for (const sub of subscribers) {
      await enqueueDelivery(storage, sub, event);
    }
  } catch (err) {
    log.warn('host-ext webhook fanout error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Emitted names already logged as unadvertised (bounded; one line per type per process). */
const unadvertisedHostEventTypes = new Set<string>();

/**
 * ADR 0825 P1 — `deliverHostExtEvent` with `OPENWOP_HOST_EVENTS_V2` on.
 *
 *   - MAJOR 1: exactly the pre-flag path (`hostext:` run, `*` and every
 *     spelling match, the v1-retired skip in `enqueueDelivery`).
 *   - MAJOR 2: RFC 0236 §E. Only an ADVERTISED type is emitted (§B "MUST NOT
 *     emit a host-event type it does not advertise"); the body is
 *     `{ hostEvent }` with no `runId`, sent only to a subscription whose
 *     `events[]` names the type (`hostEventEntryForSubscriptionName`, which
 *     also resolves the pre-flag spellings). The event also goes to the
 *     `/host/events` stream.
 */
async function deliverHostEventV2(
  storage: Storage,
  input: { type: string; tenantId: string; payload: Record<string, unknown>; eventId?: string },
): Promise<void> {
  const eventId = input.eventId ?? randomUUID();
  const timestamp = new Date().toISOString();
  const all = await storage.listWebhooks({ tenantId: input.tenantId });
  const spellings = wireEventTypeSpellings(input.type);
  const legacy: EventRecord = { eventId, runId: `hostext:${input.type}`, sequence: 0, type: input.type, payload: input.payload, timestamp };
  for (const sub of all) {
    if ((sub.protocolMajor ?? 1) !== 1) continue;
    if (sub.events.includes('*') || sub.events.some((e) => spellings.has(e))) await enqueueDelivery(storage, sub, legacy);
  }
  const entry = hostEventEntryForEmitted(input.type);
  if (entry === undefined) {
    if (!unadvertisedHostEventTypes.has(input.type)) {
      if (unadvertisedHostEventTypes.size >= 1024) unadvertisedHostEventTypes.clear();
      unadvertisedHostEventTypes.add(input.type);
      log.warn('host_event_unadvertised_not_emitted', { type: input.type });
    }
    return;
  }
  await fanOutHostEvent(storage, input.tenantId, hostEventEnvelope(entry, { eventId, timestamp, payload: input.payload }), all);
}

/**
 * RFC 0236 §C–§E — fan one host event out: to the `/host/events` stream, and,
 * when it is DURABLE, to every major-2 subscription OF ITS TENANT whose
 * `events[]` names its type. An ephemeral event is never enqueued (§C: "MUST
 * NOT deliver it through webhooks"). Exported for tests that drive an envelope
 * directly; production reaches it through `deliverHostExtEvent`.
 */
export async function fanOutHostEvent(
  storage: Storage,
  tenantId: string,
  envelope: HostEventEnvelope,
  tenantSubscriptions?: Awaited<ReturnType<Storage['listWebhooks']>>,
): Promise<void> {
  await publishHostEventToStream(storage, tenantId, envelope);
  if (envelope.delivery !== 'durable') return;
  const subs = tenantSubscriptions ?? await storage.listWebhooks({ tenantId });
  for (const sub of subs) {
    // Defence in depth: the list is already tenant-scoped (`webhook-cross-tenant-isolation`).
    if (sub.tenantId !== tenantId || sub.protocolMajor !== 2) continue;
    if (!sub.events.some((e) => hostEventEntryForSubscriptionName(e)?.type === envelope.type)) continue;
    await enqueueHostEventDelivery(storage, sub, envelope);
  }
}

/**
 * The durable row for a host-event delivery. Same queue, signing, retries and
 * dead-lettering as a run delivery (§E "apply exactly as to run deliveries").
 * The `eventId` is fixed in the persisted body and `webhook-id` is the row id,
 * so both are identical on every attempt (§E dedup key
 * `(OpenWOP-Webhook-Id, eventId)`).
 */
async function enqueueHostEventDelivery(
  storage: Storage,
  sub: { subscriptionId: string; url: string; secret: string; tenantId?: string },
  envelope: HostEventEnvelope,
): Promise<void> {
  const now = Date.now();
  const tenant = sub.tenantId ?? 'default';
  const record: WebhookDeliveryRecord = {
    deliveryId: randomUUID(),
    subscriptionId: sub.subscriptionId,
    tenantId: sub.tenantId ?? null,
    wireSubscriptionId: (projectV2RunIds({ webhookId: sub.subscriptionId }, tenant) as { webhookId: string }).webhookId,
    url: sub.url,
    secret: sub.secret,
    // `OpenWOP-Event-Type` is the host-event type (§E).
    eventType: envelope.type,
    payload: JSON.stringify({ hostEvent: envelope }),
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
  await storage.enqueueWebhookDelivery(record, { requireSubscription: true });
}

/**
 * RFC 0236 §E — `registerWebhook` MUST refuse an ephemeral host-event type with
 * `400 validation_error`. Pure, with the lookup injected, because this host
 * advertises no ephemeral type today and the refusal must still be provable.
 * Unknown names are NOT refused here: like the v2 reference host, which admits
 * any registered-org vendor name, this host cannot tell an unadvertised
 * host-event name from a vendor run-event name (ADR 0825 §Implementation record).
 */
export function assertNoEphemeralHostEventTypes(
  events: readonly unknown[],
  lookup: (name: string) => { delivery: 'durable' | 'ephemeral' } | undefined = hostEventEntryForSubscriptionName,
): void {
  for (const e of events) {
    if (typeof e !== 'string') continue;
    if (lookup(e)?.delivery === 'ephemeral') {
      throw new OpenwopError('validation_error', `${e} is an ephemeral host-event type and is never delivered through webhooks (RFC 0236 §C).`, 400, {
        field: 'events',
        type: e,
      });
    }
  }
}

/**
 * Subscriptions that match one in-process event type under EVERY spelling a
 * subscriber may have registered (`eventTypeSpellings`): a major-2
 * subscriber filters on `agent.tool-called`, the executor emits
 * `agent.toolCalled`, and the storage filter is an exact `events.includes`.
 * One tenant-scoped list, filtered here — both storage adapters load every
 * row and filter in-process anyway, so this is not a second scan.
 */
/** Terminal run events — one fan-out log line per run, not per event. */
const FANOUT_OBSERVED_TYPES: ReadonlySet<string> = new Set(['run.completed', 'run.failed', 'run.cancelled']);

async function matchingSubscribers(
  storage: Storage,
  type: string,
  tenantId: string,
): Promise<Awaited<ReturnType<Storage['listWebhooks']>>> {
  // ADR 0792 — a host event also matches a subscription registered with its v2 spelling.
  const spellings = wireEventTypeSpellings(type);
  const all = await storage.listWebhooks({ tenantId });
  const matched = all.filter((sub) => sub.events.includes('*') || sub.events.some((e) => spellings.has(e)));
  // ADR 0735 — a fan-out that matches NOTHING is otherwise indistinguishable
  // from one that was never invoked: `deliverToSubscribers` logs only when it
  // THROWS, so an empty subscriber set is perfectly silent. That silence is how
  // a total delivery failure hid behind a green suite, and eight black-box
  // probes could not see inside this function because there was nothing to see.
  // Bounded to terminal run events, so the cost is one line per run.
  if (FANOUT_OBSERVED_TYPES.has(type)) {
    log.info('webhook_fanout', {
      type,
      tenantId,
      tenantSubscriptions: all.length,
      matched: matched.length,
    });
  }
  return matched;
}

/**
 * Enqueue one durable delivery row. The `secret` is captured here (the
 * subscription may be deleted before the worker delivers) and the event is
 * serialized into the exact `payload` body the worker will POST. The worker
 * (`webhookDeliveryWorker`) signs + delivers + retries with backoff.
 * Accepts any `{ type }`-bearing event body: run `EventRecord`s and ADR 0208
 * host-event envelopes serialize verbatim.
 */
/** Subscriptions already logged as skipped by ADR 0812 decision 2 (bounded). */
const skippedV1Subscriptions = new Set<string>();

async function enqueueDelivery(
  storage: Storage,
  sub: { subscriptionId: string; url: string; secret: string; tenantId?: string; protocolMajor?: 1 | 2; workspaceId?: string },
  event: { type: string; runId?: string; nodeId?: string; payload?: unknown },
): Promise<void> {
  const now = Date.now();
  // ── THE major-2 id PROJECTION, and why it lives HERE and nowhere else ──────
  //
  // Under major 2 a runId is `<tenantId>/<opaque>` (`identity.md` §5), and
  // `run-event.schema.json` binds `runId` to that grammar by `$ref` — so the
  // run event nested in a v2 delivery body is non-conformant carrying a bare
  // uuid. ADR 0629 projected ids in the two JSON *response* senders and stopped
  // there, which broke `v2-webhook-durable-delivery`: the client was handed
  // `default/<uuid>` by its v2 create and the delivery carried `<uuid>`, so its
  // correlation filter matched NOTHING — no error, no 4xx, no log line, just a
  // subscriber that never sees its own run.
  //
  // The ADR's own words were the defect stated as the design: "applied by both
  // JSON senders". A projection that holds only where someone remembered to
  // call it is not a projection, and the fix for a forgotten call site is not a
  // third call site. This function is the ONE place every outbound body is
  // serialized (three callers, one `JSON.stringify`), so it is the only seam
  // where "every emission is projected" can be true by construction rather than
  // by vigilance. Any future emitter that does not pass through here is a bug
  // in the emitter, not a missing branch here.
  const major = sub.protocolMajor ?? 1;
  // ADR 0812 decision 2 — this host has RETIRED v1 and must not keep emitting the
  // v1 contract to a subscription registered under it. Silently upgrading the
  // body to v2 would break that subscriber without warning (a different
  // envelope, different ids, different event names), so the delivery is NOT
  // enqueued and the skip is logged once per subscription per process. The
  // subscriber re-registers under major 2. MEASURED 2026-10-04 on
  // app.openwop.dev: 30 days of deliveries went only to test targets, so there is
  // no real subscriber to strand.
  if (major === 1) {
    if (!skippedV1Subscriptions.has(sub.subscriptionId)) {
      if (skippedV1Subscriptions.size >= 4096) skippedV1Subscriptions.clear();
      skippedV1Subscriptions.add(sub.subscriptionId);
      log.warn('webhook_v1_subscription_not_delivered', { subscriptionId: sub.subscriptionId, eventType: event.type });
    }
    return;
  }
  const tenant = sub.tenantId ?? 'default';
  // ── THE v2 DELIVERY ENVELOPE (webhooks.md §Delivery; webhook-delivery.schema.json, rc.30) ──
  //
  //   { runId, workspaceId, event }   required, additionalProperties: false,
  //                                   runId tenant-bound, event VERBATIM
  //
  // Under major 1 the body is the bare event it has always been (the v1
  // contract). Under major 2 the bare event is NOT a conforming body -- it has no
  // `runId`, no `workspaceId`, and the event at the top level instead of under
  // `event` -- so a v2 subscriber received a document its schema rejects, not
  // merely an unprojected id. Built HERE, at the one serialization seam, for the
  // same reason the projection is: an envelope assembled per emitter is an
  // envelope one emitter forgets.
  //
  // `workspaceId` is present EXACTLY when `RunSnapshot.owner.workspace` is
  // (rc.34 §Delivery: "a host MUST NOT substitute its tenant id"). The first
  // cut of this emitted `?? tenant` -- a conforming emission against an rc.30
  // schema that REQUIRED the field while the identity model made it optional;
  // the orchestrator called that "two facts wearing one name" and fixed the
  // schema. A single-workspace tenant's run simply has no workspaceId.
  const runIdOf = (e: unknown): string | undefined => {
    const r = (e as { runId?: unknown } | null)?.runId;
    return typeof r === 'string' ? r : undefined;
  };
  // A major-2 subscriber receives the codemap's v2 spelling of the event
  // TYPE as well as tenant-bound ids (`wireEventType`, tolerant on the
  // fan-out path); the in-process event stays in the host's v1 dialect.
  // ADR 0792 — a HOST event (ADR 0208) has no codemap row; its v2 spelling is
  // owned by host/hostEventNames.ts. Major 1 is untouched (byte-identical).
  // `v2WireEventType` holds the one precedence (codemap first, then the host rule).
  const wireType = major === 2 ? v2WireEventType(event.type) : wireEventType(event.type, 1);
  if (major === 2 && wireType !== event.type && typeof event.runId === 'string' && event.runId.startsWith('hostext:')) {
    // The synthetic run marker embeds the type too; project it with the type.
    event = { ...event, runId: `hostext:${wireType}` };
  }
  let body: unknown = event;
  if (major === 2) {
    // ADR 0722 — the PAYLOAD is projected too, with the same composed function
    // the poll/SSE read uses. Before this a major-2 subscriber received the raw
    // v1 owner block and no `nodeId`/`runId` where the def requires them: two
    // egress channels, one projected, and no scenario validating this one.
    // A run-less host-ext event has no envelope to project from; it goes out as-is.
    const wirePayload = typeof event.runId === 'string'
      ? projectV2Payload(event.type, event.payload, { runId: event.runId, ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}) }, tenant)
      : event.payload;
    // ADR 0722 Phase E — the ENVELOPE too: `schemaVersion` is required on a
    // major-2 RunEventDoc and was stamped at the read seat only.
    const projected = projectV2RunIds(stampV2SchemaVersion({ ...event, type: wireType, ...(wirePayload !== undefined ? { payload: wirePayload } : {}) }), tenant);
    const wireRunId = runIdOf(projected) ?? runIdOf(event);
    body = wireRunId === undefined
      ? projected                                   // a run-less host-ext event: no run to name
      : { runId: wireRunId, ...(sub.workspaceId !== undefined ? { workspaceId: sub.workspaceId } : {}), event: projected };
  }
  const wireWebhookId = major === 2
    ? (projectV2RunIds({ webhookId: sub.subscriptionId }, tenant) as { webhookId: string }).webhookId
    : null;
  const record: WebhookDeliveryRecord = {
    deliveryId: randomUUID(),
    subscriptionId: sub.subscriptionId,
    // RFC 0215 §A.3 (ADR 0752 P2) — the dispatcher's per-tenant cap reads this.
    tenantId: sub.tenantId ?? null,
    // RFC 0187 §A.1 binds the `webhookId` mint to the subscriptionId kind.
    // The delivery header is the same deduplication key, so persist its exact
    // wire spelling with the durable row; retries after a restart cannot
    // reconstruct it from a request that no longer exists.
    wireSubscriptionId: wireWebhookId,
    url: sub.url,
    secret: sub.secret,
    eventType: wireType,
    payload: JSON.stringify(body),
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
  // RFC 0215 §B (ADR 0752) — only while the subscription still exists. This
  // fan-out read `listWebhooks` earlier; an unregister answering 204 in between
  // must not be followed by an attempt, so the insert re-checks atomically
  // against `deleteWebhook` rather than trusting that earlier read.
  await storage.enqueueWebhookDelivery(record, { requireSubscription: true });
}

/**
 * RFC 0201 §B.5 — the optional `signatureAlgorithms` field. `undefined` when
 * absent (the non-opted path, untouched). Present, it MUST be a string array
 * that lists `v1`, repeats nothing, and names only ids this host advertises;
 * anything else is `400 validation_error`.
 */
function parseSignatureAlgorithms(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const refuse = (why: string): never => {
    throw new OpenwopError('validation_error', `Field \`signatureAlgorithms\` ${why}.`, 400, { field: 'signatureAlgorithms' });
  };
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((a): a is string => typeof a === 'string')) {
    return refuse('MUST be a non-empty array of strings');
  }
  if (!raw.includes('v1')) return refuse('MUST include "v1"');
  if (new Set(raw).size !== raw.length) return refuse('MUST NOT repeat a value');
  const unknown = raw.find((a) => !SUPPORTED_SIGNATURE_ALGORITHMS.includes(a));
  if (unknown !== undefined) return refuse(`lists "${unknown}", which this host does not advertise`);
  return raw;
}

export function assertReachableUrl(url: string): void {
  // ADR 0607 — the ordered arms now live in ONE place (`assertEgressUrlAllowed`)
  // shared with A2A push config, priority-matrix federation, and the delivery
  // worker. This function keeps only the job that is genuinely local: mapping a
  // reason code onto the HTTP error shape this endpoint promises. `webhooks.md`
  // §"SSRF protection" is the contract; `honorDevFlag: true` is required by the
  // conformance operator contract (see the helper's docblock).
  try {
    assertEgressUrlAllowed(url, { honorDevFlag: true });
  } catch (e) {
    if (!(e instanceof EgressUrlRejectedError)) throw e;
    switch (e.reason) {
      case 'invalid_url':
        throw new OpenwopError('validation_error', `Webhook url is not a valid URL.`, 400, { field: 'url' });
      case 'unsupported_protocol':
        throw new OpenwopError('webhook_url_rejected', `Webhook url must be http: or https:.`, 400, {
          reason: 'unsupported_protocol',
          protocol: e.protocol,
        });
      case 'insecure_scheme':
        throw new OpenwopError('webhook_url_rejected', `Webhook url must use https:.`, 400, {
          reason: 'insecure_scheme',
          protocol: e.protocol,
        });
      case 'denied_host':
        throw new OpenwopError(
          'webhook_url_rejected',
          `Webhook url host "${e.hostname}" is denied (loopback / link-local / private-IP).`,
          400,
          { reason: 'ssrf_guard', host: e.hostname },
        );
    }
  }
}
