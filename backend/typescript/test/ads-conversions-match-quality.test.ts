/**
 * ADR 0907 P3 — Google Ads click-conversion uploads (D5) and match quality (D6),
 * against a local fixture server. No real ad platform, no real token.
 *
 * Pins:
 *  - Google: `customers/<cid>:uploadClickConversions` with a conversion action
 *    RESOURCE NAME (never an event name), the click id, hashed identifiers,
 *    `yyyy-mm-dd hh:mm:ss+00:00`, `orderId` = eventId, consent signals,
 *    `partialFailure:true`; a partial-failure or empty result is a FAILURE;
 *    no action / no click id or identifier / no developer token fail closed.
 *  - Meta + TikTok bodies carry IP, user agent, fbc/fbp/ttclid, hashed phone.
 *  - Intake: phone hashed in E.164 (both forms), national numbers refused, fbc
 *    built from the CLICK time and never from "now", IP + UA from the request.
 *  - Delivery: a platform that cannot take a row is not a target (no wedge);
 *    IP + UA are dropped once every target has the row; a workspace read of the
 *    queue never shows them.
 *  - The Google sender is gated until sandbox-verified (D2).
 *
 * Sabotage that turns it red: send the event name as conversionAction; treat a
 * partialFailureError as sent; build fbc from Date.now(); keep IP after full
 * delivery; read the IP from the body; drop the applies() filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { buildMetaConversionBody, buildTiktokConversionBody, googleConversionDateTime } from '../src/host/adsWire.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import {
  relayConversion, listConversions, upsertPixel, hashEmail, hashPhone, buildFbc, __resetPixels,
} from '../src/features/campaign-connectors/pixelService.js';
import { deliverQueuedConversions } from '../src/features/campaign-connectors/conversionDelivery.js';

interface Hit { path: string; auth?: string; dev?: string; body: Record<string, unknown> }
const T = 'mq-t';
const ORG = 'mq-org';
const ACTION = 'customers/1234567890/conversionActions/987';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

let srv: http.Server;
let storage: Storage;
let BASE: string;
let hits: Hit[] = [];
let googleReply: Record<string, unknown> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV_TOKEN';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { const s = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(s.address() as AddressInfo).port}`; r(); }); });
  const d = getToggleDefault('campaign-connectors');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await __resetConnectionsStore();
  srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', auth: req.headers.authorization, dev: req.headers['developer-token'] as string, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify((req.url ?? '').startsWith('/google') ? googleReply : { events_received: 1 }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `${base}/google`;
  process.env.OPENWOP_META_API_BASE = `${base}/meta`;
  for (const id of ['google-ads', 'meta-ads']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
  }
  await createSecretConnection({ tenantId: T, provider: 'google-ads', kind: 'bearer', secret: 'GOOG', scope: 'user', userId: 'u1' });
  await createSecretConnection({ tenantId: T, provider: 'meta-ads', kind: 'bearer', secret: 'META', scope: 'user', userId: 'u1' });
  await storage.insertRun({ runId: 'mq-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});

afterAll(async () => {
  for (const k of ['OPENWOP_GOOGLE_ADS_API_BASE', 'OPENWOP_META_API_BASE', 'OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN', 'OPENWOP_ADS_VERIFIED_SENDERS']) delete process.env[k];
  await new Promise<void>((r) => srv.close(() => r()));
});

beforeEach(async () => {
  hits = [];
  googleReply = { results: [{ gclid: 'G1', conversionAction: ACTION, conversionDateTime: '2026-10-01 12:00:00+00:00' }] };
  process.env.OPENWOP_ADS_VERIFIED_SENDERS = 'google';
  await __resetPixels();
});

const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'mq-run', actingUserId: 'u1', orgId: ORG });
const google = { customerId: '123-456-7890', conversionAction: ACTION };
const sendGoogle = (over: Record<string, unknown> = {}) => adapter().sendConversion({
  platform: 'google', pixelId: 'AW-1', eventId: 'evt-g1', eventName: 'purchase', eventTimeIso: '2026-10-01T12:00:00.000Z',
  gclid: 'G1', emailHash: hashEmail('a@x.test'), value: 49.5, currency: 'USD', google,
  consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' }, ...over,
});

describe('ADR 0907 D5 — Google uploadClickConversions', () => {
  it('posts the documented body: action RESOURCE NAME, click id, identifiers, UTC datetime, orderId, consent, partialFailure', async () => {
    expect(await sendGoogle({ phoneHashE164: sha('+15551234567') })).toEqual({ outcome: 'sent' });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/google/customers/1234567890:uploadClickConversions');
    expect(hits[0].auth).toBe('Bearer GOOG');
    expect(hits[0].dev).toBe('DEV_TOKEN');
    expect(hits[0].body).toEqual({
      conversions: [{
        conversionAction: ACTION,
        conversionDateTime: '2026-10-01 12:00:00+00:00',
        orderId: 'evt-g1',
        gclid: 'G1',
        conversionValue: 49.5, currencyCode: 'USD',
        userIdentifiers: [{ hashedEmail: hashEmail('a@x.test') }, { hashedPhoneNumber: sha('+15551234567') }],
        consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' },
      }],
      partialFailure: true,
    });
  });

  it('a partialFailureError or an empty result row is a FAILURE, never a delivery', async () => {
    googleReply = { partialFailureError: { message: 'Conversion action not found' }, results: [{}] };
    expect(await sendGoogle()).toEqual({ outcome: 'failed', error: 'Conversion action not found' });
    googleReply = { results: [{}] };
    expect(await sendGoogle()).toEqual({ outcome: 'failed', error: 'conversion_not_accepted' });
  });

  it('fails closed before any call without an action resource, a click id or identifier, or the developer token', async () => {
    expect(await sendGoogle({ google: { customerId: '1234567890', conversionAction: 'purchase' } })).toEqual({ outcome: 'failed', error: 'no_conversion_action' });
    expect(await sendGoogle({ gclid: undefined, emailHash: undefined })).toEqual({ outcome: 'failed', error: 'no_click_id_or_identifier' });
    delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
    try { expect(await sendGoogle()).toEqual({ outcome: 'failed', error: 'no_developer_token' }); }
    finally { process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV_TOKEN'; }
    expect(hits).toHaveLength(0);
  });

  it('stays gated until sandbox-verified (ADR 0907 D2)', async () => {
    delete process.env.OPENWOP_ADS_VERIFIED_SENDERS;
    expect(await sendGoogle()).toEqual({ outcome: 'unsupported', platform: 'google', reason: 'not_sandbox_verified' });
    expect(hits).toHaveLength(0);
  });

  it('formats conversionDateTime as yyyy-mm-dd hh:mm:ss+00:00', () => {
    expect(googleConversionDateTime('2026-03-05T07:08:09.123Z')).toBe('2026-03-05 07:08:09+00:00');
  });
});

describe('ADR 0907 D6 — match-quality signals', () => {
  const base = { pixelId: 'P', eventId: 'e', eventName: 'Purchase', eventTimeIso: '2026-10-01T00:00:00.000Z' };
  it('Meta carries IP, user agent, fbc, fbp, hashed phone and the page URL', () => {
    const body = buildMetaConversionBody({ ...base, ip: '203.0.113.9', userAgent: 'UA/1', fbc: 'fb.1.1790000000000.ABC', fbp: 'fb.1.1790000000000.42', phoneHash: 'ph', pageUrl: 'https://shop.test/thanks' });
    const evt = (body.data as Array<Record<string, unknown>>)[0]!;
    expect(evt.event_source_url).toBe('https://shop.test/thanks');
    expect(evt.user_data).toEqual({ ph: ['ph'], client_ip_address: '203.0.113.9', client_user_agent: 'UA/1', fbc: 'fb.1.1790000000000.ABC', fbp: 'fb.1.1790000000000.42' });
  });
  it('TikTok carries IP, user agent, ttclid, hashed phone and the page', () => {
    const body = buildTiktokConversionBody({ ...base, ip: '203.0.113.9', userAgent: 'UA/1', ttclid: 'TT1', phoneHash: 'ph', pageUrl: 'https://shop.test/thanks' });
    const evt = (body.data as Array<Record<string, unknown>>)[0]!;
    expect(evt.user).toEqual({ phone: ['ph'], ip: '203.0.113.9', user_agent: 'UA/1', ttclid: 'TT1' });
    expect(evt.page).toEqual({ url: 'https://shop.test/thanks' });
  });

  it('phones hash in E.164 both ways; a national number is refused rather than guessed', () => {
    expect(hashPhone('+1 (555) 123-4567')).toEqual({ phoneHash: sha('15551234567'), phoneHashE164: sha('+15551234567') });
    expect(hashPhone('0044 20 7946 0958')).toEqual({ phoneHash: sha('442079460958'), phoneHashE164: sha('+442079460958') });
    expect(hashPhone('555-123-4567')).toBeUndefined();
    expect(hashPhone('+12')).toBeUndefined();
  });

  it('fbc comes from the CLICK time, a well-formed _fbc, or nothing — never from now', () => {
    const now = Date.parse('2026-10-17T00:00:00Z');
    const clickAt = now - 3 * 86_400_000;
    expect(buildFbc({ fbclid: 'ABC', fbclidAt: clickAt }, now)).toBe(`fb.1.${clickAt}.ABC`);
    expect(buildFbc({ fbc: 'fb.1.1790000000000.XYZ' }, now)).toBe('fb.1.1790000000000.XYZ');
    expect(buildFbc({ fbclid: 'ABC' }, now)).toBeUndefined(); // no click time: refuse, do not invent one
    expect(buildFbc({ fbclid: 'ABC', fbclidAt: now + 1000 }, now)).toBeUndefined();
    expect(buildFbc({ fbclid: 'ABC', fbclidAt: now - 91 * 86_400_000 }, now)).toBeUndefined();
  });
});

describe('ADR 0907 D5/D6 — delivery', () => {
  it('a Google pixel with no action for the event is not a target: the row completes on Meta and its IP + UA are dropped', async () => {
    // google is enabled (beforeEach) and mapped for `purchase` only — not for `lead`.
    await upsertPixel(T, ORG, { platform: 'meta', pixelId: 'PX-M' });
    await upsertPixel(T, ORG, { platform: 'google', pixelId: 'AW-1', googleCustomerId: '1234567890', conversionActions: { purchase: ACTION } });
    await relayConversion(T, ORG, { eventId: 'lead-1', eventName: 'lead', email: 'l@x.test', gclid: 'G9', ip: '203.0.113.9', userAgent: 'UA/1', visitor: 'vk-l' });
    await relayConversion(T, ORG, { eventId: 'buy-1', eventName: 'purchase', email: 'b@x.test', gclid: 'G8', ip: '203.0.113.8', userAgent: 'UA/2', visitor: 'vk-b' });
    expect((await deliverQueuedConversions(adapter(), T, ORG)).sent).toBe(2);
    const rows = await listConversions(T, ORG);
    expect(rows.every((r) => r.status === 'sent' && r.ip === undefined && r.userAgent === undefined)).toBe(true);
    expect(rows.find((r) => r.eventId === 'lead-1')?.sentTo).toEqual(['meta']);
    expect(new Set(rows.find((r) => r.eventId === 'buy-1')?.sentTo)).toEqual(new Set(['meta', 'google']));
    const googleHit = hits.find((h) => h.path.startsWith('/google'))!;
    expect((googleHit.body.conversions as Array<{ orderId: string }>)[0]!.orderId).toBe('buy-1');
  });

  it('a row that is not fully delivered keeps its IP + UA for the retry', async () => {
    await upsertPixel(T, ORG, { platform: 'google', pixelId: 'AW-1', googleCustomerId: '1234567890', conversionActions: { purchase: ACTION } });
    googleReply = { partialFailureError: { message: 'nope' } };
    await relayConversion(T, ORG, { eventId: 'buy-2', eventName: 'purchase', gclid: 'G7', ip: '203.0.113.7', userAgent: 'UA/3', visitor: 'vk-b2' });
    expect((await deliverQueuedConversions(adapter(), T, ORG)).sent).toBe(0);
    expect((await listConversions(T, ORG))[0]).toMatchObject({ status: 'queued', ip: '203.0.113.7', userAgent: 'UA/3' });
  });

  it('pixel config validates the Google customer and the action map', async () => {
    await expect(upsertPixel(T, ORG, { platform: 'google', pixelId: 'AW-1', googleCustomerId: '12' })).rejects.toThrow(/10-digit/);
    await expect(upsertPixel(T, ORG, { platform: 'google', pixelId: 'AW-1', conversionActions: { purchase: 'purchase' } })).rejects.toThrow(/conversionActions/);
  });
});

describe('ADR 0907 D6 — the public intake and the workspace read', () => {
  function client() {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m?.[1]) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    return { call };
  }

  it('records the request IP + UA (never a body-supplied ip), hashes the phone, and the workspace list hides IP + UA', async () => {
    const c = client();
    const login = await c.call('POST', '/host/openwop-app/test/login', { email: `mq-${Date.now()}@acme.test` });
    expect(login.status).toBe(201);
    const tenantId = (login.body.user as { tenantId: string }).tenantId;
    const orgId = (await c.call('POST', '/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
    // The consent toggle is off in this app, so a vk-carrying visitor is consented (the D1 test's premise).
    const r = await c.call('POST', `/host/openwop-app/public/${orgId}/conversions`,
      { vk: 'vk-mq', eventId: 'pub-1', eventName: 'purchase', phone: '+1 555 123 4567', gclid: 'GC1', ip: '6.6.6.6' },
      { 'user-agent': 'TestUA/9' });
    expect(r.body).toMatchObject({ recorded: true });
    const stored = (await listConversions(tenantId, orgId)).find((x) => x.eventId === 'pub-1')!;
    expect(stored.ip).not.toBe('6.6.6.6');
    expect(stored.ip).toBeTruthy();
    expect(stored.userAgent).toBe('TestUA/9');
    expect(stored.phoneHash).toBe(sha('15551234567'));
    expect(JSON.stringify(stored)).not.toContain('555 123');
    const list = await c.call('GET', `/host/openwop-app/campaign-connectors/orgs/${orgId}/conversions`);
    const row = (list.body.conversions as Array<Record<string, unknown>>).find((x) => x.eventId === 'pub-1')!;
    expect(row).not.toHaveProperty('ip');
    expect(row).not.toHaveProperty('userAgent');
    expect(row.gclid).toBe('GC1');
  });
});
