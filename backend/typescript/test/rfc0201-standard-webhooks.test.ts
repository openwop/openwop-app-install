/**
 * RFC 0201 / ADR 0747 — the Standard Webhooks companion scheme, host side.
 *
 *   1. The signer against the UPSTREAM reference library's own test vector
 *      (standard-webhooks/standard-webhooks `libraries/javascript/src/webhook.test.ts`,
 *      "sign function works") — not against this host's own verifier, which
 *      would agree with any self-consistent mistake.
 *   2. Registration through the full app: the opt-in is validated (§B.5–§B.6),
 *      the endpoint is verified BEFORE anything is persisted (§D), the 201 echoes
 *      the applied list and never the secret (§B.6–§B.7), and a registration
 *      that did not opt in is untouched — no verification, the same 201 keys as
 *      before this ADR (§B.8 / §D.15).
 *   3. Rotation (§E) through the full app: tenant/opt-in/secret refusals, the
 *      response shape, and the row state.
 *   4. The worker: webhook-id stable across retries, dual-signing inside the
 *      overlap with OpenWOP-Signature on the previous secret, a single entry
 *      after it, and the send-time read (a rotation AFTER enqueue signs the next
 *      attempt with the new secret).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { WebhookDeliveryRecord, WebhookSubscriptionRecord } from '../src/types.js';
import { decodeWhsec, signStandardWebhooks, signWebhookV1 } from '../src/host/webhookSignature.js';
import { processDueWebhookDeliveries, signingHeaders, WEBHOOK_MAX_ATTEMPTS } from '../src/host/webhookDeliveryWorker.js';
import { verifyWebhookEndpoint } from '../src/host/webhookEndpointVerification.js';
import { __resetVerificationBudgetForTests, secretRotationOverlapSeconds, takeVerificationBudget } from '../src/host/webhookStandardWebhooks.js';

const mintWhsec = (bytes = 32): string => `whsec_${randomBytes(bytes).toString('base64')}`;

function swVerifies(secret: string, headers: Record<string, string>, body: string): number {
  const id = headers['webhook-id']!;
  const ts = headers['webhook-timestamp']!;
  const expected = createHmac('sha256', decodeWhsec(secret)!).update(`${id}.${ts}.${body}`).digest('base64');
  return (headers['webhook-signature'] ?? '').split(' ').filter((e) => e === `v1,${expected}`).length;
}

describe('RFC 0201 — the signer (upstream Standard Webhooks test vector)', () => {
  const KEY = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  it('signs the upstream vector byte for byte', () => {
    expect(decodeWhsec(KEY)?.length).toBe(24);
    expect(signStandardWebhooks(KEY, 'msg_p5jXN8AQM9LWM0D4loKWxJek', '1614265330', '{"test": 2432232314}'))
      .toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });
  it('decodes only whsec_ secrets of 24–64 bytes', () => {
    expect(decodeWhsec(mintWhsec(24))?.length).toBe(24);
    expect(decodeWhsec(mintWhsec(64))?.length).toBe(64);
    expect(decodeWhsec(mintWhsec(23))).toBeNull();
    expect(decodeWhsec(mintWhsec(65))).toBeNull();
    expect(decodeWhsec(randomBytes(32).toString('base64'))).toBeNull();
    expect(decodeWhsec('whsec_not*base64*at*all*padding*okay==')).toBeNull();
  });
});

describe('RFC 0201 §E.18 / §D.17 — config knobs', () => {
  it('overlapSeconds defaults to a day and refuses an out-of-range knob rather than clamping it', () => {
    expect(secretRotationOverlapSeconds({})).toBe(86_400);
    expect(secretRotationOverlapSeconds({ OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S: '60' })).toBe(60);
    expect(secretRotationOverlapSeconds({ OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S: '59' })).toBe(86_400);
    expect(secretRotationOverlapSeconds({ OPENWOP_WEBHOOK_SECRET_ROTATION_OVERLAP_S: '604801' })).toBe(86_400);
  });
  it('the verification budget is per tenant and resets each minute', () => {
    __resetVerificationBudgetForTests();
    const env = { OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN: '2' };
    expect(takeVerificationBudget('t1', 0, env)).toBe(true);
    expect(takeVerificationBudget('t1', 1, env)).toBe(true);
    expect(takeVerificationBudget('t1', 2, env)).toBe(false);
    expect(takeVerificationBudget('t2', 2, env)).toBe(true);
    expect(takeVerificationBudget('t1', 60_000, env)).toBe(true);
    __resetVerificationBudgetForTests();
  });
});

// ── full app ─────────────────────────────────────────────────────────────────

interface Hit { mode: string; headers: http.IncomingHttpHeaders; body: string }
let receiver: http.Server;
let rxBase = '';
const hits: Hit[] = [];
let appServer: http.Server;
let base = '';
let dir = '';
let inspect: Storage;

beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // the loopback receiver is the point
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const mode = (req.url ?? '').split('/').pop() ?? '';
      hits.push({ mode, headers: req.headers, body });
      let challenge: unknown;
      try { challenge = (JSON.parse(body) as { challenge?: unknown }).challenge; } catch { challenge = undefined; }
      const json = (status: number, v: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
      switch (mode) {
        case 'echo': return json(200, { challenge });
        case 'no-echo': return json(200, {});
        case 'wrong-echo': return json(200, { challenge: `${String(challenge)}x` });
        case 'empty': res.writeHead(204); res.end(); return;
        case 'fail': return json(500, { challenge });
        case 'redirect': res.writeHead(307, { location: `${rxBase}/echo` }); res.end(); return;
        // ADR 0755 (WIT-WH-4) — a 2xx that echoes the challenge but past the 16 KiB cap.
        case 'huge': return json(200, { challenge, pad: 'x'.repeat(17 * 1024) });
        default: return json(404, {});
      }
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  rxBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  dir = mkdtempSync(join(tmpdir(), 'owp-rfc0201-'));
  const dsn = `sqlite://${join(dir, 'engine.db')}`;
  const app = await createApp({ port: 0, storageDsn: dsn, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { appServer = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  inspect = await openStorage(dsn);
});

afterAll(async () => {
  await inspect?.close();
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => receiver.close(() => r()));
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { hits.length = 0; __resetVerificationBudgetForTests(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
const register = (body: Record<string, unknown>) => call('POST', '/v1/webhooks', body);
const optIn = (mode: string, secret: string) => ({ url: `${rxBase}/${mode}`, events: ['run.completed'], signatureAlgorithms: ['v1', 'standard-webhooks-1'], secret });

describe('RFC 0201 §B — registration opt-in', () => {
  it('§B.8 / §D.15 — a registration without signatureAlgorithms is NOT verified and keeps its 201 shape', async () => {
    const res = await register({ url: `${rxBase}/no-echo`, events: ['run.completed'] });
    expect(res.status).toBe(201);
    expect(hits).toHaveLength(0);
    // The exact key set this route answered before ADR 0747 — a host-minted
    // secret, returned once, and no signatureAlgorithms.
    expect(Object.keys(res.json).sort()).toEqual(['events', 'secret', 'secretFingerprint', 'subscriptionId', 'url', 'webhookId']);
    const row = await inspect.getWebhook(res.json.webhookId as string);
    expect(row?.signatureAlgorithms).toBeUndefined();
  });

  it('§B.5–§B.6 — every malformed opt-in is 400 validation_error, sent nowhere', async () => {
    const secret = mintWhsec();
    const base0 = { url: `${rxBase}/echo`, events: ['run.completed'] };
    const refusals: Array<Record<string, unknown>> = [
      { ...base0, signatureAlgorithms: ['standard-webhooks-1'], secret },
      { ...base0, signatureAlgorithms: ['v1', 'v1', 'standard-webhooks-1'], secret },
      { ...base0, signatureAlgorithms: ['v1', 'unlisted-9'], secret },
      { ...base0, signatureAlgorithms: [], secret },
      { ...base0, signatureAlgorithms: 'v1', secret },
      { ...base0, signatureAlgorithms: ['v1', 'standard-webhooks-1'] },
      { ...base0, signatureAlgorithms: ['v1', 'standard-webhooks-1'], secret: 'plain-shared-secret-of-sufficient-length' },
      { ...base0, signatureAlgorithms: ['v1', 'standard-webhooks-1'], secret: `whsec_${Buffer.alloc(8, 7).toString('base64')}` },
    ];
    for (const body of refusals) {
      const res = await register(body);
      expect(res.status, JSON.stringify(body.signatureAlgorithms)).toBe(400);
      expect(res.json.error).toBe('validation_error');
    }
    expect(hits).toHaveLength(0);
  });

  it('§B.4 — ["v1"] alone is accepted, unverified, and echoed', async () => {
    const res = await register({ url: `${rxBase}/no-echo`, events: ['run.completed'], signatureAlgorithms: ['v1'] });
    expect(res.status).toBe(201);
    expect(res.json.signatureAlgorithms).toEqual(['v1']);
    expect(hits).toHaveLength(0);
  });

  it('§D.13 / §B.7 — an echoing endpoint is verified once, signed, and the 201 echoes the list but never the secret', async () => {
    const secret = mintWhsec();
    const res = await register(optIn('echo', secret));
    expect(res.status).toBe(201);
    expect(res.json.signatureAlgorithms).toEqual(['v1', 'standard-webhooks-1']);
    const key = decodeWhsec(secret)!;
    for (const leak of [secret, secret.slice(6), key.toString('hex'), key.toString('base64url')]) {
      expect(res.text.includes(leak)).toBe(false);
    }
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    const body = JSON.parse(h.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['challenge', 'type']);
    expect(body.type).toBe('openwop.webhook.verification');
    expect(String(body.challenge)).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(h.headers['openwop-event-type']).toBeUndefined();
    expect(h.headers['x-openwop-event-type']).toBeUndefined();
    expect(String(h.headers['webhook-id'])).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(swVerifies(secret, h.headers as Record<string, string>, h.body)).toBe(1);
    const row = await inspect.getWebhook(res.json.webhookId as string);
    expect(row?.signatureAlgorithms).toEqual(['v1', 'standard-webhooks-1']);
  });

  it('§D.14 — no-echo, wrong-echo, empty 2xx, non-2xx and a redirect are refused, not retried, and persist nothing', async () => {
    const secret = mintWhsec();
    const before = (await inspect.listWebhooks({})).length;
    for (const mode of ['no-echo', 'wrong-echo', 'empty', 'fail', 'redirect']) {
      const res = await register(optIn(mode, secret));
      expect(res.status, mode).toBe(400);
      expect(res.json.error, mode).toBe('webhook_endpoint_unverified');
      // Code review H1 — only a closed reason code reaches the caller; the raw
      // network detail (addresses, errno text) would be a reachability oracle.
      // ADR 0755 (WIT-WH-5) — and ONE code: the fine set still told "nothing
      // listening" from "an HTTP server answered". §D.14 mandates no reason.
      expect(res.json.details, mode).toEqual({ reason: 'not_confirmed' });
      expect(JSON.stringify(res.json), mode).not.toContain('127.0.0.1');
      expect(hits.filter((x) => x.mode === mode), mode).toHaveLength(1);
    }
    // The 307 pointed at /echo; following it would have produced a hit there.
    expect(hits.filter((x) => x.mode === 'echo')).toHaveLength(0);
    expect((await inspect.listWebhooks({})).length).toBe(before);
  });

  it('ADR 0755 (WIT-WH-5) — an unreachable port answers exactly what a live non-echoing server does', async () => {
    const secret = mintWhsec();
    // A port with nothing listening: bind, read the port, close.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const dead = await register({ ...optIn('echo', secret), url: `http://127.0.0.1:${deadPort}/x` });
    const live = await register(optIn('no-echo', secret));
    expect(dead.status).toBe(400);
    expect(live.status).toBe(400);
    expect(dead.json, 'no port/HTTP-liveness oracle').toEqual(live.json);
  });

  it('ADR 0755 (WIT-WH-4) — a challenge echoed past the 16 KiB response cap is refused, and the fine reason is only in the detail', async () => {
    const secret = mintWhsec();
    const res = await register(optIn('huge', secret));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('webhook_endpoint_unverified');
    expect(hits.filter((x) => x.mode === 'huge')).toHaveLength(1);
    const direct = await verifyWebhookEndpoint(`${rxBase}/huge`, secret);
    expect(direct.ok).toBe(false);
    expect(direct.ok ? '' : direct.detail).toMatch(/^body_too_large: /);
    // Control: the same receiver under the cap is accepted — the refusal above is the cap.
    expect((await verifyWebhookEndpoint(`${rxBase}/echo`, secret)).ok).toBe(true);
  });

  it('§D.17 — an over-budget tenant is refused 429 before any request leaves', async () => {
    process.env.OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN = '1';
    try {
      const secret = mintWhsec();
      expect((await register(optIn('echo', secret))).status).toBe(201);
      const res2 = await fetch(`${base}/v1/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
        body: JSON.stringify(optIn('echo', secret)),
      });
      expect(res2.status).toBe(429);
      expect(res2.headers.get('retry-after')).toBe('60');
      expect(hits).toHaveLength(1);
    } finally {
      delete process.env.OPENWOP_WEBHOOK_VERIFY_PER_TENANT_PER_MIN;
    }
  });
});

describe('RFC 0201 §E — rotateWebhookSecret', () => {
  it('refuses unknown (404), non-opted (400) and a malformed secret (400); rotates an opted-in row with no secret in the body', async () => {
    const s1 = mintWhsec();
    const s2 = mintWhsec();
    expect((await call('POST', '/v1/webhooks/00000000-0000-4000-8000-000000000000/rotate-secret', { secret: s2 })).status).toBe(404);

    const plain = await register({ url: `${rxBase}/no-echo`, events: ['run.completed'] });
    const notOpted = await call('POST', `/v1/webhooks/${String(plain.json.webhookId)}/rotate-secret`, { secret: s2 });
    expect(notOpted.status).toBe(400);
    expect(notOpted.json.error).toBe('validation_error');

    const reg = await register(optIn('echo', s1));
    const id = String(reg.json.webhookId);
    expect((await call('POST', `/v1/webhooks/${id}/rotate-secret`, { secret: 'nope' })).status).toBe(400);
    expect((await call('POST', `/v1/webhooks/${id}/rotate-secret?tenantId=someone-else`, { secret: s2 })).status).toBe(403);

    const hitsBefore = hits.length;
    const rotated = await call('POST', `/v1/webhooks/${id}/rotate-secret`, { secret: s2 });
    expect(rotated.status).toBe(200);
    expect(Object.keys(rotated.json).sort()).toEqual(['previousSecretExpiresAt', 'rotatedAt']);
    const span = Date.parse(String(rotated.json.previousSecretExpiresAt)) - Date.parse(String(rotated.json.rotatedAt));
    expect(span).toBe(secretRotationOverlapSeconds() * 1000);
    expect(rotated.text.includes(s2) || rotated.text.includes(s2.slice(6))).toBe(false);
    expect(hits.length).toBe(hitsBefore); // §E.21 — no re-verification

    const row = await inspect.getWebhook(id);
    expect(row?.secret).toBe(s2);            // plaintext passthrough: no KMS in this posture
    expect(row?.previousSecret).toBe(s1);
    expect(row?.previousSecretExpiresAt).toBe(Date.parse(String(rotated.json.previousSecretExpiresAt)));

    // ADR 0755 (WIT-WH-9) — the list shows the opt-in and the running overlap,
    // and still no secret in any encoding.
    const list = await call('GET', '/v1/webhooks');
    const listed = (list.json.subscriptions as Array<Record<string, unknown>>).find((x) => x.webhookId === id);
    expect(listed?.signatureAlgorithms).toEqual(['v1', 'standard-webhooks-1']);
    expect(listed?.rotatedAt).toBe(rotated.json.rotatedAt);
    expect(listed?.previousSecretExpiresAt).toBe(rotated.json.previousSecretExpiresAt);
    for (const leak of [s1, s2, s1.slice(6), s2.slice(6)]) expect(list.text.includes(leak)).toBe(false);
  });

  it('§E.20 — a second rotation inside the overlap retires the OLDEST secret', async () => {
    const [s1, s2, s3] = [mintWhsec(), mintWhsec(), mintWhsec()];
    const reg = await register(optIn('echo', s1));
    const id = String(reg.json.webhookId);
    await call('POST', `/v1/webhooks/${id}/rotate-secret`, { secret: s2 });
    await call('POST', `/v1/webhooks/${id}/rotate-secret`, { secret: s3 });
    const row = await inspect.getWebhook(id);
    expect([row?.secret, row?.previousSecret]).toEqual([s3, s2]);
  });
});

describe('RFC 0201 — the major-2 surface', () => {
  async function v2(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  it('§A.3 / §E.18 — the v2 facet lists standard-webhooks-1 beside v1 and advertises secretRotation; v1 says the same', async () => {
    const d2 = await v2('GET', '/.well-known/openwop');
    const facet = d2.json.webhooks as { signatureAlgorithms?: string[]; secretRotation?: { overlapSeconds?: number } };
    expect(facet.signatureAlgorithms).toEqual(['v1', 'standard-webhooks-1']);
    expect(facet.secretRotation?.overlapSeconds).toBe(secretRotationOverlapSeconds());
    const d1 = await call('GET', '/.well-known/openwop');
    const w1 = (d1.json.capabilities as { webhooks?: { signatureAlgorithms?: string[]; secretRotation?: unknown } }).webhooks;
    expect(w1?.signatureAlgorithms).toEqual(facet.signatureAlgorithms);
    expect(w1?.secretRotation).toEqual(facet.secretRotation);
  });

  it('§E.18 — v2 rotate-secret: a foreign-tenant bound id is 403 id_tenant_mismatch before lookup; the own bound id rotates', async () => {
    const reg = await v2('POST', '/webhooks', optIn('echo', mintWhsec()));
    expect(reg.status).toBe(201);
    const id = String(reg.json.webhookId);
    expect(id).toContain('/');
    const foreign = await v2('POST', `/webhooks/${encodeURIComponent(`openwop-foreign/${'a'.repeat(22)}`)}/rotate-secret`, { secret: mintWhsec() });
    expect(foreign.status).toBe(403);
    expect(foreign.json.error).toBe('id_tenant_mismatch');
    const own = await v2('POST', `/webhooks/${encodeURIComponent(id)}/rotate-secret`, { secret: mintWhsec() });
    expect(own.status).toBe(200);
  });
});

// ── the worker ───────────────────────────────────────────────────────────────

describe('RFC 0201 §C / §E.20 — delivery signing from the subscription at send time', () => {
  const T0 = 1_700_000_000_000;
  const payload = JSON.stringify({ type: 'run.completed', runId: 'r1' });
  let storage: Storage;
  let seen: Array<Record<string, string>>;
  let status: number;
  let server: http.Server;
  let url = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { seen.push(req.headers as Record<string, string>); res.writeHead(status); res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(async () => { storage = await openStorage('memory://'); seen = []; status = 200; });
  afterEach(() => { vi.useRealTimers(); });

  async function subscribe(over: Partial<WebhookSubscriptionRecord>): Promise<void> {
    await storage.insertWebhook({ subscriptionId: 'sub-sw', tenantId: 'default', url, events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString(), ...over });
  }
  function row(over: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
    return { deliveryId: '6f1c2a0e-5b8d-4c11-9e2f-0a1b2c3d4e5f', subscriptionId: 'sub-sw', url, secret: 'enqueue-time-copy', eventType: 'run.completed', payload, status: 'pending', attempts: 0, maxAttempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: T0, claimedBy: null, claimExpiresAt: null, lastError: null, createdAt: T0, updatedAt: T0, ...over };
  }

  it('§B.8 — a non-opted subscription gets no webhook-* header and the v1 signature it always had', async () => {
    await subscribe({});
    await storage.enqueueWebhookDelivery(row({ secret: 'shh' }));
    await processDueWebhookDeliveries(storage, 'w', T0);
    expect(seen).toHaveLength(1);
    const h = seen[0]!;
    expect(Object.keys(h).filter((k) => k.startsWith('webhook-'))).toEqual([]);
    expect(h['openwop-signature']).toBe(`sha256=${signWebhookV1('shh', h['openwop-timestamp']!, payload)}`);
  });

  it('§C.9 / §C.10 — an opted-in delivery is dual-signed and keeps ONE webhook-id across retries', async () => {
    const s1 = mintWhsec();
    await subscribe({ secret: s1, signatureAlgorithms: ['v1', 'standard-webhooks-1'] });
    await storage.enqueueWebhookDelivery(row());
    status = 500;
    await processDueWebhookDeliveries(storage, 'w', T0);
    status = 200;
    await processDueWebhookDeliveries(storage, 'w', T0 + 60_000);
    expect(seen).toHaveLength(2);
    for (const h of seen) {
      expect(h['openwop-signature-algorithm']).toBe('v1');
      expect(h['webhook-timestamp']).toBe(h['openwop-timestamp']);
      expect(h['webhook-id']).not.toBe(h['openwop-webhook-id']);
      expect(swVerifies(s1, h, payload)).toBe(1);
      // Keyed by the secret STRING as issued — never the enqueue-time row copy.
      expect(h['openwop-signature']).toBe(`sha256=${signWebhookV1(s1, h['openwop-timestamp']!, payload)}`);
    }
    expect(seen[0]!['webhook-id']).toBe(seen[1]!['webhook-id']);
    expect(seen[0]!['webhook-id']).toBe('6f1c2a0e-5b8d-4c11-9e2f-0a1b2c3d4e5f');
  });

  it('§E.20 — inside the overlap: two entries, OpenWOP-Signature on the PREVIOUS secret; after it: one entry, on the new one', async () => {
    const [s1, s2] = [mintWhsec(), mintWhsec()];
    const sub: WebhookSubscriptionRecord = {
      subscriptionId: 'x', tenantId: 'default', url, events: ['*'], createdAt: new Date(T0).toISOString(),
      signatureAlgorithms: ['v1', 'standard-webhooks-1'], secret: s2, previousSecret: s1, previousSecretExpiresAt: T0 + 60_000,
    };
    const during = await signingHeaders(sub, 'delivery-id-0000000001', '1700000000', payload, T0 + 59_999);
    const dh = { ...during.standardWebhooks! };
    expect(dh['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(swVerifies(s2, dh, payload)).toBe(1);
    expect(swVerifies(s1, dh, payload)).toBe(1);
    expect(during.openwopSignature).toBe(signWebhookV1(s1, '1700000000', payload));

    const after = await signingHeaders(sub, 'delivery-id-0000000001', '1700000000', payload, T0 + 60_000);
    const ah = { ...after.standardWebhooks! };
    expect(ah['webhook-signature']!.split(' ')).toHaveLength(1);
    expect(swVerifies(s2, ah, payload)).toBe(1);
    expect(swVerifies(s1, ah, payload)).toBe(0);
    expect(after.openwopSignature).toBe(signWebhookV1(s2, '1700000000', payload));
  });

  it('ADR 0747 — the secret is read at SEND time: a rotation after enqueue signs the next attempt', async () => {
    const [s1, s2] = [mintWhsec(), mintWhsec()];
    await subscribe({ secret: s1, signatureAlgorithms: ['v1', 'standard-webhooks-1'] });
    await storage.enqueueWebhookDelivery(row({ secret: s1 }));
    // Rotate with an overlap that has ALREADY ended by the time the row is sent.
    await storage.rotateWebhookSecret('sub-sw', { secret: s2, rotatedAt: T0, previousSecretExpiresAt: Date.now() - 1 });
    await processDueWebhookDeliveries(storage, 'w', T0);
    const h = seen[0]!;
    expect(swVerifies(s2, h, payload)).toBe(1);
    expect(swVerifies(s1, h, payload)).toBe(0);
    expect(h['openwop-signature']).toBe(`sha256=${signWebhookV1(s2, h['openwop-timestamp']!, payload)}`);
  });

  it('ADR 0755 (WIT-WH-2) — a signing failure is a failed ATTEMPT: counted, backed off, dead-lettered — never a leased poison row', async () => {
    // An opted-in row whose stored secret is not `whsec_` — what a `previous_secret`
    // sealed under a retired key, or a KMS outage, looks like from here: signing throws.
    await subscribe({ secret: 'not-a-whsec-secret', signatureAlgorithms: ['v1', 'standard-webhooks-1'] });
    await storage.enqueueWebhookDelivery(row({ maxAttempts: 2 }));
    await expect(processDueWebhookDeliveries(storage, 'w', T0), 'the batch must not reject').resolves.toBe(1);
    expect(seen, 'nothing is sent unsigned').toHaveLength(0);
    let [r] = await storage.listWebhookDeliveries({ subscriptionIds: ['sub-sw'], limit: 5 });
    expect(r?.attempts, 'the attempt is COUNTED — without it the row never dead-letters').toBe(1);
    expect(r?.status).toBe('pending');
    expect(r?.lastError).toMatch(/^signing_failed:[A-Za-z]+$/);
    await processDueWebhookDeliveries(storage, 'w', T0 + 3_600_000);
    [r] = await storage.listWebhookDeliveries({ subscriptionIds: ['sub-sw'], limit: 5 });
    expect(r?.status, 'the ordinary backoff ends in dead-letter').toBe('dead');
  });

  it('ADR 0747 — a row whose subscription is gone is not sent; it is dead-lettered', async () => {
    await storage.enqueueWebhookDelivery(row());
    await processDueWebhookDeliveries(storage, 'w', T0);
    expect(seen).toHaveLength(0);
    const [r] = await storage.listWebhookDeliveries({ subscriptionIds: ['sub-sw'], limit: 5 });
    expect(r?.status).toBe('dead');
    expect(r?.lastError).toBe('subscription_deleted');
  });
});
