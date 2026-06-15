/**
 * External-event trigger ingestion (RFC 0099 / ADR 0034) — the webhook / email /
 * form sources of the RFC 0083 durable trigger bridge actually ingesting an
 * externally-originated event → starting a run with `ctx.triggerData`.
 *
 * Covers the DoD:
 *   - a webhook / email / form event → a run whose `metadata.triggerData` is the
 *     normalized `TriggerEvent` (the in-run `ctx.triggerData`);
 *   - the trigger payload is NOT in the event log (the `trigger-ingestion-
 *     content-redaction` invariant — `trigger.delivery.attempted` stays
 *     content-free);
 *   - dedup returns the prior runId (effectively-once);
 *   - an SSRF target (private/metadata host) is rejected — the attachment is
 *     dropped, the run still starts;
 *   - a `required`-verification event that fails verification starts no run;
 *   - the `triggerBridge.ingestion` capability is advertised only when wired.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { getEventLog, setEventLogBackend } from '../src/executor/eventLog.js';
import {
  __resetHostExtPersistence,
  initHostExtPersistence,
} from '../src/host/hostExtPersistence.js';
import {
  __resetTriggerBridgeStore,
  listDeliveries,
  registerSubscription,
} from '../src/host/triggerBridgeService.js';
import {
  __resetIngestSecrets,
  bodyWithinCap,
  ingestExternalEvent,
  resolveAttachment,
  triggerIngestionEnabled,
  verifyWebhookSignature,
  type TriggerEvent,
} from '../src/host/triggerIngestionService.js';

const WF = 'openwop-app.uppercase';

describe('trigger ingestion service (RFC 0099 §F, sqlite memory)', () => {
  const storage = openSqliteStorage(':memory:');
  const hostSuite = createHostAdapterSuite({ storage });
  const deps = { storage, hostSuite };

  beforeAll(() => {
    initHostExtPersistence(storage);
    setEventLogBackend(storage);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetTriggerBridgeStore();
    __resetIngestSecrets();
  });

  async function regExternal(source: 'webhook' | 'email' | 'form', mode: 'required' | 'none' = 'none') {
    const subscriptionId = `tgsub-${source}-${Math.random().toString(16).slice(2)}`;
    await registerSubscription({ subscriptionId, tenantId: 't1', source, workflowId: WF, verificationMode: mode });
    return subscriptionId;
  }

  it('a webhook event starts a run carrying the TriggerEvent as ctx.triggerData (metadata.triggerData)', async () => {
    const sub = await regExternal('webhook');
    const result = await ingestExternalEvent(deps, sub, {
      source: 'webhook',
      method: 'POST',
      headers: { 'x-event': 'issue.created', authorization: 'Bearer leak-me', cookie: 'sid=abc' },
      rawBody: JSON.stringify({ issue: 7 }),
      externalDeliveryId: 'gh-delivery-1',
    });
    expect(result.outcome).toBe('delivered');
    expect(result.runId).toBeTruthy();

    const run = await storage.getRun(result.runId!);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.source).toBe('webhook');
    expect(te.contentTrust).toBe('untrusted');
    expect(te.webhook?.body).toEqual({ issue: 7 });
    // §C-3 causation edge — the delivery id is the envelope's deliveryId AND the
    // delivery-attempt's id bound to this runId (so /ancestry resolves delivery
    // → run; executeRun stamps it onto run.started as causationId).
    const deliveries = await listDeliveries(sub);
    expect(deliveries.some((d) => d.deliveryId === te.deliveryId && d.outcome === 'delivered' && d.runId === result.runId)).toBe(true);
    // §F.1 header allowlist — credential headers stripped, others kept.
    expect(te.webhook?.headers?.['x-event']).toBe('issue.created');
    expect(te.webhook?.headers?.authorization).toBeUndefined();
    expect(te.webhook?.headers?.cookie).toBeUndefined();
  });

  it('an email event normalizes to a TriggerEvent.email and starts a run', async () => {
    const sub = await regExternal('email');
    const result = await ingestExternalEvent(deps, sub, {
      source: 'email',
      from: 'customer@acme.test',
      to: ['support@host.test'],
      subject: 'Help',
      text: 'my widget is broken',
      messageId: 'msg-1',
    });
    expect(result.outcome).toBe('delivered');
    const run = await storage.getRun(result.runId!);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.source).toBe('email');
    expect(te.email?.subject).toBe('Help');
    expect(te.email?.from).toBe('customer@acme.test');
    expect(te.webhook).toBeUndefined();
    expect(te.form).toBeUndefined();
  });

  it('a form event normalizes to a TriggerEvent.form and starts a run', async () => {
    const sub = await regExternal('form');
    const result = await ingestExternalEvent(deps, sub, {
      source: 'form',
      fields: { name: 'Ada', rating: 2 },
      submissionId: 'form-1',
    });
    expect(result.outcome).toBe('delivered');
    const run = await storage.getRun(result.runId!);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.source).toBe('form');
    expect(te.form?.fields).toEqual({ name: 'Ada', rating: 2 });
  });

  it('redaction: the inbound content never appears on the trigger.delivery.attempted event payload', async () => {
    const sub = await regExternal('webhook');
    const secretMaterial = 'super-secret-issue-body-xyz';
    const result = await ingestExternalEvent(deps, sub, {
      source: 'webhook',
      rawBody: JSON.stringify({ secret: secretMaterial }),
      externalDeliveryId: 'd-redact',
    });
    expect(result.outcome).toBe('delivered');
    const events = await getEventLog().list(result.runId!, { fromSeq: 0, limit: 1000 });
    const delivery = events.find((e) => e.type === 'trigger.delivery.attempted');
    expect(delivery).toBeTruthy();
    const serialized = JSON.stringify(delivery!.payload);
    // Content-free: only ids + opaque dedupKey + attempt + outcome + runId.
    expect(serialized).not.toContain(secretMaterial);
    expect(serialized).not.toContain('Bearer');
    const payload = delivery!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['attempt', 'dedupKey', 'outcome', 'runId', 'subscriptionId'].sort());
    expect((payload.dedupKey as string)).toMatch(/^[0-9a-f]{32}$/); // opaque hash, not content
  });

  it('dedup: a re-delivery of the same external delivery id returns the prior runId (effectively-once)', async () => {
    const sub = await regExternal('webhook');
    const r1 = await ingestExternalEvent(deps, sub, { source: 'webhook', rawBody: '{"x":1}', externalDeliveryId: 'dup-1' });
    expect(r1.outcome).toBe('delivered');
    const r2 = await ingestExternalEvent(deps, sub, { source: 'webhook', rawBody: '{"x":1}', externalDeliveryId: 'dup-1' });
    expect(r2.outcome).toBe('deduped');
    expect(r2.runId).toBe(r1.runId);
  });

  it('verification required + bad signature → no run (rejected, signature-invalid)', async () => {
    const subscriptionId = `tgsub-wh-${Math.random().toString(16).slice(2)}`;
    // A webhook sub with a signing secret + required verification.
    await registerSubscription({
      subscriptionId,
      tenantId: 't1',
      source: 'webhook',
      workflowId: WF,
      verificationMode: 'required',
      secretFingerprint: 'deadbeef',
    });
    const result = await ingestExternalEvent(deps, subscriptionId, {
      source: 'webhook',
      rawBody: '{"x":1}',
      signature: 'sha256=not-the-real-hmac',
      externalDeliveryId: 'bad-sig-1',
    });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('signature-invalid');
    expect(result.runId).toBeUndefined();
  });

  it('email verification required + DMARC fail → no run', async () => {
    const sub = await regExternal('email', 'required');
    const result = await ingestExternalEvent(deps, sub, { source: 'email', subject: 'spoof', dmarcPass: false, messageId: 'spoof-1' });
    expect(result.outcome).toBe('rejected');
    expect(result.reason).toBe('signature-invalid');
  });

  it('SSRF: an attachment URL on a private/metadata host is dropped, the run still starts', async () => {
    const sub = await regExternal('email');
    const result = await ingestExternalEvent(deps, sub, {
      source: 'email',
      subject: 'with attachment',
      messageId: 'att-ssrf-1',
      attachmentUrls: [{ url: 'http://169.254.169.254/latest/meta-data/', filename: 'evil' }],
    });
    expect(result.outcome).toBe('delivered'); // run still starts (§F.4 negative)
    const run = await storage.getRun(result.runId!);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.email?.attachments ?? []).toHaveLength(0); // the SSRF attachment was dropped
  });

  it('a paused subscription skips ingestion (no run)', async () => {
    const subscriptionId = `tgsub-paused-${Math.random().toString(16).slice(2)}`;
    await registerSubscription({ subscriptionId, tenantId: 't1', source: 'webhook', workflowId: WF, verificationMode: 'none' });
    const { setSubscriptionState } = await import('../src/host/triggerBridgeService.js');
    await setSubscriptionState(subscriptionId, 'paused');
    const result = await ingestExternalEvent(deps, subscriptionId, { source: 'webhook', rawBody: '{}', externalDeliveryId: 'p1' });
    expect(result.outcome).toBe('skipped');
  });
});

describe('trigger ingestion helpers (pure)', () => {
  it('verifyWebhookSignature accepts a valid HMAC and rejects a forged one', () => {
    const secret = 'shh';
    const body = '{"a":1}';
    const good = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(secret, body, `sha256=${good}`)).toBe(true);
    expect(verifyWebhookSignature(secret, body, good)).toBe(true); // bare hex form
    expect(verifyWebhookSignature(secret, body, 'sha256=deadbeef')).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
  });

  it('bodyWithinCap rejects an oversize body', () => {
    expect(bodyWithinCap('ok')).toBe(true);
    const huge = 'x'.repeat(2_000_000);
    expect(bodyWithinCap(huge)).toBe(false);
  });

  it('resolveAttachment refuses a denied (loopback/metadata) host', async () => {
    expect(await resolveAttachment('http://169.254.169.254/x')).toBeNull();
    expect(await resolveAttachment('http://localhost/x')).toBeNull();
    expect(await resolveAttachment('not a url')).toBeNull();
  });

  it('triggerIngestionEnabled defaults on, fails closed when disabled', () => {
    const prev = process.env.OPENWOP_TRIGGER_INGESTION_ENABLED;
    delete process.env.OPENWOP_TRIGGER_INGESTION_ENABLED;
    expect(triggerIngestionEnabled()).toBe(true);
    process.env.OPENWOP_TRIGGER_INGESTION_ENABLED = 'false';
    expect(triggerIngestionEnabled()).toBe(false);
    if (prev === undefined) delete process.env.OPENWOP_TRIGGER_INGESTION_ENABLED;
    else process.env.OPENWOP_TRIGGER_INGESTION_ENABLED = prev;
  });
});

describe('trigger ingestion HTTP surface (RFC 0099 §F.2/§F.3)', () => {
  let server: http.Server;
  const PORT = 18766;
  const BASE = `http://127.0.0.1:${PORT}`;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    delete process.env.OPENWOP_TRIGGER_INGESTION_ENABLED;
    const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __resetTriggerBridgeStore();
    await new Promise<void>((res) => { server = app.listen(PORT, res); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | undefined }> {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
    if (res.status === 204) return { status: 204, body: undefined };
    return { status: res.status, body: (await res.json()) as T };
  }

  // Narrow `body` for the non-204 call sites that assert on the parsed JSON.
  function bodyOf<T>(res: { body: T | undefined }): T {
    expect(res.body).toBeDefined();
    return res.body!;
  }

  it('advertises triggerBridge.ingestion only when wired (default on)', async () => {
    const body = bodyOf(await jf<{ triggerBridge?: { sources?: string[]; ingestion?: { externalSources?: string[]; registrationEndpoint?: boolean } } }>('/.well-known/openwop'));
    expect(body.triggerBridge?.sources).toEqual(expect.arrayContaining(['queue', 'webhook', 'email', 'form']));
    expect(body.triggerBridge?.ingestion?.externalSources).toEqual(['webhook', 'email', 'form']);
    expect(body.triggerBridge?.ingestion?.registrationEndpoint).toBe(true);
  });

  it('POST /v1/trigger-subscriptions registers a webhook source + returns a binding with the signing secret once', async () => {
    const reg = await jf<{ subscription: { subscriptionId: string; source: string; secretFingerprint?: string }; binding: { ingestUrl: string; signingSecret?: string; secretFingerprint?: string } }>(
      '/v1/trigger-subscriptions',
      { method: 'POST', body: JSON.stringify({ source: 'webhook', workflowId: WF }) },
    );
    expect(reg.status).toBe(201);
    const regBody = bodyOf(reg);
    expect(regBody.subscription.source).toBe('webhook');
    expect(regBody.binding.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(regBody.binding.secretFingerprint).toBe(regBody.subscription.secretFingerprint);

    // Re-read NEVER returns the cleartext secret (fingerprint only).
    const readBody = bodyOf(await jf<{ subscription: Record<string, unknown> }>(`/v1/trigger-subscriptions/${regBody.subscription.subscriptionId}`));
    expect(JSON.stringify(readBody.subscription)).not.toContain(regBody.binding.signingSecret);
    expect(readBody.subscription.secretFingerprint).toBe(regBody.subscription.secretFingerprint);
  });

  it('POST /v1/trigger-subscriptions rejects a non-resolvable workflow (RFC 0049 bind check)', async () => {
    const reg = await jf('/v1/trigger-subscriptions', { method: 'POST', body: JSON.stringify({ source: 'email', workflowId: 'no.such.workflow' }) });
    expect(reg.status).toBe(404);
  });

  it('an inbound delivery on a form subscription starts a run end-to-end', async () => {
    const reg = bodyOf(await jf<{ subscription: { subscriptionId: string } }>('/v1/trigger-subscriptions', {
      method: 'POST',
      body: JSON.stringify({ source: 'form', workflowId: WF, verification: { mode: 'none' } }),
    }));
    const subId = reg.subscription.subscriptionId;
    const ingest = await jf<{ outcome: string; runId?: string }>(`/v1/trigger-subscriptions/${subId}/ingest`, {
      method: 'POST',
      body: JSON.stringify({ fields: { q: 'hi' }, submissionId: 's-http-1' }),
    });
    expect(ingest.status).toBe(200);
    const ingestBody = bodyOf(ingest);
    expect(ingestBody.outcome).toBe('delivered');
    expect(ingestBody.runId).toBeTruthy();
  });
});
