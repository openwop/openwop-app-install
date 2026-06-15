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

import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import {
  getSubscription,
  listDeliveries,
  listSubscriptions,
  registerSubscription,
  setSubscriptionState,
  type RetryPolicy,
  type VerificationMode,
} from '../host/triggerBridgeService.js';
import {
  ingestExternalEvent,
  isExternalIngestionSource,
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
  app.get('/v1/trigger-subscriptions', async (req, res, next) => {
    try {
      res.json({ subscriptions: await listSubscriptions(tenantOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/trigger-subscriptions/:subscriptionId', async (req, res, next) => {
    try {
      const sub = await getSubscription(req.params.subscriptionId);
      if (!sub || sub.tenantId !== tenantOf(req)) {
        throw new OpenwopError('not_found', 'Trigger subscription not found.', 404, { subscriptionId: req.params.subscriptionId });
      }
      res.json({ subscription: sub, deliveries: await listDeliveries(sub.subscriptionId) });
    } catch (err) {
      next(err);
    }
  });

  // RFC 0099 §F.2 — register an external-event subscription bound to a workflow.
  // Gated on the ingestion capability being wired (fail-closed); requires deps.
  app.post('/v1/trigger-subscriptions', async (req, res, next) => {
    try {
      if (!triggerIngestionEnabled() || !deps) {
        throw new OpenwopError('host_capability_missing', 'External-event trigger ingestion is not enabled on this host.', 501);
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
      // cannot start. The host resolves the workflow under the caller's tenant.
      const wf = await deps.hostSuite.workflowCatalog.getWorkflow(workflowId);
      if (!wf) {
        throw new OpenwopError('not_found', 'Workflow not found (cannot bind a subscription to a workflow the caller cannot start).', 404, { workflowId });
      }

      const verificationMode = resolveVerificationMode(body.verification);
      const tenantId = tenantOf(req);
      const subscriptionId = `tgsub-${randomBytes(8).toString('hex')}`;

      // Webhook: mint a signing secret, return it ONCE, persist only the
      // fingerprint (re-reads never return the cleartext secret).
      let secretFingerprint: string | undefined;
      let secret: string | undefined;
      if (source === 'webhook') {
        secret = randomBytes(32).toString('hex');
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
      if (source === 'webhook' && secret) storeIngestSecret(subscriptionId, secret);

      const binding = buildBinding(source, subscriptionId, secret, secretFingerprint);
      res.status(201).json({ subscription: sub, binding });
    } catch (err) {
      next(err);
    }
  });

  // Operator pause/resume (§B). { state: 'paused' | 'active' }.
  app.patch('/v1/trigger-subscriptions/:subscriptionId', async (req, res, next) => {
    try {
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
  app.post('/v1/trigger-subscriptions/:subscriptionId/ingest', async (req, res, next) => {
    try {
      if (!triggerIngestionEnabled() || !deps) {
        throw new OpenwopError('host_capability_missing', 'External-event trigger ingestion is not enabled on this host.', 501);
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
  app.post('/v1/host/openwop-app/trigger-bridge/ingest', async (req, res, next) => {
    try {
      if (!triggerIngestionEnabled() || !deps) {
        throw new OpenwopError('host_capability_missing', 'External-event trigger ingestion is not enabled on this host.', 404);
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const source = body.source;
      if (typeof source !== 'string' || !isExternalIngestionSource(source)) {
        throw new OpenwopError('validation_error', 'Field `source` MUST be one of webhook | email | form.', 400, { field: 'source' });
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
  return {
    source: 'form',
    ...(body.fields && typeof body.fields === 'object' ? { fields: body.fields as Record<string, unknown> } : {}),
    fileUrls: sampleAttachmentUrls(body),
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
function buildBinding(source: string, subscriptionId: string, secret?: string, secretFingerprint?: string): Record<string, unknown> {
  const ingestPath = `/v1/trigger-subscriptions/${subscriptionId}/ingest`;
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
