/**
 * ADR 1053 — WhatsApp: one paid send per message, the bound credential, delivery
 * truth, and replay-proof inbound. Feature-loop row 85.
 *
 * Witnessed end to end through the REAL broker (no brokeredEgress mock): a local
 * stub plays Twilio, records every POST with its Authorization header, and can be
 * told to answer slowly or with a 5xx. Inbound rides the public route with real
 * Twilio signatures. Nothing reaches a real provider.
 *
 * Red on unmodified main (779bc6193) before the fix: concurrent duplicate → 2 POSTs;
 * pinned credential → the actor's own row's secret; another member's user row → sent;
 * replayed START after STOP → re-opted in; user-row START → opted in; erasure → the
 * dispatch row survived; 5xx then retry → 2 POSTs; delivery status → no reader;
 * languageCode → dropped by the node.
 *
 * Sabotage-witnessed 2026-11-03 (each red here, restored): claim → plain put; 5xx →
 * release; the credential pin removed; the inbound claim ignored; START allowed on a
 * user row; erasure back on the id-prefix scan; the monotonic rank → equality; the
 * Twilio status observers skipped; the parked-status merge removed; the node's
 * languageCode dropped; the stale-pending check; the inbound stale-claim takeover;
 * ECONNREFUSED dropped from the connect-phase codes; the window's monotonic check.
 */
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setInboundConfig } from '../src/features/connections/inboundWebhooks.js';
import { pairConnection } from '../src/features/connections/messagingOutbound.js';
import { getConsent, recordConsent } from '../src/features/consent/consentService.js';
import { sendWhatsApp, recordInboundMessage, eraseWhatsAppSubject, getConversation, getDeliveryStatus, claimInboundMessage, __resetWhatsAppStores } from '../src/features/whatsapp/whatsappService.js';
import { recordNoTrainAttestation } from '../src/features/whatsapp/compliance.js';
import { buildWhatsAppSurface } from '../src/features/whatsapp/surface.js';

const T = `org:wa1053-${randomBytes(3).toString('hex')}`;
const TOKEN_W = 'workspace-auth-token-0123456789';
const TOKEN_U1 = 'user1-auth-token-0123456789abcd';
const SENDER_W = '+15550101001';
const SENDER_U1 = '+15550101002';

let BASE = '';
let storage: Storage;
let server: http.Server;
let twilio: http.Server;
interface Hit { auth: string; body: string }
const hits: Hit[] = [];
let answer: (n: number) => { status: number; json: Record<string, unknown>; delayMs?: number; reset?: boolean } = (n) => ({ status: 201, json: { sid: `SM${n}`, status: 'queued' } });

let wsConn = '';   // workspace row, bound to SENDER_W, inbound whatsapp-twilio
let u1Conn = '';   // u1's own row, bound to SENDER_U1, inbound whatsapp-twilio

const setToggle = async (id: string): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };
const basicOf = (secret: string): string => `Basic ${Buffer.from(secret).toString('base64')}`;

function twilioSign(token: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}
async function postInbound(connectionId: string, token: string, params: Record<string, string>): Promise<Response> {
  const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`;
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSign(token, `https://app.example.test${path}`, params) },
    body: new URLSearchParams(params).toString(),
  });
}
const optIn = (to: string) => recordConsent({ tenantId: T, subjectKey: to, categories: { necessary: true, analytics: false, marketing: true, 'marketing.whatsapp': true }, source: 'test:form' });
const deps = (actingUserId?: string) => ({ storage, tenantId: T, runId: 'run-1053', ...(actingUserId ? { actingUserId } : {}) });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  twilio = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ auth: String(req.headers.authorization ?? ''), body: raw });
      const a = answer(hits.length);
      if (a.reset) { req.socket.destroy(); return; }
      setTimeout(() => { res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(a.json)); }, a.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => twilio.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_TWILIO_API_BASE = `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`;
  for (const id of ['whatsapp', 'consent']) await setToggle(id);
  wsConn = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: `ACW:${TOKEN_W}`, scope: 'workspace' })).connectionId;
  u1Conn = (await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: `ACU1:${TOKEN_U1}`, scope: 'user', userId: 'u1' })).connectionId;
  await pairConnection(wsConn, 'whatsapp-twilio', SENDER_W);
  await pairConnection(u1Conn, 'whatsapp-twilio', SENDER_U1);
  await setInboundConfig({ tenantId: T, connectionId: wsConn, provider: 'whatsapp-twilio', workflowId: 'wf-none', signingSecret: TOKEN_W });
  await setInboundConfig({ tenantId: T, connectionId: u1Conn, provider: 'whatsapp-twilio', workflowId: 'wf-none', signingSecret: TOKEN_U1 });
  await recordNoTrainAttestation(T, 'admin-0');
}, 120_000);
beforeEach(async () => {
  hits.length = 0;
  answer = (n) => ({ status: 201, json: { sid: `SM${n}-${randomBytes(2).toString('hex')}`, status: 'queued' } });
  await __resetWhatsAppStores();
});
afterAll(async () => {
  delete process.env.OPENWOP_TWILIO_API_BASE;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  await new Promise<void>((r) => twilio.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

describe('D1 — one paid send per message', () => {
  it('two concurrent identical sends reach the BSP once; the loser is a typed in-flight failure, never "sent"', async () => {
    const to = '+15550201001';
    await optIn(to);
    answer = (n) => ({ status: 201, json: { sid: `SMc${n}`, status: 'queued' }, delayMs: 150 });
    const [a, b] = await Promise.all([
      sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXrace' }),
      sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXrace' }),
    ]);
    expect(hits.length).toBe(1);
    const results = [a, b];
    expect(results.filter((r) => r.sent).length).toBe(1);
    expect(results.find((r) => !r.sent)).toMatchObject({ sent: false, error: 'send_in_flight' });
    // After it lands, a retry is the recorded result.
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXrace' })).toMatchObject({ sent: true, deduped: true });
    expect(hits.length).toBe(1);
  });

  it('a 5xx is ambiguous: the claim is kept as unknown and a retry does NOT send again', async () => {
    const to = '+15550201002';
    await optIn(to);
    answer = () => ({ status: 503, json: { message: 'upstream' } });
    const first = await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HX5xx' });
    expect(first).toMatchObject({ sent: false, error: 'wa_request_failed', detail: { outcomeUnknown: true } });
    answer = (n) => ({ status: 201, json: { sid: `SMr${n}`, status: 'queued' } });
    const retry = await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HX5xx' });
    expect(retry).toMatchObject({ sent: false, error: 'send_outcome_unknown' });
    expect(hits.length).toBe(1);
  });

  it('a 4xx is a definite refusal: the claim is released and a retry may send', async () => {
    const to = '+15550201003';
    await optIn(to);
    answer = () => ({ status: 400, json: { message: 'bad template', code: 63016 } });
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HX4xx' })).toMatchObject({ sent: false, error: 'wa_rejected' });
    answer = (n) => ({ status: 201, json: { sid: `SMok${n}`, status: 'queued' } });
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HX4xx' })).toMatchObject({ sent: true, deduped: false });
    expect(hits.length).toBe(2);
  });
});

describe('D2 — the credential is the bound connection’s', () => {
  it('a send through the workspace row carries the workspace secret even when the actor has their own twilio row', async () => {
    const to = '+15550202001';
    await optIn(to);
    expect(await sendWhatsApp(deps('u1'), { connectionId: wsConn, to, templateId: 'HXpin' })).toMatchObject({ sent: true });
    expect(hits.length).toBe(1);
    expect(hits[0]!.auth).toBe(basicOf(`ACW:${TOKEN_W}`));
    expect(hits[0]!.body).toContain(encodeURIComponent(`whatsapp:${SENDER_W}`));
  });

  it("another member cannot send through u1's personal row (its sender, anyone's credential)", async () => {
    const to = '+15550202002';
    await optIn(to);
    expect(await sendWhatsApp(deps('u2'), { connectionId: u1Conn, to, templateId: 'HXforeign' })).toMatchObject({ sent: false, error: 'wa_not_connected' });
    expect(await sendWhatsApp(deps(), { connectionId: u1Conn, to, templateId: 'HXforeign' })).toMatchObject({ sent: false, error: 'wa_not_connected' });
    expect(hits.length).toBe(0);
  });
});

describe('D4 / D4a — inbound side effects are replay-proof and START needs an admin-configured row', () => {
  it('a replayed signed START after a STOP does not re-opt the number in', async () => {
    const from = '+15550203001';
    await optIn(from);
    const start = { MessageSid: `SMstart-${randomBytes(3).toString('hex')}`, From: `whatsapp:${from}`, To: `whatsapp:${SENDER_W}`, Body: 'START' };
    expect((await postInbound(wsConn, TOKEN_W, start)).status).toBe(202);
    const stop = { MessageSid: `SMstop-${randomBytes(3).toString('hex')}`, From: `whatsapp:${from}`, To: `whatsapp:${SENDER_W}`, Body: 'STOP' };
    expect((await postInbound(wsConn, TOKEN_W, stop)).status).toBe(202);
    expect((await getConsent(T, from))?.categories['marketing.whatsapp']).toBe(false);
    // The captured START, byte for byte, plus a benign param so the body hash differs.
    expect((await postInbound(wsConn, TOKEN_W, { ...start, NumMedia: '0' })).status).toBe(202);
    expect((await getConsent(T, from))?.categories['marketing.whatsapp']).toBe(false);
  });

  it('a START through a personal (user-axis) row is not applied; a STOP through it is', async () => {
    const from = '+15550203002';
    const start = { MessageSid: `SMu-${randomBytes(3).toString('hex')}`, From: `whatsapp:${from}`, To: `whatsapp:${SENDER_U1}`, Body: 'START' };
    expect((await postInbound(u1Conn, TOKEN_U1, start)).status).toBe(202);
    expect((await getConsent(T, from))?.categories['marketing.whatsapp']).not.toBe(true);
    await optIn(from);
    const stop = { MessageSid: `SMu2-${randomBytes(3).toString('hex')}`, From: `whatsapp:${from}`, To: `whatsapp:${SENDER_U1}`, Body: 'STOP' };
    expect((await postInbound(u1Conn, TOKEN_U1, stop)).status).toBe(202);
    expect((await getConsent(T, from))?.categories['marketing.whatsapp']).toBe(false);
  });
});

describe('D8 — erasure reaches the dispatch ledger', () => {
  it('erasing a number removes its dispatch rows, so a same-day re-send is not answered from a ledger that still holds it', async () => {
    const to = '+15550204001';
    await optIn(to);
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXerase' })).toMatchObject({ sent: true, deduped: false });
    await eraseWhatsAppSubject(T, to);
    await optIn(to); // a fresh opt-in after the erasure
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXerase' })).toMatchObject({ sent: true, deduped: false });
    expect(hits.length).toBe(2);
  });
});

describe('D3 — delivery truth comes only from a verified callback on the sending connection', () => {
  it('accepted on send; delivered after the signed Twilio callback; a callback on another connection moves nothing', async () => {
    const to = '+15550205001';
    await optIn(to);
    answer = () => ({ status: 201, json: { sid: 'SMdeliv1', status: 'queued' } });
    const sent = await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXdeliv' });
    expect(sent).toMatchObject({ sent: true, deliveryStatus: 'accepted' });
    // The send asked Twilio for callbacks on the connection's own ingest URL.
    // ...the exact URL the route reconstructs and verifies (publicBase + path), so the callback below is signed over it.
    expect(new URLSearchParams(hits[0]!.body).get('StatusCallback')).toBe(`https://app.example.test/host/openwop-app/connections-inbound/${encodeURIComponent(wsConn)}`);
    const surface = buildWhatsAppSurface({ tenantId: T });
    expect(await surface.deliveryStatus!({ connectionId: wsConn, providerSid: 'SMdeliv1' })).toMatchObject({ status: 'accepted' });
    // A signed status callback for the same sid, but on u1's connection: dropped.
    expect((await postInbound(u1Conn, TOKEN_U1, { MessageSid: 'SMdeliv1', MessageStatus: 'failed', ErrorCode: '30008', From: `whatsapp:${SENDER_U1}`, To: `whatsapp:${to}` })).status).toBe(202);
    expect(await surface.deliveryStatus!({ connectionId: wsConn, providerSid: 'SMdeliv1' })).toMatchObject({ status: 'accepted' });
    expect((await postInbound(wsConn, TOKEN_W, { MessageSid: 'SMdeliv1', MessageStatus: 'delivered', From: `whatsapp:${SENDER_W}`, To: `whatsapp:${to}` })).status).toBe(202);
    expect(await surface.deliveryStatus!({ connectionId: wsConn, providerSid: 'SMdeliv1' })).toMatchObject({ status: 'delivered' });
    // Monotonic: a late (or replayed) "failed" cannot undo a delivery.
    await postInbound(wsConn, TOKEN_W, { MessageSid: 'SMdeliv1', MessageStatus: 'failed', ErrorCode: '30008', From: `whatsapp:${SENDER_W}`, To: `whatsapp:${to}` });
    expect(await surface.deliveryStatus!({ connectionId: wsConn, providerSid: 'SMdeliv1' })).toMatchObject({ status: 'delivered' });
  });

  it('a callback that lands before the send records its row is parked, then merged', async () => {
    const to = '+15550205002';
    await optIn(to);
    answer = () => ({ status: 201, json: { sid: 'SMearly1', status: 'queued' }, delayMs: 200 });
    const pending = sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXearly' });
    await new Promise((r) => setTimeout(r, 60));
    await postInbound(wsConn, TOKEN_W, { MessageSid: 'SMearly1', MessageStatus: 'sent', From: `whatsapp:${SENDER_W}`, To: `whatsapp:${to}` });
    expect(await pending).toMatchObject({ sent: true });
    expect(await buildWhatsAppSurface({ tenantId: T }).deliveryStatus!({ connectionId: wsConn, providerSid: 'SMearly1' })).toMatchObject({ status: 'sent' });
  });

  it('an unknown id is a typed not_found, never a fabricated status', async () => {
    await expect(buildWhatsAppSurface({ tenantId: T }).deliveryStatus!({ connectionId: wsConn, providerSid: 'SMnever' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('WA85WF-1 — the node forwards languageCode', () => {
  it('passes languageCode to the surface', async () => {
    const pack = (await import(new URL('../../../packs/feature.whatsapp.nodes/index.mjs', import.meta.url).href)) as { send: (ctx: unknown) => Promise<unknown> };
    let seen: Record<string, unknown> = {};
    await pack.send({ inputs: { connectionId: 'c', to: '+15550000000', templateId: 'order_update', languageCode: 'pt_BR' }, features: { whatsapp: { send: async (a: Record<string, unknown>) => { seen = a; return { sent: true, providerSid: 'x', kind: 'template', deduped: false }; } } } });
    expect(seen.languageCode).toBe('pt_BR');
  });
});

describe('window bookkeeping', () => {
  it('a recorded inbound keeps the window open (sanity for the replay case)', async () => {
    const from = '+15550206001';
    await recordInboundMessage(T, wsConn, `whatsapp:${from}`, new Date());
    await optIn(from);
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to: from, body: 'hello' })).toMatchObject({ sent: true, kind: 'session' });
  });
});

describe('D1 — the rest of the claim state machine (grade-code WA85CD-5)', () => {
  it('a connection reset after the request was written is ambiguous: unknown, and not re-sent', async () => {
    const to = '+15550207001';
    await optIn(to);
    answer = () => ({ status: 201, json: {}, reset: true });
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXreset' })).toMatchObject({ sent: false, error: 'wa_request_failed', detail: { outcomeUnknown: true } });
    answer = (n) => ({ status: 201, json: { sid: `SMx${n}`, status: 'queued' } });
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXreset' })).toMatchObject({ sent: false, error: 'send_outcome_unknown' });
    expect(hits.length).toBe(1);
  });

  it('a refused dial reached nobody: the claim is released and a retry sends', async () => {
    const to = '+15550207002';
    await optIn(to);
    const live = process.env.OPENWOP_TWILIO_API_BASE;
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    process.env.OPENWOP_TWILIO_API_BASE = `http://127.0.0.1:${port}`;
    try {
      const first = await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXrefused' });
      expect(first).toMatchObject({ sent: false, error: 'wa_request_failed' });
      expect((first as { detail?: { outcomeUnknown?: boolean } }).detail?.outcomeUnknown).toBeUndefined();
    } finally {
      process.env.OPENWOP_TWILIO_API_BASE = live;
    }
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXrefused' })).toMatchObject({ sent: true, deduped: false });
    expect(hits.length).toBe(1);
  });

  it('a guard-denied host reached nobody: the claim is released and a retry sends (grade-code WA85CD-14)', async () => {
    const to = '+15550207005';
    await optIn(to);
    const live = process.env.OPENWOP_TWILIO_API_BASE;
    const allowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    process.env.OPENWOP_TWILIO_API_BASE = 'https://169.254.169.254';
    let refused: unknown;
    try {
      refused = await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXdenied' }).catch((err: unknown) => err);
    } finally {
      process.env.OPENWOP_TWILIO_API_BASE = live;
      if (allowPrivate !== undefined) process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = allowPrivate;
    }
    // Refused before any byte left: never "unknown". MEASURED: this literal is refused by the
    // tenant egress firewall before the dial (the send rethrows after releasing). The
    // dispatcher's own connect-time refusal (a NAME that resolves private) is not witnessed
    // here — it needs DNS; removing its codes from CONNECT_PHASE_CODES leaves this green.
    expect((refused as { detail?: { outcomeUnknown?: boolean } } | null)?.detail?.outcomeUnknown).toBeUndefined();
    expect((refused as { sent?: boolean })?.sent).not.toBe(true);
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXdenied' })).toMatchObject({ sent: true, deduped: false });
    expect(hits.length).toBe(1);
  });

  it('a pending claim older than ten minutes is reported unknown, never re-sent', async () => {
    const to = '+15550207003';
    await optIn(to);
    answer = (n) => ({ status: 201, json: { sid: `SMslow${n}`, status: 'queued' }, delayMs: 250 });
    const first = sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXstale' });
    await new Promise((r) => setTimeout(r, 60));
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11 * 60 * 1000);
    try {
      expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXstale' })).toMatchObject({ sent: false, error: 'send_outcome_unknown' });
    } finally {
      spy.mockRestore();
    }
    expect(await first).toMatchObject({ sent: true });
    expect(hits.length).toBe(1);
  });

  it('an erasure during a send is not undone when the send lands (architect M5)', async () => {
    const to = '+15550207004';
    await optIn(to);
    answer = () => ({ status: 201, json: { sid: 'SMerased1', status: 'queued' }, delayMs: 200 });
    const pending = sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXm5' });
    await new Promise((r) => setTimeout(r, 60));
    await eraseWhatsAppSubject(T, to);
    expect(await pending).toMatchObject({ sent: true });
    expect(await getDeliveryStatus(T, wsConn, 'SMerased1')).toBeNull();
  });
});

describe('D6 — the window never moves backwards', () => {
  it('an older inbound after a newer one leaves lastInboundAt at the newer time', async () => {
    const from = '+15550208001';
    const newer = new Date(Date.now() - 60_000);
    await recordInboundMessage(T, wsConn, `whatsapp:${from}`, newer);
    await recordInboundMessage(T, wsConn, `whatsapp:${from}`, new Date(Date.now() - 20 * 60 * 60 * 1000));
    expect((await getConversation(T, wsConn, from))?.lastInboundAt).toBe(newer.toISOString());
  });
});

describe('D4 — a claim left pending by a crash is taken over (grade-code WA85CD-1)', () => {
  it('a fresh pending claim blocks; a stale one is taken over; a done one never is', async () => {
    const id = `SMcrash-${randomBytes(3).toString('hex')}`;
    expect((await claimInboundMessage(T, wsConn, id)).owned).toBe(true); // the process "dies" here: never completed
    expect((await claimInboundMessage(T, wsConn, id)).owned).toBe(false);
    const realNow = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 3 * 60 * 1000);
    try {
      const takeover = await claimInboundMessage(T, wsConn, id);
      expect(takeover.owned).toBe(true);
      await takeover.complete();
    } finally {
      spy.mockRestore();
    }
    const later = vi.spyOn(Date, 'now').mockReturnValue(realNow + 60 * 60 * 1000);
    try {
      expect((await claimInboundMessage(T, wsConn, id)).owned).toBe(false);
    } finally {
      later.mockRestore();
    }
  });
});

describe('ADR 1053 D3/D4 correction — provider message ids are never stored raw in the keyed stores', () => {
  it('the sid index, parked statuses and inbound claims hold no raw provider id, in key or value', async () => {
    const to = '+15550209001';
    await optIn(to);
    answer = () => ({ status: 201, json: { sid: 'SMrawcheck1', status: 'queued' } });
    expect(await sendWhatsApp(deps(), { connectionId: wsConn, to, templateId: 'HXraw' })).toMatchObject({ sent: true });
    // A status for a message this connection never sent is parked; an inbound message is claimed.
    expect((await postInbound(wsConn, TOKEN_W, { MessageSid: 'SMrawcheck2', MessageStatus: 'delivered', From: `whatsapp:${SENDER_W}`, To: `whatsapp:${to}` })).status).toBe(202);
    expect((await postInbound(wsConn, TOKEN_W, { MessageSid: 'SMrawcheck3', From: `whatsapp:${to}`, To: `whatsapp:${SENDER_W}`, Body: 'hello' })).status).toBe(202);
    const rows = [
      ...(await storage.kvList('hostext:whatsapp:dispatch-sid:')),
      ...(await storage.kvList('hostext:whatsapp:status-parked:')),
      ...(await storage.kvList('hostext:whatsapp:inbound-seen:')),
    ];
    expect(rows.length).toBeGreaterThanOrEqual(3); // one of each was written
    const blob = JSON.stringify(rows);
    for (const sid of ['SMrawcheck1', 'SMrawcheck2', 'SMrawcheck3']) expect(blob).not.toContain(sid);
    // ...and the hashed keys still resolve: the sent message's status reads back.
    expect(await getDeliveryStatus(T, wsConn, 'SMrawcheck1')).toMatchObject({ status: 'accepted' });
  });
});
