/**
 * ADR 1053 D5 / D7 / D3 / D9 — the parts of the WhatsApp fix the end-to-end file
 * (`adr1053-whatsapp-send-and-inbound.test.ts`) does not reach:
 *  - D5: a STOP whose consent write fails is a 5xx, and the BSP's redelivery of
 *    the same message is processed (the claim was released). Red before: the
 *    observer was fail-soft, the route answered 202 and the opt-out was lost.
 *  - D7: a viewer's run cannot send (`workspace:write` at the seam); an editor's
 *    reaches the service. Red before: no surface policy.
 *  - D3: a Meta Cloud batch carrying messages AND statuses moves the row; the
 *    closed vocabulary ignores `queued`/unknown words.
 *  - D3: the no-request ingest URL equals the operator-facing one for every base.
 *  - D9: health matches its sender exactly.
 *
 * Sabotage-witnessed 2026-11-03 (each red here, restored): the observer registered
 * without `strict`; the surface policy dropped; the status write's connection check
 * removed; health back on a substring match; languageCode dropped from the template
 * dispatch key; the parked-status merge removed.
 */
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';

let failNextKeywordWrite = false;
vi.mock('../src/features/consent/keywordLadder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/consent/keywordLadder.js')>();
  return {
    ...actual,
    applyKeywordConsent: async (...args: Parameters<typeof actual.applyKeywordConsent>) => {
      if (failNextKeywordWrite) { failNextKeywordWrite = false; throw new Error('storage unavailable'); }
      return actual.applyKeywordConsent(...args);
    },
  };
});

const emitted: Array<{ type: string; tenantId: string; payload: Record<string, unknown> }> = [];
vi.mock('../src/host/hostEventDispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/hostEventDispatcher.js')>();
  return {
    ...actual,
    emitHostEvent: async (e: Parameters<typeof actual.emitHostEvent>[0]) => {
      emitted.push({ type: e.type, tenantId: e.tenantId, payload: e.payload as Record<string, unknown> });
      return actual.emitHostEvent(e);
    },
  };
});

let nextMetaId = '';
let metaDelayMs = 0;
const metaHits: string[] = [];

const { createApp } = await import('../src/index.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { buildFeatureSurfaces } = await import('../src/host/featureSurfaces.js');
const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
const { setInboundConfig } = await import('../src/features/connections/inboundWebhooks.js');
const { pairConnection } = await import('../src/features/connections/messagingOutbound.js');
const { getConsent, recordConsent } = await import('../src/features/consent/consentService.js');
const { recordNoTrainAttestation } = await import('../src/features/whatsapp/compliance.js');
const { extractWaStatuses, recordDeliveryStatus, getDeliveryStatus, listDeliveryFailures, eraseWhatsAppSubject, __setParkRaceHookForTest } = await import('../src/features/whatsapp/whatsappService.js');
const { senderIdMatches } = await import('../src/features/whatsapp/health.js');
const { configuredInboundIngestUrl, inboundIngestUrl } = await import('../src/features/connections/oauthFlow.js');
const { configureKmsClient, createLocalAesKmsClient } = await import('../src/byok/kmsEncryption.js');
// A shared `ws:` workspace stores secrets KMS-wrapped; a local AES client stands in.
configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));

let BASE = '';
let server: http.Server;
let meta: http.Server;
const TOKEN = 'workspace-auth-token-strict-0123';
const APP_SECRET = 'meta-app-secret-0123456789abcdef';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  meta = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      metaHits.push(raw);
      const id = nextMetaId || `wamid.${randomBytes(3).toString('hex')}`;
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messages: [{ id }] })); }, metaDelayMs);
    });
  });
  await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_META_GRAPH_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
  for (const id of ['users', 'whatsapp', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  delete process.env.OPENWOP_META_GRAPH_BASE;
  await new Promise<void>((r) => meta.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

function twilioSign(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', TOKEN).update(data, 'utf8').digest('base64');
}

describe('D5 — a STOP that could not be written is never acked', () => {
  it('answers 5xx, then processes the BSP redelivery of the same message', async () => {
    const T = `org:wa1053s-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: `ACS:${TOKEN}`, scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-twilio', '+15550301001');
    await setInboundConfig({ tenantId: T, connectionId: conn, provider: 'whatsapp-twilio', workflowId: 'wf-none', signingSecret: TOKEN });
    await recordNoTrainAttestation(T, 'admin-0');
    const from = '+15550302001';
    await recordConsent({ tenantId: T, subjectKey: from, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:form' });
    const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(conn)}`;
    const params = { MessageSid: `SMstrict-${randomBytes(3).toString('hex')}`, From: `whatsapp:${from}`, To: 'whatsapp:+15550301001', Body: 'STOP' };
    const post = () => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSign(`https://app.example.test${path}`, params) }, body: new URLSearchParams(params).toString() });
    failNextKeywordWrite = true;
    expect((await post()).status).toBe(500);
    expect((await getConsent(T, from))?.categories['marketing.whatsapp']).toBe(true);
    expect((await post()).status).toBe(202);
    const after = await getConsent(T, from);
    expect(after?.categories['marketing.whatsapp']).toBe(false);
    // The lane the keyword arrived on is on the record, so a forged mass-STOP can be traced.
    expect(after?.source).toBe(`whatsapp:keyword:opt-out:conn=${conn}:axis=workspace`);
  });

  it('is additive: the existing fail-soft observers still run, in registration order, after the strict one, and a throwing one is still swallowed', async () => {
    const T = `org:wa1053o-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: `ACO:${TOKEN}`, scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-twilio', '+15550301009');
    await setInboundConfig({ tenantId: T, connectionId: conn, provider: 'whatsapp-twilio', workflowId: 'wf-none', signingSecret: TOKEN });
    const calls: string[] = [];
    const { registerInboundObserver } = await import('../src/features/connections/inboundWebhooks.js');
    const { getConversation } = await import('../src/features/whatsapp/whatsappService.js');
    registerInboundObserver('whatsapp-twilio', async ({ tenantId }) => { if (tenantId === T) { calls.push(`soft-1:${(await getConversation(T, conn, '+15550302009')) ? 'after-strict' : 'before-strict'}`); throw new Error('soft observer fails'); } });
    registerInboundObserver('whatsapp-twilio', async ({ tenantId }) => { if (tenantId === T) calls.push('soft-2'); });
    const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(conn)}`;
    const params = { MessageSid: `SMorder-${randomBytes(3).toString('hex')}`, From: 'whatsapp:+15550302009', To: 'whatsapp:+15550301009', Body: 'hello' };
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSign(`https://app.example.test${path}`, params) }, body: new URLSearchParams(params).toString() });
    expect(res.status).toBe(202);
    expect(calls).toEqual(['soft-1:after-strict', 'soft-2']);
  });
});

describe('D8b — the exemption is narrow, bounded, and never leaves a delivery unbudgeted (grade-code WA85CD-17/-18)', () => {
  async function withBudgets<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const keys = ['OPENWOP_RATELIMIT_IP_REQS_PER_MIN', 'OPENWOP_RATELIMIT_TRUST_LOOPBACK', 'OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { OPENWOP_RATELIMIT_TRUST_LOOPBACK: 'false', ...env });
    const { _resetRateLimitState } = await import('../src/middleware/rateLimit.js');
    _resetRateLimitState();
    try { return await fn(); } finally {
      _resetRateLimitState();
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  const twilioPost = (conn: string, params: Record<string, string>) => {
    const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(conn)}`;
    return fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSign(`https://app.example.test${path}`, params) }, body: new URLSearchParams(params).toString() });
  };
  async function waConn(tag: string): Promise<{ T: string; conn: string }> {
    const T = `org:wa1053n-${tag}-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: `ACN:${TOKEN}`, scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-twilio', '+15550301020');
    await setInboundConfig({ tenantId: T, connectionId: conn, provider: 'whatsapp-twilio', workflowId: 'wf-none', signingSecret: TOKEN });
    return { T, conn };
  }

  it('a non-WhatsApp provider (Telegram) is still charged to the per-IP budget', async () => {
    const T = `org:wa1053tg-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'telegram', kind: 'bearer', secret: 'tg-bot-token', scope: 'workspace' })).connectionId;
    await setInboundConfig({ tenantId: T, connectionId: conn, provider: 'telegram', workflowId: 'wf-none', signingSecret: 'telegram-secret-0123456789' });
    await withBudgets({ OPENWOP_RATELIMIT_IP_REQS_PER_MIN: '3' }, async () => {
      const post = (n: number) => fetch(`${BASE}/host/openwop-app/connections-inbound/${encodeURIComponent(conn)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'telegram-secret-0123456789' },
        body: JSON.stringify({ update_id: 1000 + n, message: { message_id: n, chat: { id: 7 }, text: 'hi' } }),
      });
      for (let i = 0; i < 3; i += 1) expect((await post(i)).status).not.toBe(429);
      expect((await post(9)).status).toBe(429);
    });
  });

  it('an unknown connection id and a disabled WhatsApp config are not exempt (fail closed)', async () => {
    const { T, conn } = await waConn('dis');
    const { disableInboundForRevokedConnection, isIngestBudgetExempt } = await import('../src/features/connections/inboundWebhooks.js');
    // The predicate itself, read straight from the in-memory set: enabled WhatsApp → exempt;
    // unknown or disabled → not. (Over HTTP both also 404 and spend the failure budget, so
    // the HTTP legs below alone could not tell a fail-open predicate apart.)
    expect(isIngestBudgetExempt(conn)).toBe(true);
    expect(isIngestBudgetExempt('conn:does-not-exist')).toBe(false);
    await disableInboundForRevokedConnection(T, conn);
    expect(isIngestBudgetExempt(conn)).toBe(false);
    await withBudgets({ OPENWOP_RATELIMIT_IP_REQS_PER_MIN: '3' }, async () => {
      for (let i = 0; i < 2; i += 1) expect((await twilioPost('conn:does-not-exist', { MessageSid: `SMu${i}`, Body: 'x' })).status).not.toBe(429);
      expect((await twilioPost(conn, { MessageSid: 'SMd1', From: 'whatsapp:+15550302020', To: 'whatsapp:+15550301020', Body: 'STOP' })).status).not.toBe(429);
      // Three charged (two unknown, one disabled): the fourth is cut off.
      expect((await twilioPost(conn, { MessageSid: 'SMd2', From: 'whatsapp:+15550302020', To: 'whatsapp:+15550301020', Body: 'STOP' })).status).toBe(429);
    });
  });

  it('a verified status-callback flood on one connection hits the per-connection budget', async () => {
    const { conn } = await waConn('st');
    await withBudgets({ OPENWOP_RATELIMIT_IP_REQS_PER_MIN: '100', OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN: '2' }, async () => {
      const status = (n: number) => twilioPost(conn, { MessageSid: `SMst${n}`, MessageStatus: 'delivered', From: 'whatsapp:+15550301020', To: 'whatsapp:+15550302021' });
      expect((await status(1)).status).toBe(202);
      expect((await status(2)).status).toBe(202);
      expect((await status(3)).status).toBe(429);
    });
  });

  it('a strict-STOP 5xx AFTER verification does not spend the failure budget; the next signed delivery still passes', async () => {
    const { conn } = await waConn('5xx');
    await withBudgets({ OPENWOP_RATELIMIT_IP_REQS_PER_MIN: '2' }, async () => {
      for (let i = 0; i < 3; i += 1) {
        failNextKeywordWrite = true;
        expect((await twilioPost(conn, { MessageSid: `SM5x${i}-${randomBytes(2).toString('hex')}`, From: 'whatsapp:+15550302022', To: 'whatsapp:+15550301020', Body: 'STOP' })).status).toBe(500);
      }
      failNextKeywordWrite = false;
      expect((await twilioPost(conn, { MessageSid: `SM5ok-${randomBytes(2).toString('hex')}`, From: 'whatsapp:+15550302022', To: 'whatsapp:+15550301020', Body: 'STOP' })).status).toBe(202);
    });
  });

  it('a hung re-list of the exemption set does not block the next one past two minutes', async () => {
    const { isIngestBudgetExempt, relistIngestExemptions, __setIngestRelistForTest } = await import('../src/features/connections/inboundWebhooks.js');
    let calls = 0;
    const hang = (): Promise<void> => { calls += 1; return new Promise<void>(() => undefined); };
    try {
      __setIngestRelistForTest(hang, { listedAt: 0, startedAt: null });
      isIngestBudgetExempt('conn:x');
      expect(calls).toBe(1);
      isIngestBudgetExempt('conn:x'); // in flight, under two minutes: not started again
      expect(calls).toBe(1);
      __setIngestRelistForTest(hang, { startedAt: Date.now() - 121_000 }); // the hung one is now stale
      isIngestBudgetExempt('conn:x');
      expect(calls).toBe(2);
    } finally {
      __setIngestRelistForTest(null, { startedAt: null });
      await relistIngestExemptions();
    }
  });
});

describe('D8b — a signed provider delivery is never charged to the per-IP write budget', () => {
  it('verified deliveries pass a budget of 3; unverified ones spend it and are then cut off', async () => {
    const T = `org:wa1053rl-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: `ACR:${TOKEN}`, scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-twilio', '+15550301010');
    await setInboundConfig({ tenantId: T, connectionId: conn, provider: 'whatsapp-twilio', workflowId: 'wf-none', signingSecret: TOKEN });
    const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(conn)}`;
    const post = (params: Record<string, string>, sig?: string) => fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig ?? twilioSign(`https://app.example.test${path}`, params) },
      body: new URLSearchParams(params).toString(),
    });
    const saved = { lim: process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN, loop: process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK };
    process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = '3';
    process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK = 'false';
    try {
      for (let i = 0; i < 6; i += 1) {
        expect((await post({ MessageSid: `SMrl-${i}-${randomBytes(2).toString('hex')}`, From: 'whatsapp:+15550302010', To: 'whatsapp:+15550301010', Body: 'STOP' })).status).toBe(202);
      }
      for (let i = 0; i < 3; i += 1) expect((await post({ MessageSid: `SMbad-${i}`, Body: 'x' }, 'forged')).status).toBe(401);
      expect((await post({ MessageSid: 'SMafter', From: 'whatsapp:+15550302010', To: 'whatsapp:+15550301010', Body: 'hi' })).status).toBe(429);
    } finally {
      const { _resetRateLimitState } = await import('../src/middleware/rateLimit.js');
      _resetRateLimitState();
      if (saved.lim === undefined) delete process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN; else process.env.OPENWOP_RATELIMIT_IP_REQS_PER_MIN = saved.lim;
      if (saved.loop === undefined) delete process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK; else process.env.OPENWOP_RATELIMIT_TRUST_LOOPBACK = saved.loop;
    }
  });
});

function client() {
  let cookie = '';
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const get = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const put = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const del = async (path: string): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: cookie ? { cookie } : {} });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { post, get, put, delete: del };
}

describe('D7 — a send needs workspace:write at the seam', () => {
  it("refuses a viewer's run before the service; an editor's run reaches it", async () => {
    const tenantId = `org:wa1053f-${randomBytes(3).toString('hex')}`;
    const ids: string[] = [];
    const owner = client();
    for (const c of [owner, client(), client()]) {
      const r = await c.post('/host/openwop-app/test/login', { email: `wa1053-${randomBytes(3).toString('hex')}@acme.test`, tenantId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push((r.body as { user: { userId: string } }).user.userId);
    }
    const [, editorId, viewerId] = ids as [string, string, string];
    const orgId = ((await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body as { orgId: string }).orgId;
    for (const [subject, role] of [[editorId, 'editor'], [viewerId, 'viewer']] as const) {
      expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: role, subject, roles: [role] })).status).toBe(201);
    }
    const asViewer = buildFeatureSurfaces({ tenantId, runId: 'r-v', actingUserId: viewerId }).whatsapp!;
    const asEditor = buildFeatureSurfaces({ tenantId, runId: 'r-e', actingUserId: editorId }).whatsapp!;
    await expect(asViewer.send!({ connectionId: 'conn:none', to: '+15550000001', templateId: 'HX' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    // The editor passes the floor; the service refuses the unknown connection, typed.
    await expect(asEditor.send!({ connectionId: 'conn:none', to: '+15550000001', templateId: 'HX' })).rejects.toMatchObject({ details: { whatsappError: 'no_binding' } });
  });
});

describe('D3 — Meta Cloud statuses, closed vocabulary', () => {
  it('a batch with messages AND statuses yields the statuses; queued and unknown words are ignored; no recipient is read', () => {
    const body = { entry: [{ changes: [{ value: {
      messages: [{ from: '15550000002', id: 'wamid.in', text: { body: 'hi' } }],
      statuses: [
        { id: 'wamid.a', status: 'delivered', recipient_id: '15550000002' },
        { id: 'wamid.b', status: 'failed', errors: [{ code: 131026 }] },
        { id: 'wamid.c', status: 'queued' },
        { id: 'wamid.d', status: 'exploded' },
      ],
    } }] }] };
    expect(extractWaStatuses(body)).toEqual([
      { sid: 'wamid.a', status: 'delivered', errorCode: null },
      { sid: 'wamid.b', status: 'failed', errorCode: '131026' },
    ]);
    expect(extractWaStatuses({ MessageSid: 'SM1', MessageStatus: 'queued' })).toEqual([]);
    expect(extractWaStatuses({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorCode: '63016' })).toEqual([{ sid: 'SM1', status: 'undelivered', errorCode: '63016' }]);
  });

  it('a signed Meta delivery carrying a status moves the row sent on that connection', async () => {
    const T = `org:wa1053m-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'whatsapp-cloud', kind: 'bearer', secret: 'waba-token', scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-cloud', '1234567890');
    await setInboundConfig({ tenantId: T, connectionId: conn, provider: 'whatsapp-cloud', workflowId: 'wf-none', signingSecret: APP_SECRET });
    const to = '+15550303001';
    await recordConsent({ tenantId: T, subjectKey: to, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:form' });
    const surface = buildFeatureSurfaces({ tenantId: T, runId: 'r-m' }).whatsapp!;
    const sent = (await surface.send!({ connectionId: conn, to, templateId: 'order_update', languageCode: 'pt_BR' })) as { providerSid: string; deliveryStatus: string };
    expect(sent.deliveryStatus).toBe('accepted');
    // A status naming this message but arriving through ANOTHER connection is dropped
    // (asked while the row could still move, so only the connection check can refuse it).
    expect(await recordDeliveryStatus(T, 'conn:other', { sid: sent.providerSid, status: 'delivered', errorCode: null })).toBeNull();
    expect(await getDeliveryStatus(T, conn, sent.providerSid)).toMatchObject({ status: 'accepted' });
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: sent.providerSid, status: 'read', recipient_id: '15550303001' }] } }] }] });
    const res = await fetch(`${BASE}/host/openwop-app/connections-inbound/${encodeURIComponent(conn)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` },
      body: raw,
    });
    expect(res.status).toBe(202);
    expect(await getDeliveryStatus(T, conn, sent.providerSid)).toMatchObject({ status: 'read', connectionId: conn });
  });
});

describe('D3 — the status-callback URL is the one the operator pasted', () => {
  it('equals inboundIngestUrl for each configured base, and is absent with none', () => {
    const saved = { cb: process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL, pub: process.env.OPENWOP_PUBLIC_BASE_URL };
    try {
      for (const [cb, pub] of [[undefined, 'https://app.example.test'], ['https://app.example.test/api/', 'https://app.example.test'], ['https://cb.example.test', undefined]] as const) {
        if (cb === undefined) delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL; else process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = cb;
        if (pub === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = pub;
        expect(configuredInboundIngestUrl('conn:x')).toBe(inboundIngestUrl('conn:x', 'http://request-origin.invalid'));
      }
      delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
      expect(configuredInboundIngestUrl('conn:x')).toBeUndefined();
    } finally {
      if (saved.cb === undefined) delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL; else process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = saved.cb;
      if (saved.pub === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = saved.pub;
    }
  });
});

describe('D9 — health matches its sender exactly', () => {
  it('a prefix of the bound number is not the bound number', () => {
    expect(senderIdMatches('whatsapp:+15551234', '+15551234')).toBe(true);
    expect(senderIdMatches('whatsapp:+155512345', '+15551234')).toBe(false);
    expect(senderIdMatches(undefined, '+15551234')).toBe(false);
  });
});

describe('D3 — a failed delivery is announced, ids only, on both paths (grade-code WA85CD-3)', () => {
  async function cloudTenant(): Promise<{ T: string; conn: string; surface: ReturnType<typeof buildFeatureSurfaces>[string] }> {
    const T = `org:wa1053e-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'whatsapp-cloud', kind: 'bearer', secret: 'waba-token', scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-cloud', '1234567891');
    for (const to of ['+15550304001', '+15550304002']) {
      await recordConsent({ tenantId: T, subjectKey: to, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:form' });
    }
    return { T, conn, surface: buildFeatureSurfaces({ tenantId: T, runId: 'r-e' }).whatsapp! };
  }

  it('a live failed callback emits host.whatsapp.delivery.failed with no number', async () => {
    const { T, conn, surface } = await cloudTenant();
    nextMetaId = 'wamid.fail.live';
    try {
      await surface.send!({ connectionId: conn, to: '+15550304001', templateId: 'order_update' });
    } finally { nextMetaId = ''; }
    emitted.length = 0;
    expect(await recordDeliveryStatus(T, conn, { sid: 'wamid.fail.live', status: 'failed', errorCode: '131026' })).toBe('failed');
    const e = emitted.find((x) => x.type === 'host.whatsapp.delivery.failed');
    expect(e).toMatchObject({ tenantId: T, payload: { connectionId: conn, providerSid: 'wamid.fail.live', errorCode: '131026' } });
    expect(JSON.stringify(e)).not.toContain('5550304001');
  });

  it('a callback whose index read missed, while the send then finished, is still merged (grade-code WA85CD-11)', async () => {
    const { T, conn, surface } = await cloudTenant();
    nextMetaId = 'wamid.race';
    // The send runs to completion — index written, parked row checked (empty) — exactly
    // between the callback's index miss and its parked write.
    __setParkRaceHookForTest(async () => { __setParkRaceHookForTest(null); await surface.send!({ connectionId: conn, to: '+15550304002', templateId: 'race' }); });
    try {
      await recordDeliveryStatus(T, conn, { sid: 'wamid.race', status: 'delivered', errorCode: null });
    } finally { __setParkRaceHookForTest(null); nextMetaId = ''; }
    expect(await getDeliveryStatus(T, conn, 'wamid.race')).toMatchObject({ status: 'delivered' });
  });

  it("erasing the number removes its failure rows from the admin view (ADR 1053 D8)", async () => {
    const { T, conn, surface } = await cloudTenant();
    nextMetaId = 'wamid.fail.erase';
    try { await surface.send!({ connectionId: conn, to: '+15550304001', templateId: 'erase_me' }); } finally { nextMetaId = ''; }
    await recordDeliveryStatus(T, conn, { sid: 'wamid.fail.erase', status: 'failed', errorCode: '131026' });
    expect((await listDeliveryFailures(T)).map((f) => f.providerSid)).toContain('wamid.fail.erase');
    await eraseWhatsAppSubject(T, '+15550304001');
    expect((await listDeliveryFailures(T)).map((f) => f.providerSid)).not.toContain('wamid.fail.erase');
  });

  it('a later delivery removes the failure from the admin view (grade-code WA85CD-12)', async () => {
    const { T, conn, surface } = await cloudTenant();
    nextMetaId = 'wamid.fail.then.ok';
    try { await surface.send!({ connectionId: conn, to: '+15550304001', templateId: 'reminder' }); } finally { nextMetaId = ''; }
    await recordDeliveryStatus(T, conn, { sid: 'wamid.fail.then.ok', status: 'failed', errorCode: '131000' });
    expect((await listDeliveryFailures(T)).map((f) => f.providerSid)).toContain('wamid.fail.then.ok');
    expect(await recordDeliveryStatus(T, conn, { sid: 'wamid.fail.then.ok', status: 'delivered', errorCode: null })).toBe('delivered');
    expect((await listDeliveryFailures(T)).map((f) => f.providerSid)).not.toContain('wamid.fail.then.ok');
  });

  it('an early failed status, parked before the send recorded its id, is merged AND announced', async () => {
    const { T, conn, surface } = await cloudTenant();
    nextMetaId = 'wamid.fail.early';
    metaDelayMs = 200;
    emitted.length = 0;
    try {
      const pending = surface.send!({ connectionId: conn, to: '+15550304002', templateId: 'order_update' });
      await new Promise((r) => setTimeout(r, 60));
      expect(await recordDeliveryStatus(T, conn, { sid: 'wamid.fail.early', status: 'failed', errorCode: '131049' })).toBeNull(); // parked
      expect(await pending).toMatchObject({ deliveryStatus: 'failed' });
    } finally { nextMetaId = ''; metaDelayMs = 0; }
    expect(await getDeliveryStatus(T, conn, 'wamid.fail.early')).toMatchObject({ status: 'failed', errorCode: '131049' });
    expect(emitted.some((x) => x.type === 'host.whatsapp.delivery.failed' && x.payload.providerSid === 'wamid.fail.early')).toBe(true);
  });
});

describe('WA85CD-4 — a template in another language is another message', () => {
  it('order_update in en then pt_BR to one number on one day sends twice', async () => {
    const T = `org:wa1053l-${randomBytes(3).toString('hex')}`;
    const conn = (await createSecretConnection({ tenantId: T, provider: 'whatsapp-cloud', kind: 'bearer', secret: 'waba-token', scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-cloud', '1234567892');
    const to = '+15550305001';
    await recordConsent({ tenantId: T, subjectKey: to, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:form' });
    const surface = buildFeatureSurfaces({ tenantId: T, runId: 'r-l' }).whatsapp!;
    metaHits.length = 0;
    expect(await surface.send!({ connectionId: conn, to, templateId: 'order_update', languageCode: 'en' })).toMatchObject({ deduped: false });
    expect(await surface.send!({ connectionId: conn, to, templateId: 'order_update', languageCode: 'pt_BR' })).toMatchObject({ deduped: false });
    expect(await surface.send!({ connectionId: conn, to, templateId: 'order_update', languageCode: 'pt_BR' })).toMatchObject({ deduped: true });
    expect(metaHits.length).toBe(2);
    expect(metaHits[1]).toContain('"code":"pt_BR"');
  });
});

describe('D10 — the settings page reads, judged at the workspace root (grade-code WA85CD-15/-16)', () => {
  it('a sub-org admin who is a root viewer reads but cannot attest; the root admin can; reads are addressed at the root only', async () => {
    const owner = client(); const subAdmin = client();
    const ids: string[] = [];
    for (const c of [owner, subAdmin]) {
      const r = await c.post('/host/openwop-app/test/login', { email: `wa1053r-${randomBytes(3).toString('hex')}@acme.test` });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push((r.body as { user: { userId: string } }).user.userId);
    }
    const ws = (await owner.post('/host/openwop-app/workspaces', { name: 'Acme WS' })).body as { workspaceId: string };
    expect(ws.workspaceId).toMatch(/^ws:/);
    expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws.workspaceId)}/switch`)).status).toBe(200);
    const tenantId = ws.workspaceId;
    // The second person: a VIEWER at the root, an ADMIN of one sub-org.
    expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(tenantId)}/members`, { displayName: 'Sub Admin', subject: ids[1], roles: ['viewer'] })).status).toBe(201);
    const subOrg = ((await owner.post('/host/openwop-app/orgs', { name: 'Team A' })).body as { orgId?: string; org?: { orgId: string } });
    const subOrgId = subOrg.org?.orgId ?? subOrg.orgId!;
    expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(subOrgId)}/members`, { displayName: 'Sub Admin', subject: ids[1], roles: ['admin'] })).status).toBe(201);
    expect((await subAdmin.post(`/host/openwop-app/workspaces/${encodeURIComponent(tenantId)}/switch`)).status).toBe(200);

    const conn = (await createSecretConnection({ tenantId, provider: 'whatsapp-cloud', kind: 'bearer', secret: 'waba-token', scope: 'workspace' })).connectionId;
    await pairConnection(conn, 'whatsapp-cloud', '1234567893');
    await createSecretConnection({ tenantId, provider: 'twilio', kind: 'basic', secret: 'ACx:not-whatsapp-token', scope: 'workspace' }); // no WhatsApp binding: not listed
    const to = '+15550306789';
    await recordConsent({ tenantId, subjectKey: to, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:form' });
    nextMetaId = 'wamid.route.fail';
    try { await buildFeatureSurfaces({ tenantId, runId: 'r-r' }).whatsapp!.send!({ connectionId: conn, to, templateId: 'order_update' }); } finally { nextMetaId = ''; }
    await recordDeliveryStatus(tenantId, conn, { sid: 'wamid.route.fail', status: 'failed', errorCode: '131026' });

    const root = `/host/openwop-app/whatsapp/orgs/${encodeURIComponent(tenantId)}`;
    const sub = `/host/openwop-app/whatsapp/orgs/${encodeURIComponent(subOrgId)}`;
    // Addressed anywhere but the root: a 404 that names the rule, even for the sub-org's own admin.
    const wrong = await subAdmin.put(`${sub}/attestation`, { confirmNoTraining: true });
    expect(wrong.status).toBe(404);
    expect(JSON.stringify(wrong.body)).toContain('not_workspace_root');

    const list = await subAdmin.get(`${root}/connections`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ connections: [{ connectionId: conn, displayName: expect.any(String), transport: 'whatsapp-cloud', sender: '1234567893', axis: 'workspace', status: 'active', inbound: 'none' }] });
    expect((await subAdmin.get(`${root}/delivery-failures`)).status).toBe(403);
    const failed = await owner.get(`${root}/delivery-failures`);
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual({ failures: [{ connectionId: conn, providerSid: 'wamid.route.fail', status: 'failed', errorCode: '131026', kind: 'template', recipientLast4: '6789', at: expect.any(String) }] });
    expect(JSON.stringify(failed.body)).not.toContain('5550306789');

    // The tenant-wide attestation: a sub-org admin is NOT a root admin.
    expect((await subAdmin.get(`${root}/attestation`)).body).toMatchObject({ attested: false, canManage: false });
    expect((await owner.get(`${root}/attestation`)).body).toMatchObject({ attested: false, canManage: true });
    expect((await subAdmin.put(`${root}/attestation`, { confirmNoTraining: true })).status).toBe(403);
    const recorded = await owner.put(`${root}/attestation`, { confirmNoTraining: true });
    expect(recorded.status).toBe(201);
    // WA85UX-11 — the PUT answers the GET's shape: the admin who just acted can still act.
    expect(recorded.body).toMatchObject({ attested: true, canManage: true, attestedBy: ids[0], attestedByName: expect.any(String) });
    // WA85UX-12 — the name comes from THIS workspace's roster (the owner's own user row is in their home tenant).
    const members = (await owner.get(`/host/openwop-app/orgs/${encodeURIComponent(tenantId)}/members`)).body as { members: Array<{ subject?: string; displayName: string }> };
    expect((recorded.body as { attestedByName: string }).attestedByName).toBe(members.members.find((m) => m.subject === ids[0])!.displayName);
    expect((await subAdmin.delete(`${root}/attestation`)).status).toBe(403);
    // A subject who is not a member here is never named.
    await recordNoTrainAttestation(tenantId, 'user:someone-from-another-tenant');
    const stranger = (await owner.get(`${root}/attestation`)).body as Record<string, unknown>;
    expect(stranger).toMatchObject({ attested: true, attestedBy: 'user:someone-from-another-tenant' });
    expect(stranger.attestedByName).toBeUndefined();
  });
});

