/**
 * ADR 0952 P5 — TikTok and LinkedIn delivery-status and budget writers (and the
 * budget readers), against a local fixture server. No real platform, no token.
 *
 * Pins:
 *  - Every writer/reader is `unsupported` until sandbox-verified.
 *  - TikTok works at the CAMPAIGN level: `operation_status` ENABLE | DISABLE via
 *    /campaign/status/update/, the daily budget (BUDGET_MODE_DAY, major units of
 *    the advertiser currency) via /campaign/get/ and /campaign/update/.
 *  - LinkedIn: our dispatch puts the campaign GROUP in the campaignId slot. Pause
 *    = the group; launch = the group AND each campaign in it (dispatch left the
 *    campaign PAUSED). The daily budget lives on the group's ONE campaign; several
 *    campaigns have no single budget and are refused with no write. Every update
 *    is a Rest.li PARTIAL_UPDATE.
 *  - Budgets convert through the account currency (JPY 0, KWD 3 decimals).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { answerCurrencyRead, fixtureCurrency } from './adsCurrencyFixture.js';

vi.mock('../src/host/hostEventDispatcher.js', async (orig) => ({ ...(await orig<typeof import('../src/host/hostEventDispatcher.js')>()), emitHostEvent: async () => {} }));

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter, setAdsCapChecker, type SetDeliveryStatusArgs } from '../src/host/adsAdapter.js';
import { getApproval, resolveApproval } from '../src/host/approvalService.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';

const T = 'p5-t';
let srv: http.Server;
let storage: Storage;
interface Hit { method: string; path: string; body: Record<string, unknown>; restli?: string }
let hits: Hit[] = [];
const tt: Record<string, { operation_status: string; budget?: number; budget_mode?: string }> = {};
const liGroups: Record<string, string> = {};
const liCampaigns: Record<string, Array<{ id: number; status: string; dailyBudget?: { amount: string; currencyCode: string } }>> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await __resetConnectionsStore();
  srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (answerCurrencyRead(req.url ?? '', raw, res)) return;
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (req.method === 'POST') hits.push({ method: 'POST', path: url.pathname, body, restli: req.headers['x-restli-method'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      // ── TikTok
      if (url.pathname === '/tiktok/campaign/get/') {
        const id = (JSON.parse(url.searchParams.get('filtering') ?? '{}') as { campaign_ids?: string[] }).campaign_ids?.[0] ?? '';
        res.end(JSON.stringify({ code: 0, message: 'OK', data: { list: tt[id] ? [{ campaign_id: id, ...tt[id] }] : [] } })); return;
      }
      if (url.pathname === '/tiktok/campaign/status/update/') {
        for (const id of body.campaign_ids as string[]) tt[id] = { ...tt[id]!, operation_status: String(body.operation_status) };
        res.end(JSON.stringify({ code: 0, message: 'OK', data: {} })); return;
      }
      if (url.pathname === '/tiktok/campaign/update/') {
        const id = String(body.campaign_id);
        tt[id] = { ...tt[id]!, budget: Number(body.budget) };
        res.end(JSON.stringify({ code: 0, message: 'OK', data: {} })); return;
      }
      // ── LinkedIn
      const group = /^\/li\/rest\/adAccounts\/\d+\/adCampaignGroups\/(\d+)$/.exec(url.pathname);
      if (group) {
        if (req.method === 'POST') { liGroups[group[1]!] = String(((body.patch as { $set: { status: string } }).$set).status); res.statusCode = 204; res.end(); return; }
        res.end(JSON.stringify({ id: Number(group[1]), status: liGroups[group[1]!] })); return;
      }
      if (/^\/li\/rest\/adAccounts\/\d+\/adCampaigns$/.test(url.pathname)) {
        const gid = /sponsoredCampaignGroup:(\d+)/.exec(decodeURIComponent(url.search))?.[1] ?? '';
        res.end(JSON.stringify({ elements: liCampaigns[gid] ?? [] })); return;
      }
      const camp = /^\/li\/rest\/adAccounts\/\d+\/adCampaigns\/(\d+)$/.exec(url.pathname);
      if (camp && req.method === 'POST') {
        const set = (body.patch as { $set: Record<string, unknown> }).$set;
        for (const list of Object.values(liCampaigns)) for (const c of list) if (String(c.id) === camp[1]) Object.assign(c, set);
        res.statusCode = 204; res.end(); return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.OPENWOP_TIKTOK_ADS_API_BASE = `${base}/tiktok`;
  process.env.OPENWOP_LINKEDIN_ADS_API_BASE = `${base}/li`;
  for (const id of ['tiktok-ads', 'linkedin-ads']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: T, provider: id, kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
  }
  await storage.insertRun({ runId: 'p5-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  for (const k of ['OPENWOP_TIKTOK_ADS_API_BASE', 'OPENWOP_LINKEDIN_ADS_API_BASE', 'OPENWOP_ADS_VERIFIED_STATUS_WRITERS', 'OPENWOP_ADS_VERIFIED_BUDGET_WRITERS', 'OPENWOP_ADS_VERIFIED_READERS']) delete process.env[k];
  fixtureCurrency.value = 'USD';
  await new Promise<void>((r) => srv.close(() => r()));
});
const verify = (): void => {
  process.env.OPENWOP_ADS_VERIFIED_STATUS_WRITERS = 'tiktok,linkedin';
  process.env.OPENWOP_ADS_VERIFIED_BUDGET_WRITERS = 'tiktok,linkedin';
  process.env.OPENWOP_ADS_VERIFIED_READERS = 'tiktok,linkedin';
};
beforeEach(() => { hits = []; fixtureCurrency.value = 'USD'; verify(); });

const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'p5-run', actingUserId: 'u1', orgId: T });
const st = (platform: 'tiktok' | 'linkedin', campaignId: string, status: 'paused' | 'active'): SetDeliveryStatusArgs =>
  ({ platform, adAccountId: platform === 'tiktok' ? '7001' : '5091', campaignId, status, reason: { kind: 'operator' } });
async function launch(a: SetDeliveryStatusArgs) {
  const first = await adapter().setDeliveryStatus(a);
  if (first.outcome !== 'requires_approval') return first;
  await resolveApproval(first.approvalId, { status: 'approved' });
  return adapter().setDeliveryStatus(a);
}

describe('ADR 0952 P5 — unverified ⇒ unsupported', () => {
  it('status, budget write and budget read all refuse until sandbox-verified, with no call', async () => {
    for (const k of ['OPENWOP_ADS_VERIFIED_STATUS_WRITERS', 'OPENWOP_ADS_VERIFIED_BUDGET_WRITERS', 'OPENWOP_ADS_VERIFIED_READERS']) delete process.env[k];
    expect(await adapter().setDeliveryStatus(st('tiktok', '11', 'paused'))).toEqual({ outcome: 'unsupported', platform: 'tiktok', reason: 'not_sandbox_verified' });
    expect((await adapter().updateBudget({ platform: 'linkedin', adAccountId: '5091', campaignId: '21', dailyBudgetMinor: 5000 })).outcome).toBe('unsupported');
    expect((await adapter().getCampaignBudget({ platform: 'tiktok', adAccountId: '7001', campaignId: '11' })).outcome).toBe('unsupported');
    expect(hits).toHaveLength(0);
  });
});

describe('ADR 0952 P5 — TikTok (campaign level)', () => {
  it('pause writes DISABLE, is idempotent, and a launch writes ENABLE after approval', async () => {
    tt['11'] = { operation_status: 'ENABLE', budget: 50, budget_mode: 'BUDGET_MODE_DAY' };
    expect(await adapter().setDeliveryStatus(st('tiktok', '11', 'paused'))).toMatchObject({ outcome: 'updated', status: 'paused' });
    expect(hits[0]).toMatchObject({ path: '/tiktok/campaign/status/update/', body: { advertiser_id: '7001', campaign_ids: ['11'], operation_status: 'DISABLE' } });
    expect((await adapter().setDeliveryStatus(st('tiktok', '11', 'paused'))).outcome).toBe('unchanged');
    expect(await launch(st('tiktok', '11', 'active'))).toMatchObject({ outcome: 'updated', status: 'active' });
    expect(tt['11']?.operation_status).toBe('ENABLE');
  });

  it('budget reads and writes in the advertiser currency (JPY 0 decimals, KWD 3); no daily budget is a typed failure', async () => {
    tt['12'] = { operation_status: 'DISABLE', budget: 50.5, budget_mode: 'BUDGET_MODE_DAY' };
    expect(await adapter().getCampaignBudget({ platform: 'tiktok', adAccountId: '7001', campaignId: '12' })).toEqual({ outcome: 'ok', platform: 'tiktok', dailyBudgetMinor: 5050 });
    fixtureCurrency.value = 'JPY';
    expect((await adapter().updateBudget({ platform: 'tiktok', adAccountId: '7001', campaignId: '12', dailyBudgetMinor: 5000 })).outcome).toBe('updated');
    expect(hits.at(-1)?.body).toEqual({ advertiser_id: '7001', campaign_id: '12', budget: 5000 });
    fixtureCurrency.value = 'KWD';
    await adapter().updateBudget({ platform: 'tiktok', adAccountId: '7001', campaignId: '12', dailyBudgetMinor: 5000 });
    expect(hits.at(-1)?.body).toMatchObject({ budget: 5 });
    tt['13'] = { operation_status: 'DISABLE', budget_mode: 'BUDGET_MODE_INFINITE' };
    expect(await adapter().getCampaignBudget({ platform: 'tiktok', adAccountId: '7001', campaignId: '13' })).toEqual({ outcome: 'failed', error: 'no_daily_budget' });
  });
});

describe('ADR 0952 P5 — LinkedIn (campaign group level)', () => {
  it('pause patches the GROUP; a launch patches the group AND its paused campaign, each as a Rest.li PARTIAL_UPDATE', async () => {
    liGroups['21'] = 'ACTIVE';
    liCampaigns['21'] = [{ id: 2101, status: 'ACTIVE', dailyBudget: { amount: '75.00', currencyCode: 'USD' } }];
    expect((await adapter().setDeliveryStatus(st('linkedin', '21', 'paused'))).outcome).toBe('updated');
    expect(hits).toEqual([{ method: 'POST', path: '/li/rest/adAccounts/5091/adCampaignGroups/21', body: { patch: { $set: { status: 'PAUSED' } } }, restli: 'PARTIAL_UPDATE' }]);
    // Dispatch shape: group DRAFT, campaign PAUSED.
    liGroups['22'] = 'DRAFT';
    liCampaigns['22'] = [{ id: 2201, status: 'PAUSED' }];
    hits = [];
    expect((await launch(st('linkedin', '22', 'active'))).outcome).toBe('updated');
    expect(hits.map((h) => [h.path, (h.body.patch as { $set: { status: string } }).$set.status])).toEqual([
      ['/li/rest/adAccounts/5091/adCampaignGroups/22', 'ACTIVE'],
      ['/li/rest/adAccounts/5091/adCampaigns/2201', 'ACTIVE'],
    ]);
  });

  it('the daily budget lives on the group\'s ONE campaign; several campaigns are refused with no write', async () => {
    liCampaigns['23'] = [{ id: 2301, status: 'PAUSED', dailyBudget: { amount: '75.00', currencyCode: 'USD' } }];
    expect(await adapter().getCampaignBudget({ platform: 'linkedin', adAccountId: '5091', campaignId: '23' })).toEqual({ outcome: 'ok', platform: 'linkedin', dailyBudgetMinor: 7500 });
    expect(await adapter().updateBudget({ platform: 'linkedin', adAccountId: '5091', campaignId: '23', dailyBudgetMinor: 8000 })).toMatchObject({ outcome: 'updated', target: '2301' });
    expect(hits.at(-1)).toMatchObject({ path: '/li/rest/adAccounts/5091/adCampaigns/2301', body: { patch: { $set: { dailyBudget: { amount: '80.00', currencyCode: 'USD' } } } }, restli: 'PARTIAL_UPDATE' });
    liCampaigns['24'] = [{ id: 2401, status: 'PAUSED', dailyBudget: { amount: '1.00', currencyCode: 'USD' } }, { id: 2402, status: 'PAUSED', dailyBudget: { amount: '2.00', currencyCode: 'USD' } }];
    hits = [];
    expect(await adapter().updateBudget({ platform: 'linkedin', adAccountId: '5091', campaignId: '24', dailyBudgetMinor: 8000 })).toEqual({ outcome: 'failed', error: 'budget_split_across_campaigns' });
    expect(hits).toHaveLength(0);
  });
});

// ── ADR 0952 P0/P1 fences on the new writers (2026-10-25 integration) ──────────
// The TikTok/LinkedIn launches reuse the ONE setDeliveryStatus path, so they
// inherit main's launch claim and its current-snapshot cap check. These pin that
// they do, rather than trusting the shared code path.
async function approve(a: SetDeliveryStatusArgs): Promise<string> {
  const first = await adapter().setDeliveryStatus(a);
  if (first.outcome !== 'requires_approval') throw new Error(`expected an approval, got ${first.outcome}`);
  const row = await getApproval(first.approvalId);
  if (!row?.spendIdemKey) throw new Error('launch approval has no spend key');
  await resolveApproval(first.approvalId, { status: 'approved' });
  return `hostext:ads:spend-approval:${row.spendIdemKey}`;
}

describe('ADR 0952 P5 × P0/P1 — TikTok and LinkedIn launches are fenced', () => {
  it.each(['tiktok', 'linkedin'] as const)('%s: a cap without a current snapshot refuses the launch before any write', async (platform) => {
    const id = platform === 'tiktok' ? '9101' : '9201';
    if (platform === 'tiktok') tt[id] = { operation_status: 'DISABLE' }; else { liGroups[id] = 'PAUSED'; liCampaigns[id] = [{ id: 92011, status: 'PAUSED' }]; }
    // A stale or never-read cap is `cap_unenforceable` from checkLaunchAgainstCaps
    // (pinned in campaign-intel-spend-caps.test.ts); the adapter must honour it.
    setAdsCapChecker(async () => ({ verdict: 'cap_unenforceable', capId: 'cap-stale' }));
    try {
      expect(await launch(st(platform, id, 'active'))).toEqual({ outcome: 'refused', error: 'cap_unenforceable', capId: 'cap-stale' });
      expect(hits).toEqual([]);
    } finally { setAdsCapChecker(null); }
  });

  it.each(['tiktok', 'linkedin'] as const)('%s: the launch claim is taken BEFORE the vendor call (a lost claim writes nothing)', async (platform) => {
    const id = platform === 'tiktok' ? '9102' : '9202';
    if (platform === 'tiktok') tt[id] = { operation_status: 'DISABLE' }; else { liGroups[id] = 'PAUSED'; liCampaigns[id] = [{ id: 92021, status: 'PAUSED' }]; }
    const a = st(platform, id, 'active');
    const mapKey = await approve(a);
    hits = [];
    const original = storage.kvCompareAndSwap.bind(storage);
    const cas = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === mapKey && next.includes('"state":"claimed"')) return { swapped: false, actual: expected }; // another caller won the claim
      return original(key, expected, next);
    });
    try {
      expect(await adapter().setDeliveryStatus(a)).toEqual({ outcome: 'refused', error: 'launch_approval_changed' });
      expect(hits).toEqual([]);
    } finally { cas.mockRestore(); }
    // With the claim free, the same approval launches once and is marked completed.
    expect(await adapter().setDeliveryStatus(a)).toMatchObject({ outcome: 'updated', status: 'active' });
    expect(JSON.parse((await storage.kvGet(mapKey))!)).toMatchObject({ launchClaim: { state: 'completed' } });
  });

  it('linkedin: a launch that fails part-way (group active, campaign write rejected) stays claimed; a retry is launch_outcome_unknown', async () => {
    liGroups['9203'] = 'PAUSED';
    liCampaigns['9203'] = [{ id: 92031, status: 'PAUSED' }];
    const a = st('linkedin', '9203', 'active');
    const mapKey = await approve(a);
    // The group PATCH lands; the campaign PATCH is rejected by the platform.
    const send = srv.listeners('request')[0] as (req: http.IncomingMessage, res: http.ServerResponse) => void;
    srv.removeAllListeners('request');
    srv.on('request', (req, res) => {
      if (req.method === 'POST' && /adCampaigns\/92031$/.test(req.url ?? '')) { req.resume(); res.statusCode = 422; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: 'rejected' })); return; }
      send(req, res);
    });
    try {
      expect(await adapter().setDeliveryStatus(a)).toEqual({ outcome: 'failed', error: 'rejected' });
    } finally { srv.removeAllListeners('request'); srv.on('request', send); }
    expect(liGroups['9203']).toBe('ACTIVE');
    expect(JSON.parse((await storage.kvGet(mapKey))!)).toMatchObject({ launchClaim: { state: 'claimed' } });
    liGroups['9203'] = 'PAUSED';
    hits = [];
    expect(await adapter().setDeliveryStatus(a)).toEqual({ outcome: 'refused', error: 'launch_outcome_unknown' });
    expect(hits).toEqual([]);
  });

  it.each(['tiktok', 'linkedin'] as const)('%s: an invalid runtime status refuses, and the literal builders throw rather than ENABLE/ACTIVE', async (platform) => {
    const { tiktokStatusLiteral, linkedinStatusLiteral } = await import('../src/host/adsWire.js');
    const invalid = 'ACTIVE' as unknown as 'active';
    expect(await adapter().setDeliveryStatus({ ...st(platform, '9104', 'paused'), status: invalid })).toEqual({ outcome: 'failed', error: 'invalid_status' });
    expect(() => (platform === 'tiktok' ? tiktokStatusLiteral : linkedinStatusLiteral)(invalid)).toThrow('invalid_delivery_status');
    expect(hits).toEqual([]);
  });
});
