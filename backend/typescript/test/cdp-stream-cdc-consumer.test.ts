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
 *
 * Sabotage-witnessed (/grade-tests w38): the replay window, the HMAC compare, the unauthorized
 * return, the partition / `after` mapping, the consumer's own op check (asserted by ITS reason
 * `invalid_payload`), the broker-coordinate dedup seed (the redelivery carries a DIFFERENT body),
 * the SR-1 delivery payload, the flag-off advert, the provider's `readOnly`, and the inbound
 * config route's owner gate each turn a case red.
 *
 * Double guard (honest ceiling): the flag-OFF case cannot tell the consumer's own
 * `streamCdcIngestionEnabled()` refusal from `ingestExternalEvent`'s `isAcceptedIngestionSource`
 * skip — both surface as `not_found` (w38 probe `cc-flag`).
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
    // The consumer's OWN refusal (`buildStreamIngress` → `invalid_payload`). `ingestExternalEvent`
    // would also reject `upsert` (a double guard), but with a different reason — asserting the
    // reason is what makes this case fail if the consumer's check is removed (w38 `cc-op`).
    expect(out).toEqual({ status: 'rejected', reason: 'invalid_payload' });
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
    const first = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers: signPush(raw, now), now });
    expect(first).toMatchObject({ status: 'accepted', deduped: false });
    // Same coordinates, DIFFERENT body: the dedup key is the broker coordinates, not a body hash
    // (an identical re-send could not tell those apart — w38 probe `cc-dedupseed`).
    const raw2 = JSON.stringify({ source: 'stream', stream: { topic: 'events', partition: 7, offset: '99001', message: { a: 2 } } });
    const second = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw2, body: JSON.parse(raw2), headers: signPush(raw2, now), now });
    expect(second).toMatchObject({ status: 'accepted', deduped: true });
    if (first.status === 'accepted' && second.status === 'accepted') expect(second.runId).toBe(first.runId);
  });

  it('flag OFF ⇒ the streaming provider refuses (neither wired nor advertised)', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'events', partition: 0, offset: '1', message: {} } });
    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    let out: Awaited<ReturnType<typeof handleInboundEvent>>;
    try {
      out = await handleInboundEvent(deps, { connectionId: streamConnId, rawBody: raw, body: JSON.parse(raw), headers: signPush(raw, now), now });
    } finally {
      process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
    }
    // Double guard (see header): either gate alone yields this.
    expect(out.status).toBe('not_found');
  });
});

describe('HTTP end-to-end — admin-gated config + unauthenticated signed public ingest', () => {
  let connId: string;
  let cfgStatus: number;

  // Setup lives in beforeAll so no case depends on another case's order (shuffle-safe).
  beforeAll(async () => {
    const created = await jf<{ connectionId: string; provider: string }>('/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: STREAM_PROVIDER, kind: 'api_key', secret: 'broker-http', scope: 'user', displayName: 'Prod Kafka' }),
    });
    connId = created.body.connectionId;
    const cfg = await jf('/host/openwop-app/connections/' + connId + '/inbound', {
      method: 'PUT',
      body: JSON.stringify({ workflowId: WORKFLOW, signingSecret: SIGNING, source: 'stream' }),
    });
    cfgStatus = cfg.status;
  });

  it('the owner configures inbound on a streams connection (admin-gated authorizeManage passes)', async () => {
    expect(cfgStatus).toBe(201);
    // Read back through the same gated route: the config landed as written.
    const read = await jf<{ config: { workflowId?: string; streamSource?: string; enabled: boolean } | null }>('/host/openwop-app/connections/' + connId + '/inbound');
    expect(read.status).toBe(200);
    expect(read.body.config).toMatchObject({ workflowId: WORKFLOW, streamSource: 'stream', enabled: true });
  });

  it('a different caller cannot (re)configure the owner\'s inbound — 403, config unchanged', async () => {
    // A second, distinct bearer principal (`bearer:cdc-intr`): configured for this case only.
    const prior = process.env.OPENWOP_API_KEYS;
    process.env.OPENWOP_API_KEYS = 'dev-token:*,cdc-intruder-key:*';
    let denied: { status: number; body: { error?: string; message?: string } };
    try {
      denied = await jf<{ error?: string; message?: string }>('/host/openwop-app/connections/' + connId + '/inbound', {
        method: 'PUT',
        headers: { authorization: 'Bearer cdc-intruder-key' },
        body: JSON.stringify({ workflowId: 'openwop-app.other', signingSecret: 'intruder-signing-secret-000', source: 'change' }),
      });
    } finally {
      if (prior === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = prior;
    }
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only the connecting user may manage this connection.');
    const read = await jf<{ config: { workflowId?: string; streamSource?: string } | null }>('/host/openwop-app/connections/' + connId + '/inbound');
    expect(read.body.config).toMatchObject({ workflowId: WORKFLOW, streamSource: 'stream' });
  });

  it('a signed broker push to the PUBLIC ingest route (no auth header) → 202 accepted', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'http-events', partition: 4, offset: '31', message: { hi: 1 } } });
    const s = signPush(raw, now);
    // NB: no Authorization header — the broker signature IS the credential.
    const res = await fetch(`${BASE}/host/openwop-app/connections-inbound/${connId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openwop-stream-signature': s.streamSignature, 'x-openwop-stream-timestamp': s.streamTimestamp },
      body: raw,
    });
    expect(res.status).toBe(202);
  });

  it('a bad-signature push to the public route → 401', async () => {
    const now = Date.now();
    const raw = JSON.stringify({ source: 'stream', stream: { topic: 'http-events', partition: 4, offset: '32', message: {} } });
    const res = await fetch(`${BASE}/host/openwop-app/connections-inbound/${connId}`, {
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
    let off: { status: number; body: { triggerBridge: { sources: string[]; ingestion?: { externalSources?: string[] } } } };
    try {
      off = await jf<{ triggerBridge: { sources: string[]; ingestion?: { externalSources?: string[] } } }>('/.well-known/openwop');
    } finally {
      process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
    }
    expect(off.body.triggerBridge.sources).not.toContain('stream');
    expect(off.body.triggerBridge.sources).not.toContain('change');
    expect(off.body.triggerBridge.ingestion?.externalSources).not.toContain('stream');
    // webhook/email/form remain advertised (honest-off only drops the 0127 sources).
    expect(off.body.triggerBridge.sources).toEqual(expect.arrayContaining(['webhook', 'email', 'form']));
  });
});
