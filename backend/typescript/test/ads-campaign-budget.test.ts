/**
 * ADR 0952 P3 — the adapter halves of a reallocation, against a local fixture
 * server (no real ad platform, no real token):
 *  - `getCampaignBudget` reads Meta's CBO `daily_budget` (minor units) and
 *    Google's campaign budget `amountMicros` (÷10⁴, mirroring the writer's ×10⁴).
 *    A Meta campaign without a campaign budget (ABO) is a typed failure.
 *  - `authorizeBudgetOps` lets ONE approved plan approval cover its ops: an op
 *    above the policy threshold that would ask for its own approval proceeds;
 *    an op NOT in the plan still asks. It refuses an unapproved approval.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answerCurrencyRead } from './adsCurrencyFixture.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter, authorizeBudgetOps } from '../src/host/adsAdapter.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { createCampaignSpendApproval, resolveApproval } from '../src/host/approvalService.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';

const T = 'budget-t';
let srv: http.Server;
let storage: Storage;
let writes: Array<{ path: string; body: Record<string, unknown> }> = [];
const meta: Record<string, string | undefined> = {}; // campaign or ad-set id → daily_budget
const adsetsOf: Record<string, string[]> = {}; // campaignId → its ad-set ids
const googleMicros: Record<string, string> = {};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV';
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
      res.writeHead(200, { 'content-type': 'application/json' });
      const sets = /^\/meta\/(\d+)\/adsets$/.exec(url.pathname);
      if (sets) { res.end(JSON.stringify({ data: (adsetsOf[sets[1]!] ?? []).map((id) => ({ id, ...(meta[id] ? { daily_budget: meta[id] } : {}) })) })); return; }
      const m = /^\/meta\/(\d+)$/.exec(url.pathname);
      if (m) {
        if (req.method === 'POST') { writes.push({ path: url.pathname, body }); meta[m[1]!] = String(body.daily_budget); res.end(JSON.stringify({ success: true })); return; }
        const b = meta[m[1]!];
        // account_id: the campaign-owner read (ADR 0952 P9) binds the campaign to act_1 before any money read or write.
        res.end(JSON.stringify(b === undefined ? { id: m[1], account_id: '1' } : { id: m[1], account_id: '1', daily_budget: b })); return;
      }
      if (url.pathname.endsWith('googleAds:search')) {
        const id = /campaign\.id = (\d+)/.exec(String(body.query))?.[1] ?? '';
        if (String(body.query).includes('amount_micros')) { res.end(JSON.stringify({ results: [{ campaignBudget: { amountMicros: googleMicros[id] } }] })); return; }
        res.end(JSON.stringify({ results: [{ campaign: { campaignBudget: `customers/1/campaignBudgets/${id}` } }] })); return;
      }
      if (url.pathname.endsWith('campaignBudgets:mutate')) {
        writes.push({ path: url.pathname, body });
        const op = (body.operations as Array<{ update: { resourceName: string } }>)[0]!;
        res.end(JSON.stringify({ results: [{ resourceName: op.update.resourceName }] })); return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  process.env.OPENWOP_META_API_BASE = `${base}/meta`;
  process.env.OPENWOP_GOOGLE_ADS_API_BASE = `${base}/google`;
  for (const id of ['meta-ads', 'google-ads']) {
    registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    await createSecretConnection({ tenantId: T, provider: id, kind: 'bearer', secret: 'TOK', scope: 'user', userId: 'u1' });
  }
  await storage.insertRun({ runId: 'budget-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  for (const k of ['OPENWOP_META_API_BASE', 'OPENWOP_GOOGLE_ADS_API_BASE', 'OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN']) delete process.env[k];
  await new Promise<void>((r) => srv.close(() => r()));
});
beforeEach(() => { writes = []; });

const adapter = () => makeAdsAdapter({ storage, tenantId: T, runId: 'budget-run', actingUserId: 'u1', orgId: T });

describe('ADR 0952 P3 — getCampaignBudget', () => {
  it('reads Meta CBO daily_budget and Google amountMicros; ABO is a typed failure, never a guess', async () => {
    meta['11'] = '5000';
    googleMicros['22'] = '75000000'; // 7,500 minor units at ×10⁴
    expect(await adapter().getCampaignBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '11' })).toEqual({ outcome: 'ok', platform: 'meta', dailyBudgetMinor: 5000 });
    expect(await adapter().getCampaignBudget({ platform: 'google', adAccountId: '123-456-7890', campaignId: '22' })).toEqual({ outcome: 'ok', platform: 'google', dailyBudgetMinor: 7500 });
    // ABO — the budget lives on the campaign's one ad set (what our dispatch creates).
    meta['12'] = undefined; adsetsOf['12'] = ['120']; meta['120'] = '3000';
    expect(await adapter().getCampaignBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '12' })).toEqual({ outcome: 'ok', platform: 'meta', dailyBudgetMinor: 3000 });
    // Budgets split across ad sets: no single daily budget to move.
    meta['13'] = undefined; adsetsOf['13'] = ['130', '131']; meta['130'] = '1000'; meta['131'] = '2000';
    expect(await adapter().getCampaignBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '13' })).toEqual({ outcome: 'failed', error: 'budget_split_across_ad_sets' });
    meta['14'] = undefined; adsetsOf['14'] = ['140'];
    expect(await adapter().getCampaignBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '14' })).toEqual({ outcome: 'failed', error: 'no_daily_budget' });
    // Meta campaign ids are global: a campaign read under another accessible account is refused, never reported.
    expect(await adapter().getCampaignBudget({ platform: 'meta', adAccountId: 'act_2', campaignId: '11' })).toEqual({ outcome: 'failed', error: 'campaign_account_mismatch' });
    expect((await adapter().getCampaignBudget({ platform: 'tiktok', adAccountId: '1', campaignId: '1' })).outcome).toBe('unsupported');
    expect(writes).toHaveLength(0);
  });
});

describe('ADR 0952 P3 residual (b) — a Meta budget write goes where the budget lives', () => {
  it('an ABO campaign (our own dispatch shape) gets its ONE ad set updated, never the campaign', async () => {
    await setGovernancePolicy(T, {}, 'test');
    meta['15'] = undefined; adsetsOf['15'] = ['150']; meta['150'] = '3000';
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '15', dailyBudgetMinor: 4000 })).toMatchObject({ outcome: 'updated', target: '150' });
    expect(writes).toEqual([{ path: '/meta/150', body: { daily_budget: 4000 } }]);
    // A CBO campaign is written on the campaign itself.
    meta['16'] = '5000';
    writes = [];
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '16', dailyBudgetMinor: 4500 })).toMatchObject({ outcome: 'updated', target: '16' });
    expect(writes).toEqual([{ path: '/meta/16', body: { daily_budget: 4500 } }]);
    // Split across ad sets: nothing is written.
    meta['17'] = undefined; adsetsOf['17'] = ['170', '171']; meta['170'] = '1'; meta['171'] = '2';
    writes = [];
    expect(await adapter().updateBudget({ platform: 'meta', adAccountId: 'act_1', campaignId: '17', dailyBudgetMinor: 4500 })).toEqual({ outcome: 'failed', error: 'budget_split_across_ad_sets' });
    expect(writes).toHaveLength(0);
  });
});

describe('ADR 0952 P3 — authorizeBudgetOps', () => {
  it('one approved plan approval covers its ops above the threshold; an op outside the plan still asks', async () => {
    await setGovernancePolicy(T, { adSpend: { approvalThresholdMinor: 1000 } }, 'test');
    const op = { platform: 'meta' as const, adAccountId: 'act_1', campaignId: '11', dailyBudgetMinor: 6000 };
    const before = await adapter().updateBudget(op);
    expect(before.outcome).toBe('requires_approval');
    expect(writes).toHaveLength(0);

    const plan = await createCampaignSpendApproval({ tenantId: T, spendKind: 'reallocation', platform: 'meta', adAccountId: 'act_1', dailyBudgetMinor: 1000, spendIdemKey: 'realloc:test', proposal: 'p' });
    await expect(authorizeBudgetOps(T, plan.approvalId, [op])).rejects.toThrow(/not approved/);
    await resolveApproval(plan.approvalId, { status: 'approved' });
    await authorizeBudgetOps(T, plan.approvalId, [op]);

    expect(await adapter().updateBudget(op)).toMatchObject({ outcome: 'updated', dailyBudgetMinor: 6000 });
    expect(writes).toEqual([{ path: '/meta/11', body: { daily_budget: 6000 } }]);
    // A different amount is not in the plan: it asks for its own approval.
    expect((await adapter().updateBudget({ ...op, dailyBudgetMinor: 6100 })).outcome).toBe('requires_approval');
    // Another tenant cannot borrow the approval.
    await expect(authorizeBudgetOps('other-tenant', plan.approvalId, [op])).rejects.toThrow(/not approved/);
  });
});
