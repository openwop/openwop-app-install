/**
 * Dry-run / preview for ad dispatch (ADR 0167; ADR 0223 production payloads). Proves
 * ctx.ads.publishAd({ dryRun:true }) builds the EXACT PAUSED create payloads and
 * returns them as a plan while making ZERO platform calls and persisting nothing —
 * across all four platforms (Meta, Google, TikTok, LinkedIn), INCLUDING the new C1
 * steps (media upload with REDACTED bytes, real Meta creative) with placeholder-id
 * chaining. A preview works even when the platform CONFIG isn't ready (no connection /
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
    const [meta, google, tiktok, linkedin] = [recorder(), recorder(), recorder(), recorder()];
    servers = [meta, google, tiktok, linkedin];
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
    process.env.OPENWOP_TIKTOK_ADS_API_BASE = `http://127.0.0.1:${(tiktok.address() as AddressInfo).port}`;
    process.env.OPENWOP_LINKEDIN_ADS_API_BASE = `http://127.0.0.1:${(linkedin.address() as AddressInfo).port}`;
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
    delete process.env.OPENWOP_LINKEDIN_ADS_API_BASE;
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  beforeEach(() => { hits = []; });

  const adapter = (runId = 'run-1', actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tads', runId, actingUserId, orgId: 'tads' });

  const args = (platform: 'meta' | 'google' | 'tiktok' | 'linkedin', briefId: string, extra: Record<string, unknown> = {}) => ({
    platform, briefId, adAccountId: '12345', campaignName: 'Summer Sale',
    copy: { headline: 'Pick faster', description: 'Checkout in one tap', bodyText: '40% faster checkout', ctaText: 'LEARN_MORE' },
    dailyBudgetMinor: 5000, landingUrl: 'https://example.com/lp',
    pageId: 'page-77', identityId: 'ident-9', // meta/tiktok required args (ignored by the others)
    ...extra,
  });

  it('Meta: returns a PAUSED plan (incl. the real creative step) and makes ZERO platform calls', async () => {
    const out = await adapter().publishAd(args('meta', 'brief-DRY-META', { dryRun: true }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.platform).toBe('meta');
    expect(out.alreadyDispatched).toBe(false);
    expect(out.connectionReady).toBe(true); // a meta-ads connection exists → real dispatch wouldn't fail no_connection
    expect(out.plan.map((s) => s.step)).toEqual(['campaigns', 'adsets', 'adcreatives', 'ads']);
    for (const step of out.plan.filter((p) => p.step !== 'adcreatives')) expect(step.body.status).toBe('PAUSED');
    // The creative step shows the exact object_story_spec; the ad chains its placeholder id.
    const creative = out.plan.find((p) => p.step === 'adcreatives');
    expect((creative?.body.object_story_spec as { page_id: string }).page_id).toBe('page-77');
    const ad = out.plan.find((p) => p.step === 'ads');
    expect(ad?.body.creative).toEqual({ creative_id: '<adcreatives-id>' }); // placeholder-id chaining
    expect(hits).toHaveLength(0); // the load-bearing assertion: a preview calls nothing
    expect(JSON.stringify(out)).not.toContain('META_TOKEN');
  });

  it('Meta + mediaAssetId: the plan shows the adimages step with REDACTED bytes and <image_hash> chaining — zero calls', async () => {
    const out = await adapter().publishAd(args('meta', 'brief-DRY-MEDIA', { dryRun: true, mediaAssetId: 'masset:preview' }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.plan.map((s) => s.step)).toEqual(['adimages', 'campaigns', 'adsets', 'adcreatives', 'ads']);
    const upload = out.plan.find((p) => p.step === 'adimages');
    expect(String(upload?.body.bytes)).toContain('redacted'); // NEVER creative bytes in a plan
    const creative = out.plan.find((p) => p.step === 'adcreatives');
    expect((creative?.body.object_story_spec as { link_data: Record<string, unknown> }).link_data.image_hash).toBe('<image_hash>');
    expect(hits).toHaveLength(0);
  });

  it('Google: builds a plan even with NO developer-token, and makes ZERO platform calls', async () => {
    const out = await adapter().publishAd(args('google', 'brief-DRY-GOOG', { dryRun: true }));
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

  it('TikTok: builds a DISABLE plan carrying advertiser_id + identity, and makes ZERO platform calls', async () => {
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
    const adStep = out.plan.find((p) => p.step === 'ad/create/');
    const creative = (adStep?.body.creatives as Array<Record<string, unknown>>)[0]!;
    expect(creative.identity_id).toBe('ident-9');
    expect(creative.identity_type).toBe('CUSTOMIZED_USER');
    expect(hits).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain('TT_TOKEN');
  });

  it('TikTok + mediaAssetId: the plan shows the image-upload step with REDACTED bytes and <image_id> chaining — zero calls', async () => {
    const out = await adapter().publishAd(args('tiktok', 'brief-DRY-TT-MEDIA', { dryRun: true, mediaAssetId: 'masset:preview' }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.plan.map((s) => s.step)).toEqual(['file/image/ad/upload/', 'campaign/create/', 'adgroup/create/', 'ad/create/']);
    expect(String(out.plan[0]?.body.image_file)).toContain('redacted'); // NEVER creative bytes in a plan
    const adStep = out.plan.find((p) => p.step === 'ad/create/');
    const creative = (adStep?.body.creatives as Array<Record<string, unknown>>)[0]!;
    expect(creative.image_ids).toEqual(['<image_id>']); // placeholder-id chaining
    expect(hits).toHaveLength(0);
  });

  it('LinkedIn: builds a DRAFT/PAUSED plan (no connection needed) and makes ZERO platform calls', async () => {
    const out = await adapter().publishAd(args('linkedin', 'brief-DRY-LI', { dryRun: true }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.platform).toBe('linkedin');
    expect(out.connectionReady).toBe(false); // no linkedin-ads connection in this test — the plan still builds
    expect(out.plan.map((s) => s.step)).toEqual(['adCampaignGroups', 'adCampaigns', 'creatives']);
    expect(out.plan[0]?.body.status).toBe('DRAFT');
    expect(out.plan[1]?.body.status).toBe('PAUSED');
    expect(out.plan[1]?.body.campaignGroup).toBe('<adCampaignGroups-id>'); // placeholder chaining
    expect(out.plan[2]?.body.intendedStatus).toBe('PAUSED');
    expect(hits).toHaveLength(0);
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
