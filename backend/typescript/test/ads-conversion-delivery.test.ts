/**
 * ADR 0907 D7 — scheduled conversion delivery: consent re-checked at SEND, the
 * health read model, and the chain through the REAL executor including both
 * fork modes.
 *
 * Pins:
 *  - withdrawn consent between intake and send ⇒ the row is DROPPED and
 *    nothing is sent; an erased visitor (tombstone) likewise;
 *  - a row with no visitor key, or an unreadable consent, is HELD (not sent,
 *    not lost);
 *  - a failed send records the platform's last error (health card), cleared on
 *    success; health counts per platform and says when the read was capped;
 *  - `campaign-sync.conversions-dispatch` runs to `completed` and sends;
 *    a `mode:'replay'` fork sends NOTHING (the side-effect node is served its
 *    recorded outcome); a `mode:'branch'` fork re-runs and sends only rows
 *    still queued.
 *
 * Sabotage that turns it red: send on `false` consent; treat a missing visitor
 * as consented; drop the `side-effect` role from the node (the replay fork
 * re-sends); stop skipping already-delivered platforms (the branch fork
 * double-fires).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { recordConsent, writeErasureTombstone } from '../src/features/consent/consentService.js';
import { relayConversion, listConversions, upsertPixel, __resetPixels } from '../src/features/campaign-connectors/pixelService.js';
import { deliverQueuedConversions, conversionHealth, SCHEDULED_CONVERSIONS_TOGGLE } from '../src/features/campaign-connectors/conversionDelivery.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-connectors.nodes/index.mjs';

let BASE: string;
let server: http.Server;
let meta: http.Server;
let storage: Storage;
let metaHits: Array<{ path: string; eventIds: string[] }> = [];
let metaStatus = 200;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('campaign-connectors');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await __resetConnectionsStore();
  meta = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { data?: Array<{ event_id: string }> }) : {};
      metaHits.push({ path: req.url ?? '', eventIds: (body.data ?? []).map((e) => e.event_id) });
      res.writeHead(metaStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metaStatus === 200 ? { events_received: 1 } : { error: { message: 'pixel rejected' } }));
    });
  });
  await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
  registerProvider({ id: 'meta-ads', label: 'Meta Ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
});

afterAll(async () => {
  delete process.env.OPENWOP_META_API_BASE;
  await new Promise<void>((r) => meta.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => { metaHits = []; metaStatus = 200; await __resetPixels(); });

describe('ADR 0907 D7 — consent re-checked at send', () => {
  const T = 'cd-t';
  const ORG = 'cd-org';
  beforeAll(async () => {
    await createSecretConnection({ tenantId: T, provider: 'meta-ads', kind: 'bearer', secret: 'META', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'cd-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });
  const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'cd-run', actingUserId: 'u1', orgId: ORG });

  it('withdrawn consent DROPS the row and sends nothing; an erased visitor too; a consented row is sent', async () => {
    const consent = getToggleDefault('consent');
    if (consent) await saveConfig({ ...consent, status: 'on' }, 'test');
    try {
      await upsertPixel(T, ORG, { platform: 'meta', pixelId: 'PX' });
      await recordConsent({ tenantId: T, subjectKey: 'vk-yes', categories: { marketing: true }, source: 'test' });
      await recordConsent({ tenantId: T, subjectKey: 'vk-later-no', categories: { marketing: true }, source: 'test' });
      await relayConversion(T, ORG, { eventId: 'ok-1', eventName: 'purchase', visitor: 'vk-yes' });
      await relayConversion(T, ORG, { eventId: 'withdrawn-1', eventName: 'purchase', visitor: 'vk-later-no' });
      await relayConversion(T, ORG, { eventId: 'erased-1', eventName: 'purchase', visitor: 'vk-erased' });
      // Between intake and the hourly run: one visitor withdraws, one is erased.
      await recordConsent({ tenantId: T, subjectKey: 'vk-later-no', categories: { marketing: false }, source: 'test' });
      await writeErasureTombstone(T, 'vk-erased');

      expect(await deliverQueuedConversions(adapter(), T, ORG)).toEqual({ sent: 1, dropped: 2, held: 0, expired: 0 });
      expect(metaHits.flatMap((h) => h.eventIds)).toEqual(['ok-1']);
      expect((await listConversions(T, ORG)).map((r) => r.eventId)).toEqual(['ok-1']);
    } finally {
      if (consent) await saveConfig({ ...consent, status: 'off' }, 'test');
    }
  });

  it('a row with no visitor key to check is HELD — never sent unverified, never lost', async () => {
    await upsertPixel(T, ORG, { platform: 'meta', pixelId: 'PX' });
    await relayConversion(T, ORG, { eventId: 'novk-1', eventName: 'purchase' });
    expect(await deliverQueuedConversions(adapter(), T, ORG)).toEqual({ sent: 0, dropped: 0, held: 1, expired: 0 });
    expect(metaHits).toHaveLength(0);
    expect((await listConversions(T, ORG))[0]).toMatchObject({ eventId: 'novk-1', status: 'queued' });
  });

  it('a failed send records the last error per platform (health), cleared once it succeeds', async () => {
    await upsertPixel(T, ORG, { platform: 'meta', pixelId: 'PX' });
    await upsertPixel(T, ORG, { platform: 'tiktok', pixelId: 'TT' }); // configured, not live (D2)
    await relayConversion(T, ORG, { eventId: 'err-1', eventName: 'purchase', visitor: 'vk-any' });
    metaStatus = 400;
    expect(await deliverQueuedConversions(adapter(), T, ORG)).toEqual({ sent: 0, dropped: 0, held: 0, expired: 0 });
    let h = await conversionHealth(T, ORG);
    expect(h).toMatchObject({ queued: 1, sent: 0, capped: false });
    const m = h.platforms.find((p) => p.platform === 'meta')!;
    expect(m).toMatchObject({ configured: true, live: true, delivered: 0, pending: 1 });
    expect(m.lastError?.error).toBe('pixel rejected');
    expect(h.platforms.find((p) => p.platform === 'tiktok')).toMatchObject({ configured: true, live: false });
    expect(h.platforms.find((p) => p.platform === 'google')).toMatchObject({ configured: false });

    metaStatus = 200;
    expect((await deliverQueuedConversions(adapter(), T, ORG)).sent).toBe(1);
    h = await conversionHealth(T, ORG);
    expect(h.platforms.find((p) => p.platform === 'meta')).toMatchObject({ delivered: 1, pending: 0 });
    expect(h.platforms.find((p) => p.platform === 'meta')?.lastError).toBeUndefined();
  });
});

// ── The chain, through the real executor, and both fork modes ────────────────

interface Body { runId?: string; orgId?: string; status?: string; user?: { userId: string; tenantId: string }; events?: Array<{ type?: string; nodeId?: string; payload?: Record<string, unknown> }> }
interface Res { status: number; body: Body }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
type Client = ReturnType<typeof client>;
async function settle(c: Client, runId: string): Promise<string> {
  let status = 'pending';
  for (let i = 0; i < 120; i++) {
    status = (await c.get(`/runs/${runId}`)).body.status ?? 'pending';
    if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return status;
}
async function deliverOutputs(c: Client, runId: string): Promise<Record<string, unknown>> {
  const events = (await c.get(`/runs/${runId}/debug-bundle`)).body.events ?? [];
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_deliver'));
  return (ev?.payload?.outputs as Record<string, unknown>) ?? {};
}

describe('campaign-sync.conversions-dispatch — real executor + forks (ADR 0907 D7)', () => {
  it('delivers; a replay fork sends nothing; a branch fork sends only rows still queued', async () => {
    const tenantId = `org:convchain-${Date.now()}`;
    const owner = client();
    const login = await owner.post('/host/openwop-app/test/login', { email: `convchain-${Date.now()}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const userId = login.body.user!.userId;
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId!;
    await createSecretConnection({ tenantId, provider: 'meta-ads', kind: 'bearer', secret: 'META', scope: 'user', userId });
    await upsertPixel(tenantId, orgId, { platform: 'meta', pixelId: 'PX' });
    await relayConversion(tenantId, orgId, { eventId: 'chain-1', eventName: 'purchase', visitor: 'vk-1' });

    const found = getChain('campaign-sync.conversions-dispatch');
    expect(found, 'the chain must load at boot').toBeTruthy();
    const expanded = expandChain(found!.chain, { params: { orgId } });
    registerWorkflow(expanded);

    // Lead amendment (a) — OFF by default: the run completes as an honest
    // no-op and sends nothing, however much is queued.
    const off = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: { orgId } });
    expect(off.status).toBe(201);
    expect(await settle(owner, off.body.runId!)).toBe('completed');
    expect(await deliverOutputs(owner, off.body.runId!)).toEqual({ outcome: 'disabled', sent: 0, dropped: 0, held: 0, expired: 0 });
    expect(metaHits).toHaveLength(0);
    expect((await listConversions(tenantId, orgId))[0]?.status).toBe('queued');

    const sub = getToggleDefault(SCHEDULED_CONVERSIONS_TOGGLE)!;
    expect(sub.status).toBe('off');
    await saveConfig({ ...sub, status: 'on' }, 'test');
    const run = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: { orgId } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const src = run.body.runId!;
    expect(await settle(owner, src)).toBe('completed');
    expect(await deliverOutputs(owner, src)).toEqual({ outcome: 'delivered', sent: 1, dropped: 0, held: 0, expired: 0 });
    expect(metaHits.flatMap((h) => h.eventIds)).toEqual(['chain-1']);

    // REPLAY fork: the side-effect node is served its recorded outcome — no send.
    const replay = await owner.post(`/runs/${src}:fork`, { mode: 'replay', fromSeq: 0 });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(await settle(owner, replay.body.runId!)).toBe('completed');
    expect(await deliverOutputs(owner, replay.body.runId!)).toEqual({ outcome: 'delivered', sent: 1, dropped: 0, held: 0, expired: 0 });
    expect(metaHits.flatMap((h) => h.eventIds)).toEqual(['chain-1']); // still exactly one send

    // BRANCH fork: runs live, and only what is still queued goes out.
    await relayConversion(tenantId, orgId, { eventId: 'chain-2', eventName: 'purchase', visitor: 'vk-2' });
    const branch = await owner.post(`/runs/${src}:fork`, { mode: 'branch', fromSeq: 0 });
    expect(branch.status, JSON.stringify(branch.body)).toBe(201);
    expect(await settle(owner, branch.body.runId!)).toBe('completed');
    expect(metaHits.flatMap((h) => h.eventIds)).toEqual(['chain-1', 'chain-2']); // chain-1 NOT re-sent
    await saveConfig({ ...sub, status: 'off' }, 'test');
  });
});

describe('lead amendment — no backlog flush, no double send (ADR 0907 D7)', () => {
  const T = 'cd-window-t';
  const ORG = 'cd-window-org';
  beforeAll(async () => {
    await createSecretConnection({ tenantId: T, provider: 'meta-ads', kind: 'bearer', secret: 'META', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'cdw-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });
  const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'cdw-run', actingUserId: 'u1', orgId: ORG });
  const relayAt = async (iso: string, eventId: string): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    try { await relayConversion(T, ORG, { eventId, eventName: 'purchase', visitor: `vk-${eventId}`, ip: '203.0.113.1', userAgent: 'UA' }); }
    finally { vi.useRealTimers(); }
  };

  it('(b) an event older than Meta\'s 7-day window is marked expired with a typed reason and never sent', async () => {
    await upsertPixel(T, ORG, { platform: 'meta', pixelId: 'PX' });
    await relayAt(new Date(Date.now() - 8 * 86_400_000).toISOString(), 'old-1');
    await relayAt(new Date(Date.now() - 2 * 86_400_000).toISOString(), 'fresh-1');
    expect(await deliverQueuedConversions(adapter(), T, ORG)).toEqual({ sent: 1, dropped: 0, held: 0, expired: 1 });
    expect(metaHits.flatMap((h) => h.eventIds)).toEqual(['fresh-1']);
    const old = (await listConversions(T, ORG)).find((r) => r.eventId === 'old-1')!;
    expect(old).toMatchObject({ status: 'expired', expiredFor: ['meta'], expiredReason: 'outside_platform_window', sentTo: [] });
    expect(old.ip).toBeUndefined(); // terminal: the IP/UA go too
    // Terminal: a later run does not pick it up again.
    metaHits = [];
    expect(await deliverQueuedConversions(adapter(), T, ORG)).toEqual({ sent: 0, dropped: 0, held: 0, expired: 0 });
    expect(metaHits).toHaveLength(0);
    expect((await conversionHealth(T, ORG)).expired).toBe(1);
  });

  it('(c) what the manual ADR 0297 path already delivered is never re-sent when scheduled delivery runs; a re-posted eventId is one row', async () => {
    await upsertPixel(T, ORG, { platform: 'meta', pixelId: 'PX' });
    await relayConversion(T, ORG, { eventId: 'dup-1', eventName: 'purchase', visitor: 'vk-d' });
    // The manual route's path delivers it…
    expect((await deliverQueuedConversions(adapter(), T, ORG)).sent).toBe(1);
    // …the same eventId is posted again by the site (a retried beacon)…
    const again = await relayConversion(T, ORG, { eventId: 'dup-1', eventName: 'purchase', visitor: 'vk-d' });
    expect(again.deduped).toBe(true);
    // …and the scheduled run that follows sends nothing.
    expect((await deliverQueuedConversions(adapter(), T, ORG)).sent).toBe(0);
    expect(metaHits.flatMap((h) => h.eventIds)).toEqual(['dup-1']);
    expect((await listConversions(T, ORG)).filter((r) => r.eventId === 'dup-1')).toHaveLength(1);
  });
});

describe('GET …/conversions/health — workspace:read (ADR 0907 D7)', () => {
  it('a member reads it; a same-tenant non-member and a signed-out caller cannot', async () => {
    const tenantId = `org:convhealth-${Date.now()}`; // not a personal `user:` tenant (implicit-owner short-circuit)
    const owner = client();
    expect((await owner.post('/host/openwop-app/test/login', { email: `ch-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId!;
    const path = `/host/openwop-app/campaign-connectors/orgs/${orgId}/conversions/health`;
    const ok = await owner.get(path);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ queued: 0, sent: 0, capped: false });

    const peer = client();
    expect((await peer.post('/host/openwop-app/test/login', { email: `ch-peer-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    expect((await peer.get(path)).status).toBe(403);
    expect((await client().get(path)).status).toBeGreaterThanOrEqual(401);
  });
});

describe('a param-less copy of the chain fails CLOSED (seeded-chain ceiling reason, ADR 0907 P5)', () => {
  it('dispatch-conversions with no orgId is a typed validation_error and never reaches the host', async () => {
    let called = 0;
    const features = { 'campaign-connectors': { importCsv: async () => ({}), deliverConversions: async () => { called++; return { outcome: 'delivered', sent: 0, dropped: 0, held: 0, expired: 0 }; } } };
    const out = await nodePack['feature.campaign-connectors.nodes.dispatch-conversions']({ features, inputs: {} });
    expect(out).toEqual({ status: 'failed', error: { code: 'validation_error', message: 'orgId is required.' } });
    expect(called).toBe(0);
  });
});
