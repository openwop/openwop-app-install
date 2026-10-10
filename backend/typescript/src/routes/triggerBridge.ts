/**
 * Durable trigger bridge — read + external-event ingestion surface.
 *
 * RFC 0083 §C read surface:
 *   GET   /v1/trigger-subscriptions[/{id}]   subscription state + delivery attempts
 *   PATCH /v1/trigger-subscriptions/{id}      operator pause/resume (§B)
 *
 * RFC 0099 §F external-event ingestion (gated on `triggerBridge.ingestion`):
 *   POST  /v1/trigger-subscriptions           register a webhook/email/form source
 *                                             bound to a workflow → returns the
 *                                             subscription + a source-specific binding
 *   POST  /v1/trigger-subscriptions/{id}/ingest   simulated inbound delivery (the
 *                                             host-extension ingestion endpoint the
 *                                             real webhook/email/form gateways feed)
 *
 * Tenant-scoped (RFC 0074 carry-forward). The ingestion endpoint is intentionally
 * a single host-extension delivery seam (a real host fronts it with the actual
 * webhook gateway / inbound-email parser / form POST) so the conformance + tests
 * can drive an inbound event without a live mail server.
 *
 * @see src/host/triggerBridgeService.ts  — RFC 0083 §B/§C durable engine
 * @see src/host/triggerIngestionService.ts — RFC 0099 §F external-event leg
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { vendorPath } from '../middleware/protocolVersion.js';
import type { Express, Request } from 'express';
import { OpenwopError, type RunRecord } from '../types.js';
import { unadvertisedError, type UnadvertisedGate } from '../host/unadvertised.js';

/** ADR 0781 — external-event ingestion (RFC 0099 §F) is advertised only when wired. */
const TRIGGER_INGESTION_OFF: UnadvertisedGate = {
  family: 'triggerBridge', facet: 'ingestion',
  message: 'External-event trigger ingestion is not enabled on this host.',
};
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import { getEventLog } from '../executor/eventLog.js';
import { executeRun } from '../executor/executor.js';
import { insertRunWithStartContext } from '../host/runInsert.js';
import { resolveLaunchWorkflow, resolveTenantWorkflow } from '../host/resolveLaunchDefinition.js';
import { requireProtocolScope } from '../host/protocolAuthorization.js';
import { signStandardWebhooks } from '../host/webhookSignature.js';
import { fromWireRunId, toWireRunId } from '../host/v2Ids.js';
import { looksProjected, unprojectBoundId } from '../host/boundIdProjection.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.triggerIngestSigned');

/** RFC 0230 §C — the Standard Webhooks timestamp tolerance, seconds. */
const MAX_SKEW_S = 300;
const WEBHOOK_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** RFC 0230 §C — does any `v1,<b64>` entry of `webhook-signature` match, and is
 *  `webhook-timestamp` within the skew bound? Constant-time per entry. */
export function verifyInboundStandardWebhooks(
  secret: string, webhookId: string, timestamp: string | undefined, signatureHeader: string | undefined, rawBody: string, nowMs: number,
): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatureHeader) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > MAX_SKEW_S) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(signStandardWebhooks(secret, webhookId, timestamp, rawBody));
  } catch {
    return false; // not a whsec_ secret — never verifies
  }
  return signatureHeader.split(' ').some((entry) => {
    const got = Buffer.from(entry.trim());
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
import {
  bindDeadLetterAttemptEvent,
  deleteSubscription,
  deliver,
  getSubscription,
  listDeadLetters,
  listDeliveries,
  makeDedupKey,
  listSubscriptions,
  recordRefusedDelivery,
  registerSubscription,
  setSubscriptionState,
  TRIGGER_DEAD_LETTER_MAX_PAGE_SIZE,
  type RetryPolicy,
  type SubscriptionSource,
  type VerificationMode,
} from '../host/triggerBridgeService.js';
import {
  deleteIngestSecret,
  inboundSigningEnabled,
  ingestExternalEvent,
  SIGNED_INGEST_ROOT,
  isExternalIngestionSource,
  loadIngestSecret,
  isAcceptedIngestionSource,
  storeIngestSecret,
  triggerIngestionEnabled,
  type IngressInput,
} from '../host/triggerIngestionService.js';

/** A deterministic, BYOK-free demo workflow every instance resolves
 *  (host/index.ts catalog source A) — the run the host-sample ingest seam
 *  starts so it exercises the real delivery path, not a stub. */
const INGEST_WORKFLOW_ID = 'openwop-app.uppercase';

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

export function registerTriggerBridgeRoutes(app: Express, deps?: Deps): void {
  app.get('/trigger-subscriptions', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'webhooks:manage'); // ADR 0755 D1 — rest-endpoints.md names webhooks:manage for this surface
      res.json({ subscriptions: await listSubscriptions(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/trigger-subscriptions/:subscriptionId', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'webhooks:manage');
      const sub = await getSubscription(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404, { subscriptionId: req.params.subscriptionId });
      }
      res.json({ subscription: sub, deliveries: await listDeliveries(sub.subscriptionId) });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0232 §B / ADR 0805 — `listTriggerDeadLetters`: the subscription's
  // dead-lettered deliveries, newest first, content-free (§C). Served whenever
  // `triggerBridge.deadLetter` is advertised, which is always on this host.
  // Tenant-bound exactly as the read above: another tenant's id and an id the
  // host never minted answer the same 404.
  app.get('/trigger-subscriptions/:subscriptionId/dead-letters', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'webhooks:manage');
      const sub = await getSubscription(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404, { subscriptionId: req.params.subscriptionId });
      }
      const limit = parseDeadLetterLimit(req.query.limit);
      const after = req.query.cursor === undefined ? undefined : decodeDeadLetterCursor(req.query.cursor, sub.subscriptionId);
      const page = await listDeadLetters(sub.subscriptionId, { limit, ...(after !== undefined ? { after } : {}) });
      res.json({
        deliveries: page.records.map((r) => ({
          subscriptionId: r.subscriptionId,
          attemptEventId: r.attemptEventId,
          attempt: r.attempt,
          ...(r.stateChange ? { stateChange: r.stateChange } : {}),
          reason: r.reason,
          deadLetteredAt: r.deadLetteredAt,
          expiresAt: r.expiresAt,
        })),
        ...(page.nextAfter ? { nextCursor: encodeDeadLetterCursor(sub.subscriptionId, page.nextAfter) } : {}),
      });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0099 §F.2 — register an external-event subscription bound to a workflow.
  // Gated on the ingestion capability being wired (fail-closed); requires deps.
  app.post('/trigger-subscriptions', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'webhooks:manage');
      if (!triggerIngestionEnabled() || !deps) {
        throw unadvertisedError(req, TRIGGER_INGESTION_OFF);
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const source = body.source;
      if (typeof source !== 'string' || !isExternalIngestionSource(source)) {
        throw new OpenwopError('validation_error', 'Field `source` MUST be one of webhook | email | form.', 400, { field: 'source' });
      }
      const workflowId = body.workflowId;
      if (typeof workflowId !== 'string' || workflowId.length === 0) {
        throw new OpenwopError('validation_error', 'Field `workflowId` is required.', 400, { field: 'workflowId' });
      }
      // RFC 0049 scope check: a registration MUST NOT bind a workflow the caller
      // cannot start. The host resolves the workflow under the caller's tenant —
      // ADR 0823: it said so, and did not; another tenant's id now 404s too.
      const tenantId = tenantOf(req);
      const wf = await resolveTenantWorkflow(deps.hostSuite.workflowCatalog, tenantId, workflowId);
      if (!wf) {
        throw new OpenwopError('not_found', 'Workflow not found (cannot bind a subscription to a workflow the caller cannot start).', 404, { workflowId });
      }

      const verificationMode = resolveVerificationMode(body.verification);
      const subscriptionId = `tgsub-${randomBytes(8).toString('hex')}`;

      // Webhook: mint a signing secret, return it ONCE, persist only the
      // fingerprint (re-reads never return the cleartext secret).
      let secretFingerprint: string | undefined;
      let secret: string | undefined;
      // ADR 0793 / RFC 0230 — with inbound signing on, a webhook subscription gets
      // a Standard Webhooks `whsec_` secret and the credential-less signed ingest
      // URL; otherwise the legacy hex secret + the credentialed `/ingest` route.
      const signed = source === 'webhook' && inboundSigningEnabled();
      if (source === 'webhook') {
        secret = signed ? `whsec_${randomBytes(32).toString('base64')}` : randomBytes(32).toString('hex');
        secretFingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 8);
      }

      const sub = await registerSubscription({
        subscriptionId,
        tenantId,
        source,
        dedupEnabled: body.dedupEnabled === false ? false : true, // §F.2 default true
        ...(resolveRetryPolicy(body.retryPolicy) ? { retryPolicy: resolveRetryPolicy(body.retryPolicy)! } : {}),
        workflowId,
        verificationMode,
        ...(secretFingerprint ? { secretFingerprint } : {}),
      });
      if (source === 'webhook' && secret) {
        await storeIngestSecret(subscriptionId, secret, { tenantId, scheme: signed ? 'standard-webhooks-1' : 'legacy-hex' });
      }

      const binding = buildBinding(source, subscriptionId, secret, secretFingerprint, signed);
      res.status(201).json({ subscription: sub, binding });
    } catch (err) {
      next(err);
    }
  });

  // Host extension (not a protocol operation — the corpus defines no trigger
  // subscription delete): remove a subscription and its delivery rows,
  // dead-letter records and sealed signing secret. On the VENDOR HOME so it
  // survives the v1 retirement (a `/v1` write answers 410 once 1.x is retired;
  // the canonical `/host/openwop-app/…` rewrites onto this twin). Same scope and
  // tenant binding as the PATCH above. Exists so the certification cut can leave
  // the conformance tenant as it found it: every cut registers subscriptions,
  // and nothing could remove them (MEASURED 2026-10-04: ~278 accumulated).
  app.delete(vendorPath('/trigger-subscriptions/:subscriptionId'), async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'webhooks:manage');
      const subscriptionId = resolveSubscriptionSegment(req.params.subscriptionId ?? '', tenantOf(req));
      const sub = await getSubscription(subscriptionId);
      if (!sub || sub.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404, { subscriptionId: req.params.subscriptionId });
      }
      await deleteSubscription(sub.subscriptionId);
      await deleteIngestSecret(sub.subscriptionId);
      log.info('trigger_subscription_deleted', { subscriptionId: sub.subscriptionId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Operator pause/resume (§B). { state: 'paused' | 'active' }.
  app.patch('/trigger-subscriptions/:subscriptionId', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'webhooks:manage');
      const sub = await getSubscription(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404, { subscriptionId: req.params.subscriptionId });
      }
      const toState = (req.body ?? {}).state;
      if (toState !== 'paused' && toState !== 'active') {
        throw new OpenwopError('validation_error', 'Field `state` MUST be `paused` or `active`.', 400, { field: 'state' });
      }
      await setSubscriptionState(sub.subscriptionId, toState);
      res.json({ subscription: await getSubscription(sub.subscriptionId) });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0099 §F — the inbound-delivery seam. A real host fronts this with the
  // webhook gateway / inbound-email parser / form POST; the body is the
  // normalized per-source ingress (the host's parser produces it). Content-free
  // on the wire OUT (the inbound content is redacted into ctx.triggerData; only
  // the runId / outcome are returned).
  app.post('/trigger-subscriptions/:subscriptionId/ingest', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:create'); // ADR 0755 D1 — an ingest STARTS a run
      if (!triggerIngestionEnabled() || !deps) {
        throw unadvertisedError(req, TRIGGER_INGESTION_OFF);
      }
      const sub = await getSubscription(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404, { subscriptionId: req.params.subscriptionId });
      }
      const input = coerceIngress(sub.source, req.body);
      if (!input) {
        throw new OpenwopError('validation_error', 'Inbound body does not match the subscription source shape.', 400, { source: sub.source });
      }
      const result = await ingestExternalEvent(deps, sub.subscriptionId, input);
      // 422 for a verification rejection (no run started); 200 otherwise.
      const status = result.outcome === 'rejected' ? 422 : result.outcome === 'dead-lettered' ? 422 : 200;
      res.status(status).json({ outcome: result.outcome, ...(result.runId ? { runId: result.runId } : {}), ...(result.reason ? { reason: result.reason } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // ADR 0793 / RFC 0230 — the SIGNED inbound-webhook ingest. No OpenWOP
  // credential: the Standard Webhooks signature over the raw body IS the
  // credential (verified against the subscription's sealed `whsec_` secret), and
  // the tenant comes from the stored subscription. Raw bytes are captured by the
  // scoped parser in index.ts. §C.1: nothing a sender posts here changes the
  // subscription's state — a refused post dead-letters only itself.
  app.post(`${SIGNED_INGEST_ROOT}/:subscriptionId`, async (req, res, next) => {
    try {
      if (!inboundSigningEnabled() || !deps) throw new OpenwopError('not_found', 'Not found.', 404);
      const sub = await getSubscription(req.params.subscriptionId);
      const stored = sub ? await loadIngestSecret(sub.subscriptionId) : null;
      // Unknown, non-webhook, or not opted in: one indistinguishable 404 (the
      // subscription id is not an oracle for an unauthenticated caller).
      if (!sub || sub.source !== 'webhook' || stored === null || stored.scheme !== 'standard-webhooks-1') {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404);
      }
      if (sub.state !== 'active') {
        throw new OpenwopError('subscription_not_active', 'The trigger subscription is not active.', 409, { state: sub.state });
      }
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
      const webhookId = req.header('webhook-id') ?? '';
      const idValid = WEBHOOK_ID.test(webhookId);
      const verified = idValid && verifyInboundStandardWebhooks(
        stored.secret, webhookId, req.header('webhook-timestamp'), req.header('webhook-signature'), rawBody, Date.now(),
      );
      const mode = sub.verificationMode ?? 'required';
      if (mode === 'required' && !verified) {
        // The dedup key is the same opaque hash a delivered event carries
        // (`makeDedupKey(subscriptionId, webhook-id)`), never the header value:
        // RFC 0232 §C.1 — a record carries no inbound header.
        await recordRefusedDelivery(sub.subscriptionId, makeDedupKey(sub.subscriptionId, idValid ? webhookId : randomBytes(16).toString('hex')));
        log.info('trigger_ingest_signature_invalid', { subscriptionId: sub.subscriptionId });
        throw new OpenwopError('signature_invalid', 'The webhook signature did not verify.', 401);
      }
      if (!idValid) {
        // best-effort / none still need an identity to dedup on (§C Identity).
        throw new OpenwopError('validation_error', 'Header `webhook-id` MUST match ^[A-Za-z0-9_-]{16,128}$.', 400, { field: 'webhook-id' });
      }
      const result = await ingestExternalEvent(deps, sub.subscriptionId, {
        source: 'webhook',
        method: 'POST',
        headers: req.headers as Record<string, unknown>,
        rawBody,
        externalDeliveryId: webhookId,
        preVerified: verified,
      });
      if (result.outcome === 'delivered' && result.runId) {
        res.status(202).json({ outcome: 'delivered', runId: toWireRunId(result.runId, sub.tenantId) });
        return;
      }
      if (result.outcome === 'deduped' && result.runId) {
        res.status(200).json({ outcome: 'duplicate', runId: toWireRunId(result.runId, sub.tenantId) });
        return;
      }
      if (result.reason === 'body-too-large') throw new OpenwopError('validation_error', 'The inbound body exceeds maxBodyBytes.', 413);
      if (result.reason === 'workflow-not-found') throw new OpenwopError('workflow_not_found', 'The subscription\'s workflow no longer resolves.', 422);
      if (result.reason === 'signature-invalid') throw new OpenwopError('signature_invalid', 'The webhook signature did not verify.', 401);
      throw new OpenwopError('subscription_not_active', 'The trigger subscription is not accepting deliveries.', 409);
    } catch (err) {
      next(err);
    }
  });

  // RFC 0099 §F — host-sample conformance seam. Drives the REAL §F leg end to
  // end (no parallel demonstrator, per the host's no-shadow-primitive rule):
  // register an ephemeral subscription bound to a deterministic demo workflow →
  // `ingestExternalEvent` → read back the in-run `TriggerEvent`
  // (`run.metadata.triggerData`, §F.1) + the content-free
  // `trigger.delivery.attempted` event the same path emitted (§F.4). So the
  // §F.1 header-curation + §F.4 SSRF-drop invariants are asserted on the actual
  // ingestion code, not a reimplementation. `verification:none` so the
  // signature-free sample event is delivered, not rejected. 404 when ingestion
  // is unwired (the conformance behavioral leg soft-skips on 404/403).
  // Registered on BOTH the reference-host route AND the `sample` conformance-seam path so
  // the suite hits it whichever it targets (RFC 0127 CDP-1b). `sample` is a thin alias.
  app.post(['/host/openwop-app/trigger-bridge/ingest', '/host/sample/trigger-bridge/ingest'], async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:create'); // ADR 0755 D1 — the seam registers + starts a run
      if (!triggerIngestionEnabled() || !deps) {
        throw new OpenwopError('host_capability_missing', 'External-event trigger ingestion is not enabled on this host.', 404);
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const source = body.source;
      // RFC 0127: accept stream/change too, but ONLY when the flag is on (isAcceptedIngestionSource);
      // a stream/change POST to a flag-off host falls through to a 400 → the scenario soft-skips.
      if (typeof source !== 'string' || !isAcceptedIngestionSource(source)) {
        throw new OpenwopError('validation_error', 'Field `source` MUST be one of webhook | email | form' + (isExternalIngestionSource('stream') ? '' : ' (stream | change require the RFC 0127 flag)') + '.', 400, { field: 'source' });
      }
      const tenantId = tenantOf(req);
      // Unique per probe → a fresh dedup key, so each call delivers its own run.
      const subscriptionId = `tgsub-sample-${randomBytes(8).toString('hex')}`;
      await registerSubscription({
        subscriptionId,
        tenantId,
        source,
        dedupEnabled: true,
        workflowId: INGEST_WORKFLOW_ID,
        verificationMode: 'none',
      });

      const input = coerceSeamIngress(source, body);
      const requested = countRequestedAttachments(source, body);
      const result = await ingestExternalEvent(deps, subscriptionId, input);
      if (!result.runId) {
        // No run started (verification/dead-letter/dedup) — surface the honest
        // outcome rather than fabricate a TriggerEvent.
        res.status(200).json({ outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
        return;
      }

      const run = await deps.storage.getRun(result.runId);
      const triggerEvent = (run?.metadata as { triggerData?: unknown } | undefined)?.triggerData ?? null;
      const events = await deps.storage.listEvents(result.runId);
      const deliveryEvent = events.find((e) => e.type === 'trigger.delivery.attempted')?.payload ?? null;
      // An attachment the SSRF guard dropped never reaches the in-run envelope —
      // requested-but-absent ⇒ refused (§F.4 negative).
      const delivered = countDeliveredAttachments(source, triggerEvent);
      const ssrfRefused = requested > delivered;
      res.status(200).json({ triggerEvent, deliveryEvent, ssrfRefused });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0083 §C — host-sample DELIVERY seam (`host-sample-test-seams.md`
  // §"Trigger-bridge delivery seam"). Distinct from the `/ingest` seam above:
  // that one drives RFC 0099 §F external-event INGESTION (does a webhook body
  // normalize into a TriggerEvent), this one drives the §C durable BRIDGE —
  // dedup, retry exhaustion to dead-letter, and the delivery→run causation
  // edge. The host implemented §C all along (`triggerBridgeService.deliver`)
  // and advertised `triggerBridge` accordingly, but exposed only `/ingest`, so
  // the behavioural leg had nothing to drive and soft-skipped for as long as
  // the suite allowed it to.
  //
  // Drives the REAL engine — the same `deliver()` the production ingestion,
  // inbound-webhook and kanban paths call. The seam controls only what a real
  // caller controls: the dedup key and whether the fire succeeds. It does NOT
  // reimplement dedup, retry, backoff or the state machine.
  app.post(['/host/openwop-app/trigger-bridge/deliver', '/host/sample/trigger-bridge/deliver'], async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:create');
      if (!deps) throw new OpenwopError('host_capability_missing', 'Trigger-bridge delivery is not wired on this host.', 404);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scenario = body.scenario;
      if (scenario !== 'dedup' && scenario !== 'exhaust' && scenario !== 'deliver') {
        throw new OpenwopError('validation_error', 'Field `scenario` MUST be one of dedup | exhaust | deliver.', 400, { field: 'scenario' });
      }
      const source = (typeof body.source === 'string' ? body.source : 'queue') as SubscriptionSource;
      const tenantId = tenantOf(req);
      // Fresh subscription per probe so scenarios cannot contaminate each
      // other's dedup window or state machine.
      const subscriptionId = `tgsub-deliver-${randomBytes(8).toString('hex')}`;
      await registerSubscription({
        subscriptionId,
        tenantId,
        source,
        dedupEnabled: true,
        workflowId: INGEST_WORKFLOW_ID,
        verificationMode: 'none',
        // Keep the exhaust leg short: the point is that the policy is honoured
        // to exhaustion, not how long it takes.
        ...(scenario === 'exhaust' ? { retryPolicy: { maxAttempts: 2, backoff: 'fixed' as const } } : {}),
      });
      // The suite passes a literal dedupKey and asserts it back on the event
      // payload, so it is used VERBATIM — deriving one here would echo a hash.
      const dedupKey = typeof body.dedupKey === 'string' && body.dedupKey.length > 0
        ? body.dedupKey
        : `conf-${randomBytes(8).toString('hex')}`;

      if (scenario === 'exhaust') {
        const result = await deliver({
          subscriptionId,
          dedupKey,
          fire: async () => { throw new Error('conformance: forced delivery failure'); },
        });
        // §C-2 — a dead-lettered delivery starts NO run, so there is no run id
        // to hang its terminal record on. The events are recorded under a
        // carrier id derived from the delivery, which is what the seam returns
        // as `runId` so the driver can read them back through the event-log
        // seam. It is an addressable handle for a delivery that produced no
        // run, NOT a fabricated run: no run row is created.
        const carrierId = `dlv-run-${result.deliveryId || randomBytes(8).toString('hex')}`;
        const attempted = await getEventLog().append({
          runId: carrierId,
          type: 'trigger.delivery.attempted',
          payload: { subscriptionId, dedupKey, attempt: result.attempts, outcome: 'dead-lettered' },
        });
        // RFC 0232 §C.2 — the seam's event and the dead-letter record agree.
        await bindDeadLetterAttemptEvent(subscriptionId, result.deliveryId, attempted.eventId);
        await getEventLog().append({
          runId: carrierId,
          type: 'trigger.subscription.state.changed',
          payload: {
            subscriptionId,
            source,
            fromState: result.stateChange?.from ?? 'active',
            toState: result.stateChange?.to ?? 'dead-lettered',
            reason: result.stateChange?.reason ?? 'retry-exhausted',
          },
        });
        res.status(200).json({ runId: carrierId, subscriptionId, outcome: result.outcome, deliveredCount: 0 });
        return;
      }

      // `dedup` and `deliver` share one successful delivery; `dedup` then
      // repeats the SAME key, which §C-1 requires to be effectively-once.
      const first = await deliverSeamRun(deps, subscriptionId, dedupKey, source);
      let outcome = first.outcome;
      let deliveredCount = first.outcome === 'delivered' ? 1 : 0;
      if (scenario === 'dedup') {
        const second = await deliverSeamRun(deps, subscriptionId, dedupKey, source);
        outcome = second.outcome;
        // The repeat MUST NOT deliver again; counting here makes a regression
        // visible in the seam's own response, not only in the suite.
        if (second.outcome === 'delivered') deliveredCount += 1;
      }
      res.status(200).json({ runId: first.runId, subscriptionId, outcome, deliveredCount });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * One successful-path delivery through the REAL §C engine.
 *
 * Mirrors `triggerIngestionService`'s `fire` exactly, including the §C-3
 * ordering: the content-free `trigger.delivery.attempted` event is appended
 * BEFORE the run so the run can carry that event's id as `causationId`. The
 * two paths must not drift — a seam that recorded causation differently from
 * production would prove a property production does not have.
 */
async function deliverSeamRun(
  deps: { storage: Storage; hostSuite: HostAdapterSuite },
  subscriptionId: string,
  dedupKey: string,
  source: SubscriptionSource,
): Promise<{ outcome: string; runId?: string }> {
  const sub = await getSubscription(subscriptionId);
  const wf = sub?.workflowId
    ? await resolveLaunchWorkflow(deps.hostSuite.workflowCatalog, sub.tenantId, sub.workflowId)
    : null;
  if (!sub || !wf) return { outcome: 'skipped' };

  const result = await deliver({
    subscriptionId,
    dedupKey,
    fire: async (deliveryId) => {
      const runId = randomUUID();
      const now = new Date().toISOString();
      const deliveryEvent = await getEventLog().append({
        runId,
        type: 'trigger.delivery.attempted',
        payload: { subscriptionId, dedupKey, attempt: 1, outcome: 'delivered', runId },
      });
      const run: RunRecord = {
        runId,
        workflowId: sub.workflowId!,
        tenantId: sub.tenantId,
        status: 'pending',
        inputs: null,
        metadata: {
          launchResolved: wf.launchResolved,
          triggerData: { source, subscriptionId, deliveryId, dedupKey, receivedAt: now, verified: false, contentTrust: 'untrusted' },
          trustBoundary: 'untrusted',
        },
        causationId: deliveryEvent.eventId,
        configurable: {},
        createdAt: now,
        updatedAt: now,
      };
      await insertRunWithStartContext(deps.storage, run, { definition: wf.definition });
      // Awaited, not fire-and-forget: the driver reads `run.started` back
      // immediately, and a detached execution would race it.
      await executeRun(deps.storage, run, wf.definition, {
        policyResolver: deps.hostSuite.providerPolicyResolver,
      });
      return runId;
    },
  });
  return { outcome: result.outcome, ...(result.runId ? { runId: result.runId } : {}) };
}

/** Map the host-sample seam body (top-level `attachmentUrl`, nested `webhook`)
 *  onto the typed per-source ingress the real ingestion path consumes. */
function coerceSeamIngress(source: string, body: Record<string, unknown>): IngressInput {
  if (source === 'webhook') {
    const wh = (body.webhook ?? {}) as Record<string, unknown>;
    return {
      source: 'webhook',
      ...(typeof wh.method === 'string' && ['POST', 'PUT', 'PATCH'].includes(wh.method) ? { method: wh.method as 'POST' | 'PUT' | 'PATCH' } : {}),
      ...(wh.headers && typeof wh.headers === 'object' ? { headers: wh.headers as Record<string, unknown> } : {}),
      rawBody: typeof wh.rawBody === 'string' ? wh.rawBody : JSON.stringify(wh.body ?? {}),
    };
  }
  if (source === 'email') {
    return {
      source: 'email',
      ...(typeof body.from === 'string' ? { from: body.from } : {}),
      ...(typeof body.subject === 'string' ? { subject: body.subject } : {}),
      ...(typeof body.text === 'string' ? { text: body.text } : {}),
      attachmentUrls: sampleAttachmentUrls(body),
    };
  }
  if (source === 'form') {
    return {
      source: 'form',
      ...(body.fields && typeof body.fields === 'object' ? { fields: body.fields as Record<string, unknown> } : {}),
      fileUrls: sampleAttachmentUrls(body),
    };
  }
  if (source === 'stream') {
    // RFC 0127 CDP-1b seam: nested `stream:{ topic, partition, offset, key?, message }`.
    const s = (body.stream ?? {}) as Record<string, unknown>;
    return {
      source: 'stream',
      ...(typeof s.topic === 'string' ? { topic: s.topic } : {}),
      ...(typeof s.partition === 'number' ? { partition: s.partition } : {}),
      ...(typeof s.offset === 'string' ? { offset: s.offset } : {}),
      ...(typeof s.key === 'string' ? { key: s.key } : {}),
      ...(s.message !== undefined ? { message: s.message } : {}),
    };
  }
  // change — nested `change:{ op, table, changelogId, before?, after? }` (op REQUIRED).
  const c = (body.change ?? {}) as Record<string, unknown>;
  const op = c.op === 'insert' || c.op === 'update' || c.op === 'delete' ? c.op : 'insert';
  return {
    source: 'change',
    op,
    ...(typeof c.table === 'string' ? { table: c.table } : {}),
    ...(typeof c.changelogId === 'string' ? { changelogId: c.changelogId } : {}),
    ...(c.before !== undefined ? { before: c.before } : {}),
    ...(c.after !== undefined ? { after: c.after } : {}),
  };
}

/** Collect attachment/file URLs from the seam body — `attachmentUrl` (singular,
 *  the conformance shape), `attachmentUrls[]`, or `fileUrls[]`. */
function sampleAttachmentUrls(body: Record<string, unknown>): { url: string; filename?: string; mediaType?: string }[] {
  const out: { url: string; filename?: string; mediaType?: string }[] = [];
  if (typeof body.attachmentUrl === 'string') out.push({ url: body.attachmentUrl });
  for (const key of ['attachmentUrls', 'fileUrls'] as const) {
    if (Array.isArray(body[key])) {
      for (const a of body[key] as unknown[]) {
        if (a && typeof a === 'object' && typeof (a as { url?: unknown }).url === 'string') out.push(a as { url: string });
      }
    }
  }
  return out;
}

function countRequestedAttachments(source: string, body: Record<string, unknown>): number {
  if (source === 'webhook') return 0;
  return sampleAttachmentUrls(body).length;
}

function countDeliveredAttachments(source: string, triggerEvent: unknown): number {
  const te = triggerEvent as { email?: { attachments?: unknown[] }; form?: { files?: unknown[] } } | null;
  if (!te) return 0;
  if (source === 'email') return te.email?.attachments?.length ?? 0;
  if (source === 'form') return te.form?.files?.length ?? 0;
  return 0;
}

function resolveVerificationMode(v: unknown): VerificationMode {
  if (v && typeof v === 'object') {
    const mode = (v as { mode?: unknown }).mode;
    if (mode === 'required' || mode === 'best-effort' || mode === 'none') return mode;
  }
  return 'required'; // §F.2 default
}

function resolveRetryPolicy(v: unknown): Partial<RetryPolicy> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Partial<RetryPolicy> = {};
  if (typeof o.maxAttempts === 'number') out.maxAttempts = o.maxAttempts;
  if (o.backoff === 'none' || o.backoff === 'fixed' || o.backoff === 'exponential') out.backoff = o.backoff;
  return Object.keys(out).length ? out : undefined;
}

/** Build the source-specific `binding` (§F.2). The webhook signing secret + the
 *  ingest URL/address are returned ONCE here. */
function buildBinding(source: string, subscriptionId: string, secret?: string, secretFingerprint?: string, signed = false): Record<string, unknown> {
  const ingestPath = signed
    ? `${SIGNED_INGEST_ROOT}/${subscriptionId}` // RFC 0230: credential-less, signature-authenticated
    // ADR 0812 P3b — unversioned: a webhook sender POSTs here, and a retired host
    // answers the old `/v1` spelling 410 (writes are not forwarded).
    : `/trigger-subscriptions/${subscriptionId}/ingest`;
  if (source === 'webhook') {
    return { ingestUrl: ingestPath, ...(secret ? { signingSecret: secret } : {}), ...(secretFingerprint ? { secretFingerprint } : {}) };
  }
  if (source === 'email') {
    const domain = process.env.OPENWOP_TRIGGER_EMAIL_DOMAIN ?? 'in.example.com';
    return { ingestAddress: `trigger+${subscriptionId}@${domain}`, ingestUrl: ingestPath };
  }
  return { ingestUrl: ingestPath };
}

/** Map the inbound delivery body onto the typed per-source ingress input. */
function coerceIngress(source: string, raw: unknown): IngressInput | null {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (source === 'webhook') {
    return {
      source: 'webhook',
      ...(typeof b.method === 'string' && ['POST', 'PUT', 'PATCH'].includes(b.method) ? { method: b.method as 'POST' | 'PUT' | 'PATCH' } : {}),
      ...(b.headers && typeof b.headers === 'object' ? { headers: b.headers as Record<string, unknown> } : {}),
      rawBody: typeof b.rawBody === 'string' ? b.rawBody : JSON.stringify(b.body ?? b.rawBody ?? ''),
      ...(typeof b.signature === 'string' ? { signature: b.signature } : {}),
      ...(typeof b.externalDeliveryId === 'string' ? { externalDeliveryId: b.externalDeliveryId } : {}),
    };
  }
  if (source === 'email') {
    return {
      source: 'email',
      ...(typeof b.from === 'string' ? { from: b.from } : {}),
      ...(Array.isArray(b.to) ? { to: b.to.filter((x): x is string => typeof x === 'string') } : {}),
      ...(typeof b.subject === 'string' ? { subject: b.subject } : {}),
      ...(typeof b.text === 'string' ? { text: b.text } : {}),
      ...(typeof b.html === 'string' ? { html: b.html } : {}),
      ...(typeof b.dmarcPass === 'boolean' ? { dmarcPass: b.dmarcPass } : {}),
      ...(typeof b.messageId === 'string' ? { messageId: b.messageId } : {}),
      ...(Array.isArray(b.attachmentUrls) ? { attachmentUrls: b.attachmentUrls as { url: string; filename?: string; mediaType?: string }[] } : {}),
    };
  }
  if (source === 'form') {
    return {
      source: 'form',
      ...(b.fields && typeof b.fields === 'object' ? { fields: b.fields as Record<string, unknown> } : {}),
      ...(typeof b.originValid === 'boolean' ? { originValid: b.originValid } : {}),
      ...(typeof b.submissionId === 'string' ? { submissionId: b.submissionId } : {}),
      ...(Array.isArray(b.fileUrls) ? { fileUrls: b.fileUrls as { url: string; filename?: string; mediaType?: string }[] } : {}),
    };
  }
  return null;
}

/** RFC 0232 §B — `limit` is a positive integer, clamped to `maxPageSize`. */
function parseDeadLetterLimit(raw: unknown): number {
  if (raw === undefined) return TRIGGER_DEAD_LETTER_MAX_PAGE_SIZE;
  const n = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new OpenwopError('validation_error', 'Query `limit` MUST be a positive integer.', 400, { field: 'limit' });
  }
  return Math.min(n, TRIGGER_DEAD_LETTER_MAX_PAGE_SIZE);
}

/** The cursor names the subscription it was minted for, so a cursor carried
 *  to another subscription is refused rather than silently re-scoped (§B.3). */
function encodeDeadLetterCursor(subscriptionId: string, after: string): string {
  return Buffer.from(JSON.stringify({ s: subscriptionId, a: after }), 'utf8').toString('base64url');
}

function decodeDeadLetterCursor(raw: unknown, subscriptionId: string): string {
  const bad = (): OpenwopError => new OpenwopError('validation_error', 'Query `cursor` is not a cursor for this subscription.', 400, { field: 'cursor' });
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const c = parsed as { s?: unknown; a?: unknown } | null;
  if (!c || c.s !== subscriptionId || typeof c.a !== 'string' || !c.a.startsWith(`${subscriptionId}:`)) throw bad();
  return c.a;
}

/**
 * A vendor-home path is outside the v2 identity middleware's bound-id prefixes,
 * so this route reads its segment itself, in every spelling `identity.md` §5
 * names: the `~` projection, a decoded `tenant/id`, or a bare id. A bound id
 * whose tenant is not the caller's is `403 id_tenant_mismatch`, as on the
 * protocol paths; a malformed escape is `400`.
 */
function resolveSubscriptionSegment(raw: string, tenant: string): string {
  let id = raw;
  if (looksProjected(raw)) {
    try {
      id = unprojectBoundId(raw);
    } catch {
      throw new OpenwopError('validation_error', "A tenant-bound id's '~' escape MUST be followed by two hex digits.", 400);
    }
  }
  if (!id.includes('/')) return id;
  const resolved = fromWireRunId(id, tenant);
  if (!resolved.ok) throw new OpenwopError('id_tenant_mismatch', "A tenant-bound id's tenant segment MUST be the caller's.", 403);
  return resolved.runId;
}
