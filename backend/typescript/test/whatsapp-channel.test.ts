/**
 * ADR 0394 Phase 1 — WhatsApp via the official Twilio BSP channel.
 *
 * Covers: the Twilio URL+params HMAC-SHA1 verifier (accept / tamper / missing),
 * the inbound leg (form-encoded HTTP delivery through the public route → 202 +
 * the 24h-window ledger write + MessageSid dedup), and the compliance-gated
 * send service over a mocked broker: toggle honesty, number binding, STRICT
 * explicit opt-in (umbrella `marketing:true` is NOT enough — Meta's per-number
 * rule), the 24h session window vs template discipline, fork-stable
 * idempotency (duplicate send → recorded result, ONE broker call), and the
 * SMS-adapter hardening (a `whatsapp:` recipient cannot bypass the gates).
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface BrokerCall { provider: string; url: string; body?: string }
const brokerCalls: BrokerCall[] = [];
let brokerResponder: () => { status: number; json: Record<string, unknown> };

vi.mock('../src/host/brokeredEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/brokeredEgress.js')>();
  return {
    ...actual,
    brokeredPost: vi.fn(async (_deps: unknown, opts: { provider: string; url: string | ((secret: string) => string); body?: string }) => {
      const url = typeof opts.url === 'function' ? opts.url('AC123:token') : opts.url;
      brokerCalls.push({ provider: opts.provider, url, ...(opts.body ? { body: opts.body } : {}) });
      const r = brokerResponder();
      return { outcome: 'sent', res: { status: r.status, json: async () => r.json }, provenance: { provider: opts.provider, connectionId: 'c-twilio', scope: 'tenant' } };
    }),
  };
});

const { createApp } = await import('../src/index.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { verifyTwilioSignature, verifyMetaCloudSignature, inboundSupported, setInboundConfig, handleInboundEvent } = await import('../src/features/connections/inboundWebhooks.js');
const { upsertOAuthConnection } = await import('../src/features/connections/connectionsService.js');
const { pairConnection, unpair } = await import('../src/features/connections/messagingOutbound.js');
const { recordConsent } = await import('../src/features/consent/consentService.js');
const { sendWhatsApp, recordInboundMessage, getConversation, extractWaInbound, __resetWhatsAppStores } = await import('../src/features/whatsapp/whatsappService.js');
const { makeSmsAdapter } = await import('../src/host/smsAdapter.js');
const { recordNoTrainAttestation, revokeAttestation, whatsappDispatchAllowed, applyInboundKeyword, __resetWhatsAppCompliance } = await import('../src/features/whatsapp/compliance.js');
const { getConsent } = await import('../src/features/consent/consentService.js');

const AUTH_TOKEN = 'twilio-auth-token-secret';
const TENANT = 'org:test-wa';
const RECIPIENT = '+15558675309';

let BASE: string;
let server: http.Server;
let storage: import('../src/storage/storage.js').Storage;
let hostSuite: import('../src/host/index.js').HostAdapterSuite;
let connectionId: string;

/** Twilio's documented signing: base64(HMAC-SHA1(token, url + sortedKeys.map(k => k+v))). */
function twilioSign(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', AUTH_TOKEN).update(data, 'utf8').digest('base64');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  hostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['whatsapp', 'consent']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const conn = await upsertOAuthConnection({ tenantId: TENANT, provider: 'twilio', userId: 'u1', tokens: { accessToken: 'AC123:token', tokenType: 'Bearer', scopes: ['sms.send'] } });
  connectionId = conn.connectionId;
  await setInboundConfig({ tenantId: TENANT, connectionId, provider: 'whatsapp-twilio', workflowId: 'wf-not-in-catalog', signingSecret: AUTH_TOKEN });
  await pairConnection(connectionId, 'whatsapp-twilio', `whatsapp:+15550001111`);
  // Phase 2 gate: the suite's tenant is attested by default; the gate tests
  // reset + restore this themselves.
  await recordNoTrainAttestation(TENANT, 'admin-0');
});
afterAll(async () => {
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  await new Promise<void>((res) => server.close(() => res()));
});

const DEPS = () => ({ storage, tenantId: TENANT, runId: 'wa:test', actingUserId: 'u1' });

async function optIn(subject: string): Promise<void> {
  await recordConsent({ tenantId: TENANT, subjectKey: subject, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:collection' });
}

describe('verifyTwilioSignature (URL + sorted params, HMAC-SHA1)', () => {
  const url = 'https://app.example.test/v1/host/openwop-app/connections-inbound/c1';
  const params = { MessageSid: 'SM1', From: 'whatsapp:+15558675309', Body: 'hi' };
  it('accepts a correctly-signed request; rejects tamper/missing', () => {
    const sig = twilioSign(url, params);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url, params, signatureHeader: sig }).ok).toBe(true);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url, params: { ...params, Body: 'evil' }, signatureHeader: sig }).ok).toBe(false);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url: url + '?x=1', params, signatureHeader: sig }).ok).toBe(false);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url, params, signatureHeader: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
  });
  it('inboundSupported accepts whatsapp-twilio', () => {
    expect(inboundSupported('whatsapp-twilio')).toBe(true);
  });
});

describe('inbound leg — form-encoded HTTP delivery + window ledger + dedup', () => {
  it('accepts a signed form-encoded delivery via the public route, opens the 24h window, dedups the MessageSid', async () => {
    const path = `/v1/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`;
    const url = `https://app.example.test${path}`;
    const params: Record<string, string> = { MessageSid: `SM-${Date.now()}`, From: `whatsapp:${RECIPIENT}`, To: 'whatsapp:+15550001111', Body: 'hello there' };
    const form = new URLSearchParams(params).toString();
    const send = () => fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSign(url, params) },
      body: form,
    });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(202);
    const conv = await getConversation(TENANT, connectionId, RECIPIENT);
    expect(conv).not.toBeNull(); // the 24h window opened
    const again = await send();
    expect(again.status).toBe(202);
    const body = (await again.json()) as { deduped?: boolean };
    expect(body.deduped).toBe(true); // MessageSid redelivery is a no-op
  });

  it('rejects a bad signature (401-class unauthorized outcome)', async () => {
    const outcome = await handleInboundEvent({ storage, hostSuite }, {
      connectionId,
      rawBody: 'Body=x&MessageSid=SM2',
      body: { Body: 'x', MessageSid: 'SM2' },
      headers: { twilioSignature: 'bad' },
      now: Date.now(),
      requestUrl: 'https://app.example.test/x',
    });
    expect(outcome.status).toBe('unauthorized');
  });
});

describe('sendWhatsApp — the compliance gate ladder', () => {
  it('denies without EXPLICIT whatsapp opt-in (umbrella marketing:true is NOT enough)', async () => {
    await __resetWhatsAppStores();
    brokerCalls.length = 0;
    const umbrellaOnly = '+15550009999';
    await recordConsent({ tenantId: TENANT, subjectKey: umbrellaOnly, categories: { necessary: true, analytics: false, marketing: true }, source: 'test' });
    const res = await sendWhatsApp(DEPS(), { connectionId, to: umbrellaOnly, templateId: 'HX123' });
    expect(res).toMatchObject({ sent: false, error: 'consent_denied' });
    expect(brokerCalls.length).toBe(0); // gate fires BEFORE any egress
  });

  it('session message inside the window sends; outside the window fails typed; template passes', async () => {
    await __resetWhatsAppStores();
    brokerCalls.length = 0;
    brokerResponder = () => ({ status: 201, json: { sid: 'SM-out-1', status: 'queued' } });
    await optIn(RECIPIENT);

    // No inbound yet → session message is OUTSIDE the window.
    const closed = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, body: 'free-form hello' });
    expect(closed).toMatchObject({ sent: false, error: 'outside_window' });

    // A template is allowed outside the window.
    const template = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, templateId: 'HX123', templateVariables: { '1': 'Ada' } });
    expect(template).toMatchObject({ sent: true, kind: 'template', deduped: false });
    expect(brokerCalls[0]!.body).toContain('ContentSid=HX123');

    // Open the window (verified inbound) → the session message now sends.
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${RECIPIENT}`, new Date());
    const session = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, body: 'free-form hello' });
    expect(session).toMatchObject({ sent: true, kind: 'session' });
    const sent = brokerCalls.at(-1)!;
    expect(sent.body).toContain('To=whatsapp%3A%2B15558675309');
    expect(sent.url).toContain('/Accounts/AC123/Messages.json'); // AccountSid extracted from the secret
  });

  it('a duplicate send returns the RECORDED result — one broker call (fork-stable idempotency)', async () => {
    brokerCalls.length = 0;
    brokerResponder = () => ({ status: 201, json: { sid: 'SM-out-2', status: 'queued' } });
    await optIn(RECIPIENT);
    await recordInboundMessage(TENANT, connectionId, `whatsapp:${RECIPIENT}`, new Date());
    const first = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, body: 'pay-once message' });
    expect(first).toMatchObject({ sent: true, deduped: false });
    const second = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, body: 'pay-once message' });
    expect(second).toMatchObject({ sent: true, deduped: true, providerSid: 'SM-out-2' });
    expect(brokerCalls.length).toBe(1); // never a second paid send
  });

  it('fails typed without a number binding and when the toggle is off', async () => {
    await optIn(RECIPIENT);
    await unpair(connectionId);
    try {
      const res = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, templateId: 'HX1' });
      expect(res).toMatchObject({ sent: false, error: 'no_binding' });
    } finally {
      await pairConnection(connectionId, 'whatsapp-twilio', 'whatsapp:+15550001111');
    }
    const d = getToggleDefault('whatsapp');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      const res = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, templateId: 'HX1' });
      expect(res).toMatchObject({ sent: false, error: 'feature_disabled' });
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('Phase 2 — compliance layer', () => {
  it('the dispatch gate fails CLOSED without the no-training attestation, opens with it', async () => {
    await __resetWhatsAppCompliance();
    expect(await whatsappDispatchAllowed(TENANT)).toEqual({ allow: false, reason: 'no_train_attestation_missing' });
    await recordNoTrainAttestation(TENANT, 'admin-1');
    expect(await whatsappDispatchAllowed(TENANT)).toEqual({ allow: true });
    await revokeAttestation(TENANT);
    expect((await whatsappDispatchAllowed(TENANT)).allow).toBe(false);
  });

  it('an unattested tenant ACKS a signed inbound but does NOT dispatch (ignored outcome)', async () => {
    await __resetWhatsAppCompliance();
    const outcome = await handleInboundEvent({ storage, hostSuite }, {
      connectionId,
      rawBody: '',
      body: { MessageSid: `SM-gate-${Date.now()}`, From: `whatsapp:${RECIPIENT}`, Body: 'hello' },
      headers: { twilioSignature: 'computed-below' },
      now: Date.now(),
      requestUrl: 'https://app.example.test/hook',
    });
    // Signature is wrong here so this asserts the ladder ORDER indirectly; do the
    // real assertion through the verified path:
    expect(outcome.status).toBe('unauthorized');
    const url = 'https://app.example.test/hook2';
    const params: Record<string, string> = { MessageSid: `SM-gate2-${Date.now()}`, From: `whatsapp:${RECIPIENT}`, Body: 'hello' };
    const signed = await handleInboundEvent({ storage, hostSuite }, {
      connectionId,
      rawBody: '',
      body: params,
      headers: { twilioSignature: twilioSign(url, params) },
      now: Date.now(),
      requestUrl: url,
    });
    expect(signed.status).toBe('ignored'); // verified, acked, NOT dispatched
    await recordNoTrainAttestation(TENANT, 'admin-1'); // restore for later tests
  });

  it('STOP revokes the WhatsApp consent immediately; START re-opts-in explicitly', async () => {
    await optIn(RECIPIENT);
    expect(await applyInboundKeyword(TENANT, `whatsapp:${RECIPIENT}`, 'STOP')).toBe('opt-out');
    let rec = await getConsent(TENANT, RECIPIENT);
    expect(rec?.categories['marketing.whatsapp']).toBe(false);
    // fail-closed: the send gate now denies
    const denied = await sendWhatsApp(DEPS(), { connectionId, to: RECIPIENT, templateId: 'HX1' });
    expect(denied).toMatchObject({ sent: false, error: 'consent_denied' });
    // other channel choices were preserved, not clobbered
    expect(rec?.categories.marketing).toBe(true);
    expect(await applyInboundKeyword(TENANT, `whatsapp:${RECIPIENT}`, 'start')).toBe('opt-in');
    rec = await getConsent(TENANT, RECIPIENT);
    expect(rec?.categories['marketing.whatsapp']).toBe(true);
    expect(await applyInboundKeyword(TENANT, `whatsapp:${RECIPIENT}`, 'what time do you open?')).toBeNull();
  });
});

describe('attestation routes — RBAC (host:whatsapp:manage)', () => {
  interface Res<T = unknown> { status: number; body: T }
  function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res> } {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const ck of setCookies) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    };
    return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
  }

  it('owner attests (explicit confirm required); editor 403s; reads show status', async () => {
    const tenantId = `org:test-wa-rbac-${Date.now()}`;
    const owner = client();
    expect((await owner.post('/v1/host/openwop-app/test/login', { email: `waown-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    const orgId = (org.body as { orgId: string }).orgId;
    const editor = client();
    const editorUser = ((await editor.post('/v1/host/openwop-app/test/login', { email: `waed-${Date.now()}@acme.test`, tenantId })).body as { user: { userId: string } }).user;
    expect((await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Ed', subject: editorUser.userId, roles: ['editor'] })).status).toBe(201);

    const path = `/v1/host/openwop-app/whatsapp/orgs/${encodeURIComponent(orgId)}/attestation`;
    expect((await editor.put(path, { confirmNoTraining: true })).status).toBe(403);
    expect((await owner.put(path, {})).status).toBe(400); // explicit confirm required
    expect((await owner.put(path, { confirmNoTraining: true })).status).toBe(201);
    const read = await editor.get(path);
    expect(read.status).toBe(200);
    expect((read.body as { attested: boolean }).attested).toBe(true);
  });
});

describe('Phase 4 — Meta Cloud API direct adapter', () => {
  const APP_SECRET = 'meta-app-secret';
  let cloudConnectionId: string;

  it('verifyMetaCloudSignature: sha256 over the raw body, constant-time', () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account' });
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex')}`;
    expect(verifyMetaCloudSignature({ appSecret: APP_SECRET, rawBody: raw, signatureHeader: sig }).ok).toBe(true);
    expect(verifyMetaCloudSignature({ appSecret: APP_SECRET, rawBody: raw + 'x', signatureHeader: sig }).ok).toBe(false);
    expect(verifyMetaCloudSignature({ appSecret: APP_SECRET, rawBody: raw, signatureHeader: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(inboundSupported('whatsapp-cloud')).toBe(true);
  });

  it('answers the GET hub.challenge subscription handshake (token = the stored secret)', async () => {
    const conn = await upsertOAuthConnection({ tenantId: TENANT, provider: 'whatsapp-cloud', userId: 'u1', tokens: { accessToken: 'WABA-TOKEN', tokenType: 'Bearer', scopes: ['whatsapp.send'] } });
    cloudConnectionId = conn.connectionId;
    await setInboundConfig({ tenantId: TENANT, connectionId: cloudConnectionId, provider: 'whatsapp-cloud', workflowId: 'wf-not-in-catalog', signingSecret: APP_SECRET });
    const ok = await fetch(`${BASE}/v1/host/openwop-app/connections-inbound/${encodeURIComponent(cloudConnectionId)}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(APP_SECRET)}&hub.challenge=CHALLENGE-42`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('CHALLENGE-42');
    const bad = await fetch(`${BASE}/v1/host/openwop-app/connections-inbound/${encodeURIComponent(cloudConnectionId)}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
    expect(bad.status).toBe(403);
    // a non-cloud connection answers 404 uniformly
    const twilioGet = await fetch(`${BASE}/v1/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(AUTH_TOKEN)}&hub.challenge=x`);
    expect(twilioGet.status).toBe(404);
  });

  it('a signed Cloud delivery applies the window ledger + dedups on the message id', async () => {
    const path = `/v1/host/openwop-app/connections-inbound/${encodeURIComponent(cloudConnectionId)}`;
    const cloudSender = '+15557770000';
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111222333444' }, messages: [{ from: cloudSender.slice(1), id: `wamid.${Date.now()}`, text: { body: 'hola' } }] } }] }],
    };
    const raw = JSON.stringify(payload);
    const send = () => fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw, 'utf8').digest('hex')}` },
      body: raw,
    });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(202);
    const conv = await getConversation(TENANT, cloudConnectionId, cloudSender);
    expect(conv).not.toBeNull(); // window opened from the Cloud envelope
    const again = await send();
    expect(((await again.json()) as { deduped?: boolean }).deduped).toBe(true);
  });

  it('extractWaInbound normalizes both envelopes; a Cloud BATCH yields every message (STOP as msg 2+ counts)', () => {
    expect(extractWaInbound({ From: 'whatsapp:+15551230000', Body: 'hi' })).toEqual([{ from: 'whatsapp:+15551230000', text: 'hi' }]);
    expect(extractWaInbound({ entry: [{ changes: [{ value: { statuses: [{ id: 'x' }] } }] }] })).toEqual([]);
    // GRADE-CODE pin: a batched delivery is fully processed — message 2's STOP
    // must not be dropped.
    const batch = extractWaInbound({ entry: [{ changes: [{ value: { messages: [
      { from: '15551230000', id: 'a', text: { body: 'hello' } },
      { from: '15551230000', id: 'b', text: { body: 'STOP' } },
    ] } }] }] });
    expect(batch).toEqual([
      { from: '15551230000', text: 'hello' },
      { from: '15551230000', text: 'STOP' },
    ]);
  });

  it('sends via the Cloud transport (JSON graph call, template name + language)', async () => {
    await __resetWhatsAppStores();
    brokerCalls.length = 0;
    brokerResponder = () => ({ status: 200, json: { messages: [{ id: 'wamid.out.1' }] } });
    await pairConnection(cloudConnectionId, 'whatsapp-cloud', '111222333444');
    await optIn(RECIPIENT);
    const res = await sendWhatsApp(DEPS(), { connectionId: cloudConnectionId, to: RECIPIENT, templateId: 'order_update', templateVariables: { '1': 'Ada' }, languageCode: 'pt_BR' });
    expect(res).toMatchObject({ sent: true, kind: 'template', providerSid: 'wamid.out.1' });
    const call = brokerCalls.at(-1)!;
    expect(call.provider).toBe('whatsapp-cloud');
    expect(call.url).toContain('/111222333444/messages');
    const body = JSON.parse(call.body!) as { type: string; template: { name: string; language: { code: string } } };
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('order_update');
    expect(body.template.language.code).toBe('pt_BR');
  });
});

describe('tenant isolation — the pairing store is not a cross-tenant reach', () => {
  it('another tenant cannot send through this tenant’s bound connection (IDOR pin)', async () => {
    brokerCalls.length = 0;
    const res = await sendWhatsApp(
      { storage, tenantId: 'org:some-other-tenant', runId: 'wa:intruder', actingUserId: 'intruder' },
      { connectionId, to: RECIPIENT, templateId: 'HX1' },
    );
    // The feature toggle resolves per-tenant first; either gate is fail-closed —
    // the intruder must never reach the pairing or the broker.
    expect(res.sent).toBe(false);
    expect(['feature_disabled', 'no_binding']).toContain((res as { error: string }).error);
    expect(brokerCalls.length).toBe(0);
  });
});

describe('SMS-adapter hardening — no WhatsApp bypass', () => {
  it('rejects a whatsapp:-prefixed recipient with a typed error and NO egress', async () => {
    brokerCalls.length = 0;
    const sms = makeSmsAdapter(DEPS());
    const res = await sms.sendSms({ to: `whatsapp:${RECIPIENT}`, from: '+15550001111', text: 'sneaky' });
    expect(res).toMatchObject({ sent: false, error: 'sms_whatsapp_not_allowed' });
    expect(brokerCalls.length).toBe(0);
  });
});
