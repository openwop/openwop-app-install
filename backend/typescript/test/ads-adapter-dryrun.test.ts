/**
 * Dry-run / preview for ad dispatch (ADR 0167). Proves ctx.ads.publishAd({ dryRun:true })
 * builds the EXACT PAUSED create payloads and returns them as a plan while making ZERO
 * platform calls and persisting nothing — across all three platforms (Meta, Google,
 * TikTok). A preview works even when the platform CONFIG isn't ready (no connection /
 * no Google developer-token), since it never touches the network. And after a real
 * dispatch, a later preview for the same brief reports alreadyDispatched:true (so a UI
 * can warn the run would be a fork-stable no-op) without ever short-circuiting to
 * 'published' — a preview must stay side-effect-free.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

interface Hit { method: string; path: string }

describe('ads dry-run / preview (ADR 0167)', () => {
  let servers: http.Server[] = [];
  let storage: Storage;
  let hits: Hit[] = [];
  let idSeq = 0;

  const recorder = () =>
    http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push({ method: req.method ?? '', path: req.url ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `obj-${++idSeq}`, code: 0, data: { campaign_id: `c-${idSeq}`, adgroup_id: `g-${idSeq}`, ad_id: `a-${idSeq}` }, results: [{ resourceName: `rn/${idSeq}` }] }));
      });
    });

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18966, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    // One recorder per platform; the env override points the adapter at it. A dry-run
    // must hit NONE of them — the servers exist only to catch an accidental call.
    const [meta, google, tiktok] = [recorder(), recorder(), recorder()];
    servers = [meta, google, tiktok];
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, r))));
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
    process.env.OPENWOP_TIKTOK_ADS_API_BASE = `http://127.0.0.1:${(tiktok.address() as AddressInfo).port}`;
    // Meta + TikTok connections present; Google deliberately WITHOUT a developer-token
    // configured, to prove a preview builds even when real dispatch would fail closed.
    delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
    await createSecretConnection({ tenantId: 'tads', provider: 'meta-ads', kind: 'bearer', secret: 'META_TOKEN', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: 'tads', provider: 'tiktok-ads', kind: 'bearer', secret: 'TT_TOKEN', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-1', workflowId: 'w', tenantId: 'tads', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_META_API_BASE;
    delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
    delete process.env.OPENWOP_TIKTOK_ADS_API_BASE;
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  beforeEach(() => { hits = []; });

  const adapter = (runId = 'run-1', actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tads', runId, actingUserId, orgId: 'tads' });

  const args = (platform: 'meta' | 'google' | 'tiktok', briefId: string, extra: Record<string, unknown> = {}) => ({
    platform, briefId, adAccountId: '12345', campaignName: 'Summer Sale',
    copy: { headline: 'Pick faster', description: 'Checkout in one tap', bodyText: '40% faster checkout', ctaText: 'LEARN_MORE' },
    dailyBudgetMinor: 5000, ...extra,
  });

  it('Meta: returns a PAUSED plan and makes ZERO platform calls', async () => {
    const out = await adapter().publishAd(args('meta', 'brief-DRY-META', { dryRun: true }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.platform).toBe('meta');
    expect(out.alreadyDispatched).toBe(false);
    expect(out.connectionReady).toBe(true); // a meta-ads connection exists → real dispatch wouldn't fail no_connection
    expect(out.plan.map((s) => s.step)).toEqual(['campaigns', 'adsets', 'ads']);
    for (const step of out.plan) expect(step.body.status).toBe('PAUSED');
    expect(hits).toHaveLength(0); // the load-bearing assertion: a preview calls nothing
    expect(JSON.stringify(out)).not.toContain('META_TOKEN');
  });

  it('Google: builds a plan even with NO developer-token, and makes ZERO platform calls', async () => {
    const out = await adapter().publishAd(args('google', 'brief-DRY-GOOG', { dryRun: true, landingUrl: 'https://example.com' }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.platform).toBe('google');
    expect(out.connectionReady).toBe(false); // no google-ads connection in this test → honestly not ready, but the plan still builds
    expect(out.plan.map((s) => s.step)).toEqual(['campaignBudgets', 'campaigns', 'adGroups', 'adGroupAds']);
    // The campaign create is PAUSED inside the operations envelope.
    const campaign = out.plan.find((s) => s.step === 'campaigns');
    const create = (campaign?.body.operations as Array<{ create: Record<string, unknown> }>)[0].create;
    expect(create.status).toBe('PAUSED');
    expect(hits).toHaveLength(0);
  });

  it('TikTok: builds a DISABLE plan carrying advertiser_id, and makes ZERO platform calls', async () => {
    const out = await adapter().publishAd(args('tiktok', 'brief-DRY-TT', { dryRun: true }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.platform).toBe('tiktok');
    expect(out.connectionReady).toBe(true); // a tiktok-ads connection exists
    expect(out.plan.map((s) => s.step)).toEqual(['campaign/create/', 'adgroup/create/', 'ad/create/']);
    for (const step of out.plan) {
      expect(step.body.advertiser_id).toBe('12345');
      expect(step.body.operation_status).toBe('DISABLE'); // TikTok's paused literal
    }
    expect(hits).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain('TT_TOKEN');
  });

  it('a preview after a REAL dispatch reports alreadyDispatched:true and STILL makes zero calls', async () => {
    const real = await adapter().publishAd(args('meta', 'brief-DRY-REUSE'));
    expect(real.outcome).toBe('published');
    if (real.outcome !== 'published') return;
    hits = [];

    const preview = await adapter().publishAd(args('meta', 'brief-DRY-REUSE', { dryRun: true }));
    expect(preview.outcome).toBe('preview');
    if (preview.outcome !== 'preview') return;
    expect(preview.alreadyDispatched).toBe(true);
    expect(preview.platformCampaignId).toBe(real.platformCampaignId);
    expect(hits).toHaveLength(0); // preview never short-circuits to 'published'; it calls nothing
  });
});
