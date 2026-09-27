/**
 * ADR 0286 / RFC 0127 G4 — the REAL streaming/CDC push-ingress CONSUMER.
 *
 * A signature-verified broker/CDC push (Pub/Sub push front / EventBridge / Kafka→HTTP
 * bridge) lands on the admin-gated inbound webhook (features/connections/inboundWebhooks.ts)
 * and dispatches to `ingestExternalEvent` (the single ingest owner) → a NEW run
 * (source `stream`/`change`), NOT resolveAndResume. Covers: a stream push and a change push
 * each start a run with the right envelope; the durable delivery event is content-free (SR-1);
 * a bad signature is rejected; the config route is admin-gated; the sources[] advert is
 * honest-off-gated; and a redelivered push is effectively-once (dedup).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import {
  __resetInboundStore,
  setInboundConfig,
  handleInboundEvent,
  verifyStreamSignature,
  isStreamInbound,
  inboundConfigurable,
} from '../src/features/connections/inboundWebhooks.js';
import { getProvider, assertReadOnlyConsistent } from '../src/features/connections/providerRegistry.js';
import { __resetTriggerBridgeStore } from '../src/host/triggerBridgeService.js';

const WORKFLOW = 'openwop-app.uppercase'; // deterministic BYOK-free demo workflow (host catalog)
const SIGNING = 'broker-push-signing-secret-9f2';
const STREAM_PROVIDER = 'core.openwop.streams';

let server: http.Server;
let BASE: string;
let deps: { storage: Storage; hostSuite: Parameters<typeof handleInboundEvent>[0]['hostSuite'] };
const TOKEN = 'dev-token';

/** Sign a broker push exactly as the sender would: HMAC-SHA256 over `${ts}.${rawBody}`. */
function signPush(rawBody: string, now: number): { streamTimestamp: string; streamSignature: string } {
  const ts = String(Math.floor(now / 1000));
  const sig = `sha256=${createHmac('sha256', SIGNING).update(`${ts}.${rawBody}`).digest('hex')}`;
  return { streamTimestamp: ts, streamSignature: sig };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  deps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite };
  await __resetConnectionsStore();
  await __resetInboundStore();
  await __resetTriggerBridgeStore();
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const raw = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: raw as T };
}

describe('core.openwop.streams provider (RFC 0127 / ADR 0286 — ingress-only)', () => {
  it('is a built-in, read-only, no-write-scope, no-consumer-node connection provider', () => {
    const m = getProvider(STREAM_PROVIDER);
    expect(m).not.toBeNull();
    expect(m?.readOnly).toBe(true);
    expect(m?.scopes.write ?? []).toEqual([]); // INGRESS-ONLY: no outbound publish path
    expect(m?.consumerNodes).toEqual([]);
    expect(() => assertReadOnlyConsistent(m!)).not.toThrow();
  });
  it('is configurable for inbound (isStreamInbound / inboundConfigurable)', () => {
    expect(isStreamInbound(STREAM_PROVIDER)).toBe(true);
    expect(isStreamInbound('slack')).toBe(false);
    expect(inboundConfigurable(STREAM_PROVIDER)).toBe(true);
    expect(inboundConfigurable('whatsapp')).toBe(false);
  });
});

describe('verifyStreamSignature (broker push HMAC)', () => {
  const now = 1_800_000_000_000;
  const body = JSON.stringify({ source: 'stream', stream: { topic: 't', message: {} } });
  it('accepts a correctly-signed push, rejects tamper / staleness / missing', () => {
    const s = signPush(body, now);
    const ok = (rawBody: string, h = s, t = now) =>
      verifyStreamSignature({ signingSecret: SIGNING, timestampHeader: h.streamTimestamp, signatureHeader: h.streamSignature, rawBody, now: t }).ok;
    expect(ok(body)).toBe(true);
    expect(ok(body + 'x')).toBe(false); // tampered body
    expect(ok(body, s, now + 10 * 60_000)).toBe(false); // stale (> 5 min)
    expect(verifyStreamSignature({ signingSecret: SIGNING, timestampHeader: undefined, signatureHeader: undefined, rawBody: body, now }).ok).toBe(false);
  });
  it('rejects a signature minted with a different secret', () => {
    const forged = `sha256=${createHmac('sha256', 'other-secret').update(`${Math.floor(now / 1000)}.${body}`).digest('hex')}`;
    expect(verifyStreamSignature({ signingSecret: SIGNING, timestampHeader: String(Math.floor(now / 1000)), signatureHeader: forged, rawBody: body, now }).ok).toBe(false);
  });
});

describe('streaming consumer — a real broker push starts a run via ingestExternalEvent', () => {
  let streamConnId: string;
  let changeConnId: string;

  beforeAll(async () => {
    const s = await createSecretConnection({ tenantId: 'tstream', provider: STREAM_PROVIDER, kind: 'api_key', secret: 'broker-a', scope: 'user', userId: 'u1' });
    streamConnId = s.connectionId;
    await setInboundConfig({ tenantId: 'tstream', connectionId: streamConnId, provider: STREAM_PROVIDER, workflowId: WORKFLOW, signingSecret: SIGNING, streamSource: 'stream' });
    const c = await createSecretConnection({ tenantId: 'tstream', provider: STREAM_PROVIDER, kind: 'api_key', secret: 'broker-b', scope: 'user', userId: 'u1' });
    changeConnId = c.connectionId;
    await setInboundConfig({ tenantId: 'tstream', connectionId: changeConnId, provider: STREAM_PROVIDER, workflowId: WORKFLOW, signingSecret: SIGNING, streamSource: 'change' });
  });

  it('a signed stream push → a NEW run whose triggerData is source:"stream"; the delivery event is content-free (SR-1)', async () => {
    const now = Date.now();
    const canary = 'CANARY-STREAM-BODY-7c1';
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'events', partition: 3, offset: '88412', key: 'user_77', message: { type: 'page_view', secretMarker: canary } } });
    const out = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers: signPush(raw, now), now });
    expect(out.status).toBe('accepted');
    if (out.status !== 'accepted') return;
    expect(out.runId).toBeTruthy();
    const run = await deps.storage.getRun(out.runId!);
    const te = (run?.metadata as { triggerData?: { source?: string; stream?: { partition?: number; key?: string } } } | undefined)?.triggerData;
    expect(te?.source).toBe('stream');
    expect(te?.stream?.partition).toBe(3);
    expect(te?.stream?.key).toBe('user_77');
    // SR-1 — the message body is only in run.metadata.triggerData, never on the durable event.
    const events = await deps.storage.listEvents(out.runId!);
    const delivery = events.find((e) => e.type === 'trigger.delivery.attempted');
    expect(delivery).toBeTruthy();
    expect(JSON.stringify(delivery)).not.toContain(canary);
  });

  it('a signed change push (op required) → a NEW run whose triggerData is source:"change"', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'change', change: { op: 'update', table: 'contacts', changelogId: '0/1C4F9D0', after: { id: 77, tier: 'pro' } } });
    const out = await handleInboundEvent(deps, { connectionId: changeConnId, rawBody: raw, body: JSON.parse(raw), headers: signPush(raw, now), now });
    expect(out.status).toBe('accepted');
    if (out.status !== 'accepted') return;
    const run = await deps.storage.getRun(out.runId!);
    const te = (run?.metadata as { triggerData?: { source?: string; change?: { op?: string; after?: unknown } } } | undefined)?.triggerData;
    expect(te?.source).toBe('change');
    expect(te?.change?.op).toBe('update');
    expect(te?.change?.after).toEqual({ id: 77, tier: 'pro' });
  });

  it('a change push with an INVALID op is rejected (op-required validation)', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'change', change: { op: 'upsert', table: 't' } });
    const out = await handleInboundEvent(deps, { connectionId: changeConnId, rawBody: raw, body: JSON.parse(raw), headers: signPush(raw, now), now });
    expect(out.status).toBe('rejected');
  });

  it('a bad signature is rejected as unauthorized (never ingested)', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'events', partition: 1, offset: '5', message: {} } });
    const out = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers: { streamTimestamp: String(Math.floor(now / 1000)), streamSignature: 'sha256=deadbeef' }, now });
    expect(out.status).toBe('unauthorized');
  });

  it('a redelivered push (same broker coordinates) is effectively-once (§C-1 dedup)', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'events', partition: 7, offset: '99001', message: { a: 1 } } });
    const headers = signPush(raw, now);
    const first = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers, now });
    expect(first.status).toBe('accepted');
    if (first.status === 'accepted') expect(first.deduped).toBe(false);
    const second = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers, now });
    expect(second.status).toBe('accepted');
    if (second.status === 'accepted') expect(second.deduped).toBe(true);
  });

  it('flag OFF ⇒ the streaming provider refuses (neither wired nor advertised)', async () => {
    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'events', partition: 0, offset: '1', message: {} } });
    const out = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers: signPush(raw, now), now });
    process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
    expect(out.status).toBe('not_found');
  });
});

describe('HTTP end-to-end — admin-gated config + unauthenticated signed public ingest', () => {
  let connId: string;

  it('the owner configures inbound on a streams connection (admin-gated authorizeManage passes)', async () => {
    const created = await jf<{ connectionId: string; provider: string }>('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: STREAM_PROVIDER, kind: 'api_key', secret: 'broker-http', scope: 'user', displayName: 'Prod Kafka' }),
    });
    expect(created.status).toBe(201);
    connId = created.body.connectionId;
    const cfg = await jf('/v1/host/openwop-app/connections/' + connId + '/inbound', {
      method: 'PUT',
      body: JSON.stringify({ workflowId: WORKFLOW, signingSecret: SIGNING, source: 'stream' }),
    });
    expect(cfg.status).toBe(201);
  });

  it('a signed broker push to the PUBLIC ingest route (no auth header) → 202 accepted', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'http-events', partition: 4, offset: '31', message: { hi: 1 } } });
    const s = signPush(raw, now);
    // NB: no Authorization header — the broker signature IS the credential.
    const res = await fetch(`${BASE}/v1/host/openwop-app/connections-inbound/${connId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openwop-stream-signature': s.streamSignature, 'x-openwop-stream-timestamp': s.streamTimestamp },
      body: raw,
    });
    expect(res.status).toBe(202);
  });

  it('a bad-signature push to the public route → 401', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'http-events', partition: 4, offset: '32', message: {} } });
    const res = await fetch(`${BASE}/v1/host/openwop-app/connections-inbound/${connId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openwop-stream-signature': 'sha256=bad', 'x-openwop-stream-timestamp': String(Math.floor(now / 1000)) },
      body: raw,
    });
    expect(res.status).toBe(401);
  });
});

describe('honest-off advert flip (RFC 0127 G4 closure)', () => {
  it('advertises stream+change in sources[] and ingestion.externalSources[] ONLY when the flag is on', async () => {
    const on = await jf<{ triggerBridge: { sources: string[]; ingestion?: { externalSources?: string[] } } }>('/.well-known/openwop');
    expect(on.body.triggerBridge.sources).toEqual(expect.arrayContaining(['stream', 'change']));
    expect(on.body.triggerBridge.ingestion?.externalSources).toEqual(expect.arrayContaining(['stream', 'change']));

    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    const off = await jf<{ triggerBridge: { sources: string[]; ingestion?: { externalSources?: string[] } } }>('/.well-known/openwop');
    process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
    expect(off.body.triggerBridge.sources).not.toContain('stream');
    expect(off.body.triggerBridge.sources).not.toContain('change');
    expect(off.body.triggerBridge.ingestion?.externalSources).not.toContain('stream');
    // webhook/email/form remain advertised (honest-off only drops the 0127 sources).
    expect(off.body.triggerBridge.sources).toEqual(expect.arrayContaining(['webhook', 'email', 'form']));
  });
});
