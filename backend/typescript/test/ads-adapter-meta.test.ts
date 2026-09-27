/**
 * Meta ads-dispatch adapter (ADR 0167 Phase 1; ADR 0223 production payloads) via the
 * Connections broker. Proves ctx.ads.publishAd resolves the acting user's Meta
 * Connection, creates a campaign→adset→creative→ad pipeline ALL PAUSED with the OAuth
 * token (the ad references the created adcreative; the creative is a real
 * object_story_spec page story), uploads a media asset to adimages and threads the
 * image_hash into the creative, REQUIRES pageId (fails closed missing_page_id), stamps
 * RFC 0079 provenance, is FORK-STABLE idempotent (a re-run with a NEW runId but the
 * same briefId reuses the recorded platform ids — no duplicate paid campaign; a
 * CREATIVE change mints a NEW key), rolls back a half-built campaign on a mid-pipeline
 * failure, and reports no_connection (→ the node's document fallback) when no Meta
 * connection exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter, listDispatchRecords } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

interface Hit { method: string; path: string; auth?: string; body: Record<string, unknown> }

describe('Meta ads-dispatch adapter (ADR 0167 Phase 1)', () => {
  let meta: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let idSeq = 0;
  let failOn: string | null = null; // an edge name to 500 (e.g. 'adsets') to exercise rollback

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18962, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    meta = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = req.url ?? '';
        hits.push({ method: req.method ?? '', path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} });
        const edge = path.split('/').pop() ?? '';
        if (failOn && path.endsWith(`/${failOn}`)) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'platform rejected' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        // adimages returns { images: { bytes: { hash } } } (v21), not { id }.
        if (edge === 'adimages') { res.end(JSON.stringify({ images: { bytes: { hash: `HASH-${++idSeq}` } } })); return; }
        res.end(JSON.stringify({ id: `${edge || 'obj'}-${++idSeq}` }));
      });
    });
    await new Promise<void>((r) => meta.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_META_API_BASE = `http://127.0.0.1:${(meta.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tads', provider: 'meta-ads', kind: 'bearer', secret: 'META_TOKEN', scope: 'user', userId: 'u1' });
    // Register the meta-ads provider WITH apiHosts — exactly what the RFC 0120 connection-pack
    // loader does in production (#1006: meta-ads pack declares apiHosts:['facebook.com']). Here
    // it points at the loopback test host so the cascade-delete rollback's host-pinned
    // brokeredFetch DELETE actually reaches the recorder instead of failing closed. Create-path
    // tests use brokeredPost (which never pins), so they are unaffected by this.
    registerProvider({
      id: 'meta-ads', label: 'Meta Ads', kind: 'oauth2', authFlow: 'manual', reach: 'openapi',
      scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
    });
    await storage.insertRun({ runId: 'run-1', workflowId: 'w', tenantId: 'tads', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'run-2-fork', workflowId: 'w', tenantId: 'tads', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_META_API_BASE;
    await new Promise<void>((r) => meta.close(() => r()));
  });

  beforeEach(() => { hits = []; failOn = null; });

  const adapter = (runId: string, actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tads', runId, ...(actingUserId ? { actingUserId } : {}), orgId: 'tads' });

  const args = (briefId: string) => ({
    platform: 'meta' as const, briefId, adAccountId: '12345', campaignName: 'Summer Sale',
    copy: { headline: 'Pick faster', bodyText: '40% faster checkout', ctaText: 'LEARN_MORE' },
    dailyBudgetMinor: 5000, pageId: 'page-77', landingUrl: 'https://example.com/lp',
  });

  it('creates campaign→adset→creative→ad ALL PAUSED with the token, a real page-story creative, and stamps provenance', async () => {
    const out = await adapter('run-1').publishAd(args('brief-A'));
    expect(out.outcome).toBe('published');
    if (out.outcome !== 'published') return;
    expect(out.paused).toBe(true);
    expect(out.reviewStatus).toBe('pending_review');
    expect(out.reused).toBe(false);

    // Four creates, in order; campaign/adset/ad ALL PAUSED, all Bearer-authed at the hardcoded host path.
    expect(hits.filter((h) => h.method === 'POST').map((h) => h.path.split('/').pop())).toEqual(['campaigns', 'adsets', 'adcreatives', 'ads']);
    const creates = hits.filter((h) => h.method === 'POST' && /\/(campaigns|adsets|ads)$/.test(h.path));
    for (const c of creates) {
      expect(c.auth).toBe('Bearer META_TOKEN');
      expect(c.body.status).toBe('PAUSED'); // no auto-spend — the load-bearing safety invariant
      expect(c.path).toContain('/act_12345/');
    }
    // The REAL creative (ADR 0223): a page-published link story with the copy + CTA.
    const creative = hits.find((h) => h.path.endsWith('/adcreatives'));
    expect(creative?.auth).toBe('Bearer META_TOKEN');
    const spec = creative?.body.object_story_spec as { page_id: string; link_data: Record<string, unknown> };
    expect(spec.page_id).toBe('page-77');
    expect(spec.link_data.name).toBe('Pick faster');
    expect(spec.link_data.message).toBe('40% faster checkout');
    expect(spec.link_data.link).toBe('https://example.com/lp');
    expect(spec.link_data.call_to_action).toEqual({ type: 'LEARN_MORE', value: { link: 'https://example.com/lp' } });
    // The ad references the created creative by id (no inline seam shape).
    const ad = hits.find((h) => h.path.endsWith('/ads'));
    expect((ad?.body.creative as { creative_id?: string })?.creative_id).toMatch(/^adcreatives-\d+$/);
    // No token in the result.
    expect(JSON.stringify(out)).not.toContain('META_TOKEN');
    // RFC 0079 provenance stamped.
    const meta1 = (await storage.getRun('run-1'))?.metadata as Record<string, unknown> | undefined;
    expect((meta1?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'meta-ads')).toBe(true);
  });

  it('uploads a media asset to adimages and threads the image_hash into the creative (ADR 0223 media leg)', async () => {
    const base64 = Buffer.from('png-bytes').toString('base64');
    const { token } = await storeMediaAsset('tads', { contentBase64: base64, contentType: 'image/png' });
    const out = await adapter('run-1').publishAd({ ...args('brief-MEDIA'), mediaAssetId: token });
    expect(out.outcome).toBe('published');

    // The upload leg fired first, carrying the host-resolved bytes as base64.
    expect(hits[0]?.path.endsWith('/adimages')).toBe(true);
    expect(hits[0]?.body.bytes).toBe(base64);
    expect(hits[0]?.auth).toBe('Bearer META_TOKEN');
    // The returned image_hash landed in the creative's link_data.
    const creative = hits.find((h) => h.path.endsWith('/adcreatives'));
    const spec = creative?.body.object_story_spec as { link_data: Record<string, unknown> };
    expect(spec.link_data.image_hash).toMatch(/^HASH-\d+$/);
    // No creative bytes in the result.
    expect(JSON.stringify(out)).not.toContain(base64);
  });

  it('fails closed missing_page_id when no pageId is supplied (zero platform calls)', async () => {
    const { pageId: _omit, ...noPage } = args('brief-NOPAGE');
    const out = await adapter('run-1').publishAd(noPage);
    expect(out).toEqual({ outcome: 'failed', error: 'missing_page_id' });
    expect(hits).toHaveLength(0);
  });

  it('fails closed media_asset_not_found for an unknown/foreign media asset (zero platform calls)', async () => {
    const out = await adapter('run-1').publishAd({ ...args('brief-BADMEDIA'), mediaAssetId: 'masset:nope' });
    expect(out).toEqual({ outcome: 'failed', error: 'media_asset_not_found' });
    expect(hits).toHaveLength(0);
  });

  it('a CREATIVE change (different pageId) mints a NEW idempotency key — no false reuse', async () => {
    const first = await adapter('run-1').publishAd(args('brief-KEY'));
    expect(first.outcome).toBe('published');
    hits = [];
    const changed = await adapter('run-1').publishAd({ ...args('brief-KEY'), pageId: 'page-88' });
    expect(changed.outcome).toBe('published');
    if (changed.outcome !== 'published' || first.outcome !== 'published') return;
    expect(changed.reused).toBe(false);
    expect(changed.platformCampaignId).not.toBe(first.platformCampaignId);
    expect(hits.filter((h) => h.method === 'POST' && /\/campaigns$/.test(h.path))).toHaveLength(1);
  });

  it('FORK-STABLE idempotency: a re-run with a NEW runId + same briefId reuses the ids, creates NO new campaign', async () => {
    const first = await adapter('run-1').publishAd(args('brief-FORK'));
    expect(first.outcome).toBe('published');
    if (first.outcome !== 'published') return;
    hits = []; // reset the recorder

    // Simulate a :fork — different runId, identical business inputs.
    const forked = await adapter('run-2-fork').publishAd(args('brief-FORK'));
    expect(forked.outcome).toBe('published');
    if (forked.outcome !== 'published') return;
    expect(forked.reused).toBe(true);
    expect(forked.platformCampaignId).toBe(first.platformCampaignId);
    expect(forked.platformAdSetId).toBe(first.platformAdSetId);
    expect(forked.platformAdId).toBe(first.platformAdId);
    // The platform was NOT called again — no duplicate paid campaign.
    expect(hits.filter((h) => h.method === 'POST' && /\/campaigns$/.test(h.path))).toHaveLength(0);
  });

  it('ADR 0245: operator targeting is forwarded verbatim onto the adset; a targeting CHANGE mints a new dispatch but a REORDER does not', async () => {
    hits = [];
    const targeting = { geo_locations: { countries: ['US'] }, age_min: 25, age_max: 45 };
    const out = await adapter('run-tgt').publishAd({ ...args('brief-TGT'), targeting });
    expect(out.outcome).toBe('published');
    // The adset create carries the operator's targeting verbatim.
    const adset = hits.find((h) => h.method === 'POST' && h.path.endsWith('/adsets'));
    expect(adset?.body.targeting).toEqual(targeting);

    // A REORDER of the same targeting keys is idempotent (canonical key) — reuses the dispatch.
    hits = [];
    const reordered = await adapter('run-tgt2').publishAd({ ...args('brief-TGT'), targeting: { age_max: 45, age_min: 25, geo_locations: { countries: ['US'] } } });
    expect(reordered.outcome).toBe('published');
    if (reordered.outcome !== 'published') return;
    expect(reordered.reused).toBe(true); // same idem key → no new campaign
    expect(hits.filter((h) => h.method === 'POST' && /\/campaigns$/.test(h.path))).toHaveLength(0);

    // A genuine targeting CHANGE (different audience) mints a NEW dispatch.
    hits = [];
    const changed = await adapter('run-tgt3').publishAd({ ...args('brief-TGT'), targeting: { geo_locations: { countries: ['CA'] } } });
    expect(changed.outcome).toBe('published');
    if (changed.outcome !== 'published') return;
    expect(changed.reused).toBe(false);
    expect(hits.filter((h) => h.method === 'POST' && /\/campaigns$/.test(h.path))).toHaveLength(1);
  });

  it('ADS-2: a concurrent double-submit yields exactly ONE ledger row; the loser reuses the winner ids (consistent output)', async () => {
    hits = [];
    // Two simultaneous publishes of the SAME (briefId → idemKey). The post-create
    // compareAndSwap(null,…) makes the ledger single-canonical: one row wins, the
    // loser returns the winner's ids with reused:true.
    const [a, b] = await Promise.all([
      adapter('run-A').publishAd(args('brief-RACE')),
      adapter('run-B').publishAd(args('brief-RACE')),
    ]);
    expect(a.outcome).toBe('published');
    expect(b.outcome).toBe('published');
    if (a.outcome !== 'published' || b.outcome !== 'published') return;
    // Exactly one is the fresh winner; the other reused the winning row.
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1);
    // Both RETURN the winner's ids — no divergent output to callers.
    expect(a.platformCampaignId).toBe(b.platformCampaignId);
    expect(a.platformAdSetId).toBe(b.platformAdSetId);
    expect(a.platformAdId).toBe(b.platformAdId);
    // The LEDGER holds exactly one canonical row for the brief.
    const rows = await listDispatchRecords('tads', 'brief-RACE');
    expect(rows).toHaveLength(1);
    expect(rows[0].platformCampaignId).toBe(a.platformCampaignId);
  });

  it('fails closed on a mid-pipeline error; the created campaign was PAUSED (no spend) and the cascade-delete rollback fires', async () => {
    failOn = 'adsets';
    const out = await adapter('run-1').publishAd(args('brief-ROLLBACK'));
    expect(out.outcome).toBe('failed');
    // The campaign was created (and PAUSED) before the adset failed.
    const campaignCreate = hits.find((h) => h.method === 'POST' && /\/campaigns$/.test(h.path));
    expect(campaignCreate).toBeTruthy();
    expect(campaignCreate?.body.status).toBe('PAUSED'); // no spend regardless of cleanup
    // END-TO-END cascade-delete (ADR 0167 × RFC 0120 #1006): now that meta-ads declares
    // apiHosts, the host-pinned brokeredFetch DELETE is permitted to the API host and ACTUALLY
    // fires — exactly ONE DELETE, targeting the orphaned campaign object (adset was never
    // created, so nothing else to clean). Pre-#1006 (no apiHosts) this no-op'd, PAUSED-safe.
    const deletes = hits.filter((h) => h.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.path).toMatch(/\/campaigns-\d+$/);
    expect(deletes[0]?.auth).toBe('Bearer META_TOKEN'); // the broker injected the token on the cleanup call too
    // A failed dispatch leaves NO idempotency record → a corrected retry can proceed.
    expect(out).not.toHaveProperty('platformCampaignId');
  });

  it('returns no_connection (→ document fallback) when the acting user has no Meta connection', async () => {
    const out = await adapter('run-1', 'u-no-conn').publishAd(args('brief-NONE'));
    expect(out.outcome).toBe('no_connection');
  });

  it('R2 CO-SP-6: the ledger cap TOMBSTONES past-cap rows — idempotency and existence survive, only display extras are stripped', async () => {
    // The `dispatched` collection is BOTH the UI ledger and the fork-stable
    // idempotency map. The old trim DELETED past-cap rows, so a replay of an
    // old brief re-created a real platform campaign and the row vanished from
    // the Launch state panel. Cross the cap through the REAL publish path.
    process.env.OPENWOP_ADS_DISPATCH_LEDGER_CAP = '3';
    try {
      const briefs = ['brief-CAP-1', 'brief-CAP-2', 'brief-CAP-3', 'brief-CAP-4', 'brief-CAP-5'];
      for (const b of briefs) {
        const out = await adapter('run-1').publishAd(args(b));
        expect(out.outcome).toBe('published');
      }
      // Every dispatch is still LISTED — none vanished at the cap.
      const rows = (await Promise.all(briefs.map((b) => listDispatchRecords('tads', b)))).flat();
      expect(rows.filter((r) => briefs.includes(r.briefId ?? ''))).toHaveLength(5);
      // The cap bit: some rows are tombstones (platform ids kept, display
      // extras stripped). createdAt can tie within the loop, so assert counts,
      // not identities (the email-R2 tie lesson).
      const full = rows.filter((r) => r.dailyBudgetMinor !== undefined);
      const tombstoned = rows.filter((r) => r.dailyBudgetMinor === undefined);
      expect(full.length).toBeLessThanOrEqual(3);
      expect(tombstoned.length).toBeGreaterThanOrEqual(2);
      for (const r of tombstoned) {
        expect(r.platformCampaignId).toMatch(/^campaigns-\d+$/);
        expect(r.campaignName).toBeUndefined();
        expect(r.adAccountId).toBeUndefined();
      }
      // THE invariant: re-publishing EVERY brief — including tombstoned ones —
      // reuses the recorded ids and makes ZERO new platform campaign creates.
      hits = [];
      for (const b of briefs) {
        const again = await adapter('run-2-fork').publishAd(args(b));
        expect(again.outcome).toBe('published');
        if (again.outcome === 'published') expect(again.reused).toBe(true);
      }
      expect(hits.filter((h) => h.method === 'POST' && /\/campaigns$/.test(h.path))).toHaveLength(0);
    } finally {
      delete process.env.OPENWOP_ADS_DISPATCH_LEDGER_CAP;
    }
  });
});
