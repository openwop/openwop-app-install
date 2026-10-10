/**
 * ADR 0793 / RFC 0230 — the signed, credential-less inbound-webhook ingest.
 *
 * Pinned through the real app (HTTP): the facet is advertised only when the flag
 * is on; registration returns a `whsec_` secret once and the signed ingest URL;
 * a Standard-Webhooks-signed post needs NO OpenWOP credential and answers 202
 * with a tenant-bound runId; a repeated `webhook-id` answers 200 duplicate with
 * the same run; under `required` a bad signature or a stale timestamp answers
 * 401 `signature_invalid` and — §C.1 — leaves the subscription `active` (a signed
 * post then still delivers); the delivered run's `run.started.causationId` is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

const TOKEN = 'dev-token';
let server: http.Server; let base = '';
const saved = { signing: process.env.OPENWOP_TRIGGER_INBOUND_SIGNING };

function sign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
}
const now = (): string => String(Math.floor(Date.now() / 1000));
const freshId = (): string => `msg_${randomBytes(12).toString('hex')}`;

async function authed(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'OpenWOP-Version': '2' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
/** A post with NO OpenWOP credential — only the Standard Webhooks headers. */
async function ingest(url: string, body: string, headers: Record<string, string>) {
  const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
async function register(mode: 'none' | 'required') {
  const r = await authed('POST', '/trigger-subscriptions', { source: 'webhook', workflowId: 'openwop-app.uppercase', verification: { mode } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { subscription: { subscriptionId: string }; binding: { ingestUrl: string; signingSecret: string } };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (saved.signing === undefined) delete process.env.OPENWOP_TRIGGER_INBOUND_SIGNING; else process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = saved.signing;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0793 / RFC 0230 — signed inbound-webhook ingest', () => {
  // ADR 0812 P3c-0: the v1 half of this leg (the v1 `triggerBridge` record, and
  // "the two majors are one claim") was deleted with the v1 discovery document;
  // the v2 record, gated by the same flag, is what remains.
  it('v2 discovery advertises triggerBridge.ingestion.inboundSigning only while the flag is on (ADR 0810)', async () => {
    const disco = async () => (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as Record<string, any>;
    // ADR 0810 supersedes ADR 0793's "no v2 triggerBridge": the v2 record is the
    // same facets under {status, since, until, witness}, with no `supported`.
    const v2 = (await disco()).triggerBridge;
    expect(v2).toMatchObject({ status: 'experimental', witness: 'witnessable-gated' });
    expect(v2.supported, 'presence is the advert at v2').toBeUndefined();
    expect(v2.ingestion?.inboundSigning).toEqual(['standard-webhooks-1']);
    expect(v2.deadLetter).toEqual({ retentionDays: 7, maxPageSize: 100 });
    process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'false';
    try {
      const off = await disco();
      expect(off.triggerBridge?.ingestion, 'the ingestion block itself is still advertised').toBeDefined();
      expect(off.triggerBridge?.ingestion?.inboundSigning, 'v2 drops it with the flag').toBeUndefined();
      const r = await ingest('/host/openwop-app/trigger-ingest/tgsub-nope', '{}', {});
      expect(r.status, 'the route is off with the flag').toBe(404);
    } finally { process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'true'; }
  });

  it('registration returns a whsec_ secret once and the signed ingest URL; a re-read never carries it', async () => {
    const { subscription, binding } = await register('none');
    expect(binding.signingSecret).toMatch(/^whsec_[A-Za-z0-9+/]+={0,2}$/);
    expect(binding.ingestUrl).toBe(`/host/openwop-app/trigger-ingest/${bareRunId(subscription.subscriptionId)}`);
    const reread = await authed('GET', `/trigger-subscriptions/${projectBoundId(subscription.subscriptionId)}`);
    expect(reread.status, 'a 404 would make the no-secret check below vacuous').toBe(200);
    expect(JSON.stringify(reread.body)).not.toContain(binding.signingSecret);
    expect(JSON.stringify(reread.body)).not.toContain('whsec_');
  });

  it('a signed post needs no OpenWOP credential: 202 + tenant-bound runId; the same webhook-id is 200 duplicate, same run', async () => {
    const { binding } = await register('none');
    const body = JSON.stringify({ hello: 'world' }); const id = freshId(); const ts = now();
    const h = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sign(binding.signingSecret, id, ts, body) };
    const first = await ingest(binding.ingestUrl, body, h);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.outcome).toBe('delivered');
    expect(first.body.runId).toMatch(/\//); // tenant-bound (identity.md §5)
    const again = await ingest(binding.ingestUrl, body, h);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ outcome: 'duplicate', runId: first.body.runId });
  });

  it('the delivered run carries run.started.causationId (RFC 0083 §C)', async () => {
    const { binding } = await register('none');
    const body = '{}'; const id = freshId(); const ts = now();
    const r = await ingest(binding.ingestUrl, body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sign(binding.signingSecret, id, ts, body) });
    expect(r.status).toBe(202);
    // The 202 carries the tenant-bound run id; the major-2 read takes it as returned.
    const poll = await authed('GET', `/runs/${encodeURIComponent(String(r.body.runId))}/events/poll`);
    const events = (poll.body.events ?? []) as Array<{ type: string; causationId?: string }>;
    const started = events.find((e) => e.type === 'run.started');
    expect(started, `events: ${events.map((e) => e.type).join(',')}`).toBeDefined();
    expect(typeof started?.causationId === 'string' && started.causationId.length > 0).toBe(true);
  });

  it('under `required`, a bad signature and a stale timestamp are 401 signature_invalid — and the subscription stays active (§C.1)', async () => {
    const { subscription, binding } = await register('required');
    const body = '{"a":1}';
    const bad = await ingest(binding.ingestUrl, body, { 'webhook-id': freshId(), 'webhook-timestamp': now(), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('signature_invalid');
    expect(bad.body.runId).toBeUndefined();
    const staleTs = String(Math.floor(Date.now() / 1000) - 600); const sid = freshId();
    const stale = await ingest(binding.ingestUrl, body, { 'webhook-id': sid, 'webhook-timestamp': staleTs, 'webhook-signature': sign(binding.signingSecret, sid, staleTs, body) });
    expect(stale.status, 'a correctly signed but >300 s stale post is refused').toBe(401);

    const sub = await authed('GET', `/trigger-subscriptions/${projectBoundId(subscription.subscriptionId)}`);
    expect(sub.body.subscription.state, '§C.1: a refused post MUST NOT change the subscription state').toBe('active');
    expect((sub.body.deliveries as Array<{ outcome: string }>).some((d) => d.outcome === 'dead-lettered'), 'the refused post is recorded as a dead-lettered delivery').toBe(true);

    const id = freshId(); const ts = now();
    const ok = await ingest(binding.ingestUrl, body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sign(binding.signingSecret, id, ts, body) });
    expect(ok.status, 'the subscription still delivers after refused posts').toBe(202);
  });

  it('an unknown subscription and the management surface: 404 for the former, credential still required for the latter', async () => {
    const r = await ingest('/host/openwop-app/trigger-ingest/tgsub-0000000000000000', '{}', { 'webhook-id': freshId(), 'webhook-timestamp': now(), 'webhook-signature': 'v1,x' });
    expect(r.status).toBe(404);
    const mgmt = await fetch(`${base}/trigger-subscriptions`);
    expect(mgmt.status, 'only the ingest root is public').toBe(401);
  });
});
