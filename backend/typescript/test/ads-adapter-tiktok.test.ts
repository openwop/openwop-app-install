/**
 * TikTok Ads dispatch adapter (ADR 0167 Phase 3; ADR 0223 production payloads) via
 * the Connections broker. Proves ctx.ads.publishAd creates the campaign→adgroup→ad
 * pipeline ALL DISABLE (paused) with the OAuth token under a RAW `Access-Token`
 * header (NOT `Authorization: Bearer`); the adgroup carries the v1.3 required
 * delivery fields (placements/schedule/optimization/billing + day budget); the ad
 * posts under the REQUIRED identity (missing_identity_id fails closed); the optional
 * media leg uploads base64 bytes to /file/image/ad/upload/ and threads image_ids;
 * treats TikTok's `{code:0}` as success / non-zero as failure; is fork-stable idempotent
 * on the 'tiktok' platform key; does NOT roll back (objects left DISABLE = no spend); and
 * — the CRITICAL guard — a caller cannot override the broker's `Access-Token` via any
 * case-variant in extraHeaders even though the broker writes a CUSTOM auth-header name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { brokeredPost } from '../src/host/brokeredEgress.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

interface Hit { method: string; path: string; auth?: string; access?: string; extra?: string; body: Record<string, unknown> }

describe('TikTok Ads dispatch adapter (ADR 0167 Phase 3)', () => {
  let tk: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let seq = 0;
  let failCode = 0; // set non-zero to simulate a TikTok error response on the next call
  let adPlural = false; // TikTok's real ad/create/ returns data.ad_ids[] (not a singular ad_id)

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18964, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    tk = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = req.url ?? '';
        hits.push({ method: req.method ?? '', path, auth: req.headers.authorization, access: req.headers['access-token'] as string, extra: req.headers['x-custom'] as string, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (failCode) { res.end(JSON.stringify({ code: failCode, message: 'rejected' })); return; }
        if (path.includes('/file/image/ad/upload/')) { res.end(JSON.stringify({ code: 0, message: 'OK', data: { image_id: `img-${++seq}` } })); return; }
        if (adPlural && path.includes('/ad/create/')) { res.end(JSON.stringify({ code: 0, message: 'OK', data: { ad_ids: [`ad-${++seq}`] } })); return; }
        const edge = path.includes('campaign') ? 'campaign_id' : path.includes('adgroup') ? 'adgroup_id' : 'ad_id';
        res.end(JSON.stringify({ code: 0, message: 'OK', data: { [edge]: `${edge}-${++seq}` } }));
      });
    });
    await new Promise<void>((r) => tk.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_TIKTOK_ADS_API_BASE = `http://127.0.0.1:${(tk.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tt', provider: 'tiktok-ads', kind: 'bearer', secret: 'TT_TOKEN', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'tr-1', workflowId: 'w', tenantId: 'tt', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'tr-2-fork', workflowId: 'w', tenantId: 'tt', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_TIKTOK_ADS_API_BASE;
    await new Promise<void>((r) => tk.close(() => r()));
  });

  beforeEach(() => { hits = []; failCode = 0; adPlural = false; });

  const adapter = (runId: string, actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tt', runId, ...(actingUserId ? { actingUserId } : {}), orgId: 'tt' });
  const args = (briefId: string) => ({ platform: 'tiktok' as const, briefId, adAccountId: '700123', campaignName: 'TT Launch', copy: { headline: 'Pick faster', bodyText: 'Save time', ctaText: 'LEARN_MORE' }, dailyBudgetMinor: 5000, identityId: 'ident-9', landingUrl: 'https://example.com/lp' });

  it('creates campaign→adgroup→ad with a RAW Access-Token header (no Bearer), adgroup+ad DISABLE', async () => {
    const out = await adapter('tr-1').publishAd(args('tbrief-A'));
    expect(out.outcome).toBe('published');
    if (out.outcome !== 'published') return;
    expect(out.platform).toBe('tiktok');
    expect(out.paused).toBe(true);

    const creates = hits.filter((h) => h.method === 'POST' && /\/(campaign|adgroup|ad)\/create\/$/.test(h.path));
    expect(creates.map((h) => (h.path.match(/\/(campaign|adgroup|ad)\/create\//) ?? [])[1])).toEqual(['campaign', 'adgroup', 'ad']);
    for (const c of creates) {
      expect(c.access).toBe('TT_TOKEN');     // RAW token under Access-Token …
      expect(c.auth).toBeUndefined();         // … and NO Authorization header at all
      expect(c.body.advertiser_id).toBe('700123'); // public id in the body, never the URL
    }
    // ALL three creates are DISABLE (paused) — no auto-spend, consistent across strategies.
    expect(creates.every((c) => c.body.operation_status === 'DISABLE')).toBe(true);
    // The adgroup carries the v1.3 required delivery fields + the day budget (ADR 0223).
    const adgroup = creates.find((c) => c.path.includes('/adgroup/create/'));
    expect(adgroup?.body).toMatchObject({
      placements: ['PLACEMENT_TIKTOK'], schedule_type: 'SCHEDULE_FROM_NOW',
      optimization_goal: 'CLICK', billing_event: 'CPC',
      budget_mode: 'BUDGET_MODE_DAY', budget: 50, // 5000 minor units → 50 major
    });
    // The ad posts under the required identity, carrying the landing page.
    const adCreate = creates.find((c) => c.path.includes('/ad/create/'));
    const creative = (adCreate?.body.creatives as Array<Record<string, unknown>>)[0]!;
    expect(creative.identity_id).toBe('ident-9');
    expect(creative.identity_type).toBe('CUSTOMIZED_USER');
    expect(creative.landing_page_url).toBe('https://example.com/lp');
    expect(JSON.stringify(out)).not.toContain('TT_TOKEN');
    const meta = (await storage.getRun('tr-1'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'tiktok-ads')).toBe(true);
  });

  it('FORK-STABLE idempotency on the tiktok key: new runId + same briefId reuses ids, no new create', async () => {
    const first = await adapter('tr-1').publishAd(args('tbrief-FORK'));
    expect(first.outcome).toBe('published');
    if (first.outcome !== 'published') return;
    hits = [];
    const forked = await adapter('tr-2-fork').publishAd(args('tbrief-FORK'));
    expect(forked.outcome).toBe('published');
    if (forked.outcome !== 'published') return;
    expect(forked.reused).toBe(true);
    expect(forked.platform).toBe('tiktok');
    expect(forked.platformCampaignId).toBe(first.platformCampaignId);
    expect(hits.filter((h) => /\/create\/$/.test(h.path))).toHaveLength(0);
  });

  it('fails closed missing_identity_id when no identityId is supplied (zero platform calls)', async () => {
    const { identityId: _omit, ...noIdent } = args('tbrief-NOIDENT');
    const out = await adapter('tr-1').publishAd(noIdent);
    expect(out).toEqual({ outcome: 'failed', error: 'missing_identity_id' });
    expect(hits).toHaveLength(0);
  });

  it('uploads a media asset via /file/image/ad/upload/ and threads image_ids into the ad (ADR 0223 media leg)', async () => {
    const base64 = Buffer.from('tiktok-img').toString('base64');
    const { token } = await storeMediaAsset('tt', { contentBase64: base64, contentType: 'image/png' });
    const out = await adapter('tr-1').publishAd({ ...args('tbrief-MEDIA'), mediaAssetId: token });
    expect(out.outcome).toBe('published');

    // The upload leg fired first — raw Access-Token, advertiser_id in the body, bytes as base64.
    expect(hits[0]?.path.includes('/file/image/ad/upload/')).toBe(true);
    expect(hits[0]?.body.image_file).toBe(base64);
    expect(hits[0]?.body.advertiser_id).toBe('700123');
    expect(hits[0]?.access).toBe('TT_TOKEN');
    // The returned image_id landed on the ad creative.
    const adCreate = hits.find((h) => h.path.includes('/ad/create/'));
    const creative = (adCreate?.body.creatives as Array<Record<string, unknown>>)[0]!;
    expect(creative.image_ids).toEqual([expect.stringMatching(/^img-\d+$/)]);
    // No creative bytes in the result.
    expect(JSON.stringify(out)).not.toContain(base64);
  });

  it('treats a non-zero TikTok response code as a failure (no rollback calls)', async () => {
    failCode = 40002;
    const out = await adapter('tr-1').publishAd(args('tbrief-ERR'));
    expect(out.outcome).toBe('failed');
    // No rollback: TikTok strategy has none — the one created object stays DISABLE (no spend).
    const deletes = hits.filter((h) => h.method === 'DELETE' || /remove/.test(h.path));
    expect(deletes).toHaveLength(0);
    expect(out).not.toHaveProperty('platformCampaignId');
  });

  it('parses the real ad_ids[] plural shape from ad/create/', async () => {
    adPlural = true;
    const out = await adapter('tr-1').publishAd(args('tbrief-PLURAL'));
    expect(out.outcome).toBe('published');
    if (out.outcome === 'published') expect(out.platformAdId).toMatch(/^ad-\d+$/); // taken from data.ad_ids[0]
  });

  it('returns no_connection when the acting user has no TikTok connection', async () => {
    const out = await adapter('tr-1', 'u-none').publishAd(args('tbrief-NONE'));
    expect(out.outcome).toBe('no_connection');
  });

  it('CRITICAL: a caller cannot override the broker Access-Token via any case-variant in extraHeaders', async () => {
    const base = process.env.OPENWOP_TIKTOK_ADS_API_BASE!;
    const r = await brokeredPost(
      { storage, tenantId: 'tt', runId: 'tr-1', actingUserId: 'u1', orgId: 'tt' },
      { provider: 'tiktok-ads', authScheme: 'raw', authHeaderName: 'access-token', url: `${base}/campaign/create/`, body: '{}', extraHeaders: { 'Access-Token': 'EVIL', 'access-token': 'EVIL2', 'ACCESS-TOKEN': 'EVIL3', 'X-Custom': 'ok' } },
    );
    expect(r.outcome).toBe('sent');
    const hit = hits.find((h) => h.path.endsWith('/campaign/create/'));
    expect(hit?.access).toBe('TT_TOKEN'); // the broker token wins; no EVIL variant survived the custom-name strip
    expect(hit?.extra).toBe('ok');         // a genuine custom header still passes
  });
});
