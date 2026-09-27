/**
 * ADR 0411 §P3c — the ads VIDEO-dispatch leg. A generated reel (P3a/P3b) is a
 * video-typed media asset; dispatching it as an ad must route to the platform
 * VIDEO surface, NOT the image endpoint. This proves:
 *  - Meta video DRY-RUN previews the documented `advideos` upload → `video_data`
 *    creative (bytes REDACTED, placeholder-id chaining), calling NOTHING.
 *  - TikTok video DRY-RUN previews `/file/video/ad/upload/` → an `ad_format:
 *    'SINGLE_VIDEO'` creative, calling NOTHING.
 *  - A LIVE video dispatch (Meta/TikTok) FAILS CLOSED `video_dispatch_live_pending`
 *    BEFORE any egress or spend-gate side effect — never a guessed live call on a
 *    money path (the multipart upload transport + video_status poll + thumbnail are
 *    live-smoke-pending).
 *  - Google/LinkedIn + video → `video_unsupported_platform` (not reel targets).
 *  - The defence-in-depth misfire guard: a LIVE image leg fed an actually-`video/*`
 *    asset fails closed `media_asset_wrong_kind` (never POST video bytes to adimages).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

// A tiny valid base64 MP4-ish blob (content is opaque — only the contentType matters here).
const MP4_B64 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=';

describe('ADR 0411 §P3c — ads video-dispatch leg', () => {
  let servers: http.Server[] = [];
  let storage: Storage;
  let hits: string[] = [];
  let idSeq = 0;

  const recorder = () =>
    http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `obj-${++idSeq}`, code: 0, data: { campaign_id: `c-${idSeq}`, adgroup_id: `g-${idSeq}`, ad_id: `a-${idSeq}` }, images: { bytes: { hash: `HASH-${idSeq}` } } }));
      });
    });

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18987, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    const [meta, google, tiktok, linkedin] = [recorder(), recorder(), recorder(), recorder()];
    servers = [meta, google, tiktok, linkedin];
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;
    process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
    process.env.OPENWOP_TIKTOK_ADS_API_BASE = `http://127.0.0.1:${(tiktok.address() as AddressInfo).port}`;
    process.env.OPENWOP_LINKEDIN_ADS_API_BASE = `http://127.0.0.1:${(linkedin.address() as AddressInfo).port}`;
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

  const adapter = () => makeAdsAdapter({ storage, tenantId: 'tads', runId: 'run-1', actingUserId: 'u1', orgId: 'tads' });

  const args = (platform: 'meta' | 'google' | 'tiktok' | 'linkedin', briefId: string, extra: Record<string, unknown> = {}) => ({
    platform, briefId, adAccountId: '12345', campaignName: 'Summer Reel',
    copy: { headline: 'Pick faster', description: 'Checkout in one tap', bodyText: '40% faster checkout', ctaText: 'LEARN_MORE' },
    dailyBudgetMinor: 5000, landingUrl: 'https://example.com/lp',
    pageId: 'page-77', identityId: 'ident-9',
    ...extra,
  });

  it('Meta video DRY-RUN: previews advideos → video_data (bytes redacted, placeholder chaining), zero calls', async () => {
    const out = await adapter().publishAd(args('meta', 'brief-VID-META', { dryRun: true, mediaAssetId: 'masset:reel', mediaKind: 'video' }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.plan.map((s) => s.step)).toEqual(['advideos', 'campaigns', 'adsets', 'adcreatives', 'ads']);
    const upload = out.plan.find((p) => p.step === 'advideos');
    expect(String(upload?.body.source)).toContain('redacted'); // NEVER creative bytes in a plan
    const creative = out.plan.find((p) => p.step === 'adcreatives');
    const spec = creative?.body.object_story_spec as { video_data?: Record<string, unknown>; link_data?: unknown };
    expect(spec.link_data).toBeUndefined(); // a video creative, not an image link ad
    expect(spec.video_data?.video_id).toBe('<video_id>');
    expect(spec.video_data?.image_url).toBe('<video-thumbnail>');
    expect(hits).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain('META_TOKEN');
  });

  it('TikTok video DRY-RUN: previews /file/video/ad/upload/ → SINGLE_VIDEO creative, zero calls', async () => {
    const out = await adapter().publishAd(args('tiktok', 'brief-VID-TT', { dryRun: true, mediaAssetId: 'masset:reel', mediaKind: 'video' }));
    expect(out.outcome).toBe('preview');
    if (out.outcome !== 'preview') return;
    expect(out.plan.map((s) => s.step)).toEqual(['file/video/ad/upload/', 'campaign/create/', 'adgroup/create/', 'ad/create/']);
    expect(String(out.plan[0]?.body.video_file)).toContain('redacted');
    const adStep = out.plan.find((p) => p.step === 'ad/create/');
    const creative = (adStep?.body.creatives as Array<Record<string, unknown>>)[0]!;
    expect(creative.ad_format).toBe('SINGLE_VIDEO');
    expect(creative.video_id).toBe('<video_id>');
    expect(creative.image_ids).toEqual(['<video-cover>']);
    expect(hits).toHaveLength(0);
  });

  it('Meta video LIVE: fails closed video_dispatch_live_pending BEFORE any egress', async () => {
    const out = await adapter().publishAd(args('meta', 'brief-VID-LIVE-META', { mediaAssetId: 'masset:reel', mediaKind: 'video' }));
    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.error).toBe('video_dispatch_live_pending');
    expect(hits).toHaveLength(0); // never a guessed live call
  });

  it('TikTok video LIVE: fails closed video_dispatch_live_pending BEFORE any egress', async () => {
    const out = await adapter().publishAd(args('tiktok', 'brief-VID-LIVE-TT', { mediaAssetId: 'masset:reel', mediaKind: 'video' }));
    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.error).toBe('video_dispatch_live_pending');
    expect(hits).toHaveLength(0);
  });

  it('Google + video: video_unsupported_platform (not a reel target), even in dry-run', async () => {
    const out = await adapter().publishAd(args('google', 'brief-VID-GOOG', { dryRun: true, mediaAssetId: 'masset:reel', mediaKind: 'video' }));
    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.error).toBe('video_unsupported_platform');
    expect(hits).toHaveLength(0);
  });

  it('LinkedIn + video: video_unsupported_platform', async () => {
    const out = await adapter().publishAd(args('linkedin', 'brief-VID-LI', { dryRun: true, mediaAssetId: 'masset:reel', mediaKind: 'video' }));
    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.error).toBe('video_unsupported_platform');
  });

  it('misfire guard: a LIVE image leg fed an actually-video/* asset fails closed media_asset_wrong_kind — no adimages POST', async () => {
    const { token } = await storeMediaAsset('tads', { contentBase64: MP4_B64, contentType: 'video/mp4' });
    // mediaKind unset (defaults to image) but the asset is real video — the guard
    // must catch it before uploading video bytes to the image endpoint.
    const out = await adapter().publishAd(args('meta', 'brief-VID-MISFIRE', { mediaAssetId: token }));
    expect(out.outcome).toBe('failed');
    if (out.outcome !== 'failed') return;
    expect(out.error).toBe('media_asset_wrong_kind');
    expect(hits).toHaveLength(0); // never POSTed video bytes to adimages
  });
});
