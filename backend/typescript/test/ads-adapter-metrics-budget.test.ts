/**
 * ADR 0186 slice 4a/4b — ctx.ads.getMetrics + updateBudget adapter HTTP paths
 * (Google Ads, mock server). Now testable end-to-end: this run's egress fix restores
 * loopback reachability under OPENWOP_WEBHOOK_ALLOW_PRIVATE. Validates the money paths
 * — metrics micros→major, the two-step budget lookup→mutate, dry-run zero-call preview,
 * Bearer + developer-token, RFC 0079 provenance — that the node tests mock out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

interface Hit { path: string; auth?: string; dev?: string; body: Record<string, unknown> }

describe('ADR 0186 slice 4a/4b — ctx.ads Google Ads HTTP paths', () => {
  let g: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV_TOKEN';
    const app = await createApp({ port: 18991, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    g = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        hits.push({ path: req.url ?? '', auth: req.headers.authorization, dev: req.headers['developer-token'] as string, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        const q = String(body.query ?? '');
        if ((req.url ?? '').includes(':mutate')) { res.end(JSON.stringify({ results: [{ resourceName: 'customers/1/campaignBudgets/9' }] })); return; }
        if (q.includes('campaign_budget')) { res.end(JSON.stringify({ results: [{ campaign: { campaignBudget: 'customers/1/campaignBudgets/9' } }] })); return; }
        res.end(JSON.stringify({ results: [{ metrics: { impressions: '1200', clicks: '48', costMicros: '15500000', ctr: '4.0', averageCpc: '320000' } }] }));
      });
    });
    await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(g.address() as AddressInfo).port}`;
    await createSecretConnection({ tenantId: 'tg', provider: 'google-ads', kind: 'bearer', secret: 'GOOG_OAUTH', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'r-metrics', workflowId: 'w', tenantId: 'tg', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'r-budget', workflowId: 'w', tenantId: 'tg', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });
  afterAll(async () => { delete process.env.OPENWOP_GOOGLE_ADS_API_BASE; delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN; await new Promise<void>((r) => g.close(() => r())); });

  const adapter = (runId: string) => makeAdsAdapter({ storage, tenantId: 'tg', runId, actingUserId: 'u1', orgId: 'tg' });

  it('getMetrics: queries googleAds:search and normalizes micros → major units', async () => {
    hits = [];
    const out = await adapter('r-metrics').getMetrics({ platform: 'google', adAccountId: '123-456-7890', campaignId: '222' });
    expect(out.outcome).toBe('ok');
    if (out.outcome !== 'ok') return;
    expect(out.metrics).toEqual({ impressions: 1200, clicks: 48, spend: 15.5, ctr: 4.0, cpc: 0.32 });
    expect(hits[0].auth).toBe('Bearer GOOG_OAUTH');
    expect(hits[0].dev).toBe('DEV_TOKEN');
    expect(JSON.stringify(out)).not.toContain('GOOG_OAUTH');
    const md = (await storage.getRun('r-metrics'))?.metadata as Record<string, unknown> | undefined;
    expect((md?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'google-ads')).toBe(true);
  });

  it('updateBudget dryRun: returns a preview with ZERO platform calls', async () => {
    hits = [];
    const out = await adapter('r-budget').updateBudget({ platform: 'google', adAccountId: '123', campaignId: '222', dailyBudgetMinor: 7500, dryRun: true });
    expect(out.outcome).toBe('preview');
    expect(hits.length).toBe(0);
  });

  it('updateBudget real: resolves the budget then mutates amount_micros (×1e4)', async () => {
    hits = [];
    const out = await adapter('r-budget').updateBudget({ platform: 'google', adAccountId: '123', campaignId: '222', dailyBudgetMinor: 7500, dryRun: false });
    expect(out.outcome).toBe('updated');
    if (out.outcome !== 'updated') return;
    expect(out.target).toBe('customers/1/campaignBudgets/9');
    // Two-step: search (resolve budget) then :mutate.
    expect(hits.map((h) => (h.path.includes(':mutate') ? 'mutate' : 'search'))).toEqual(['search', 'mutate']);
    const mutate = hits.find((h) => h.path.includes(':mutate'))!;
    const op = (mutate.body.operations as Array<{ update: { amountMicros: string }; updateMask: string }>)[0];
    expect(op.update.amountMicros).toBe('75000000'); // 7500 minor × 1e4
    expect(op.updateMask).toBe('amount_micros');
    expect(JSON.stringify(out)).not.toContain('GOOG_OAUTH');
  });
});
