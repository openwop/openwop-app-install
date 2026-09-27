/**
 * LinkedIn ads-dispatch adapter (ADR 0223 — the NEW strategy) via the Connections
 * broker. Proves ctx.ads.publishAd creates the adCampaignGroups (DRAFT) →
 * adCampaigns (PAUSED) → creatives (intendedStatus PAUSED) versioned-REST pipeline
 * with the OAuth Bearer token + the LinkedIn-Version / X-Restli-Protocol-Version
 * headers on every call; extracts the created ids from the `x-restli-id`
 * (legacy `x-linkedin-id`) RESPONSE HEADER (LinkedIn returns no id in the body);
 * chains the urns between steps; is FORK-STABLE idempotent on the 'linkedin'
 * platform key; fails closed on a mid-pipeline rejection (no rollback — objects
 * left DRAFT/PAUSED = no spend, no idempotency record); and reports no_connection
 * (→ the node's document fallback) when no LinkedIn connection exists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

interface Hit { method: string; path: string; auth?: string; liVersion?: string; restli?: string; body: Record<string, unknown> }

describe('LinkedIn ads-dispatch adapter (ADR 0223)', () => {
  let li: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let seq = 0;
  let failOn: string | null = null; // a resource name to reject (e.g. 'adCampaigns')
  let legacyIdHeader = false; // respond with x-linkedin-id instead of x-restli-id

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18967, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    li = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = req.url ?? '';
        hits.push({
          method: req.method ?? '', path, auth: req.headers.authorization,
          liVersion: req.headers['linkedin-version'] as string,
          restli: req.headers['x-restli-protocol-version'] as string,
          body: raw ? JSON.parse(raw) : {},
        });
        const resource = path.split('/').pop() ?? '';
        if (failOn && resource === failOn) {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'rejected', status: 422 }));
          return;
        }
        // Rest.li create: the id rides the RESPONSE HEADER, the body is empty.
        const idHeader = legacyIdHeader ? 'x-linkedin-id' : 'x-restli-id';
        res.writeHead(201, { 'content-type': 'application/json', [idHeader]: `li-${++seq}` });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => li.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_LINKEDIN_ADS_API_BASE = `http://127.0.0.1:${(li.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tli', provider: 'linkedin-ads', kind: 'bearer', secret: 'LI_TOKEN', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'lr-1', workflowId: 'w', tenantId: 'tli', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'lr-2-fork', workflowId: 'w', tenantId: 'tli', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_LINKEDIN_ADS_API_BASE;
    await new Promise<void>((r) => li.close(() => r()));
  });

  beforeEach(() => { hits = []; failOn = null; legacyIdHeader = false; });

  const adapter = (runId: string, actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tli', runId, ...(actingUserId ? { actingUserId } : {}), orgId: 'tli' });
  const args = (briefId: string) => ({
    platform: 'linkedin' as const, briefId, adAccountId: '509876543', campaignName: 'LI Launch',
    copy: { headline: 'Pick faster', description: '40% faster checkout', bodyText: 'Checkout in one tap' },
    dailyBudgetMinor: 5000, landingUrl: 'https://example.com/lp',
  });

  it('creates campaignGroup (DRAFT) → campaign (PAUSED) → creative (intendedStatus PAUSED), versioned headers + Bearer on every call, ids from the x-restli-id header', async () => {
    const out = await adapter('lr-1').publishAd(args('lbrief-A'));
    expect(out.outcome).toBe('published');
    if (out.outcome !== 'published') return;
    expect(out.platform).toBe('linkedin');
    expect(out.paused).toBe(true);
    expect(out.reused).toBe(false);

    // Three creates, in order, under /rest/*, with the versioned-REST headers + broker Bearer.
    expect(hits.map((h) => h.path)).toEqual(['/rest/adCampaignGroups', '/rest/adCampaigns', '/rest/creatives']);
    for (const h of hits) {
      expect(h.method).toBe('POST');
      expect(h.auth).toBe('Bearer LI_TOKEN');           // per-user OAuth, broker-resolved
      expect(h.liVersion).toBe('202506');                // LinkedIn-Version month pin
      expect(h.restli).toBe('2.0.0');                    // X-Restli-Protocol-Version
    }
    // Non-spending created states are LITERALS in the mapper.
    const [group, campaign, creative] = hits;
    expect(group!.body.status).toBe('DRAFT');
    expect(group!.body.account).toBe('urn:li:sponsoredAccount:509876543');
    expect(campaign!.body.status).toBe('PAUSED');
    expect(campaign!.body.campaignGroup).toBe('urn:li:sponsoredCampaignGroup:li-1'); // header-id chained as a urn
    expect(campaign!.body.dailyBudget).toEqual({ amount: '50.00', currencyCode: 'USD' }); // 5000 minor → "50.00" major
    expect(creative!.body.intendedStatus).toBe('PAUSED');
    expect(creative!.body.campaign).toBe('urn:li:sponsoredCampaign:li-2');
    expect(creative!.body.content).toEqual({ textAd: { headline: 'Pick faster', description: 'Checkout in one tap', landingPage: 'https://example.com/lp' } });
    // Ids extracted from the response HEADER (the body was empty).
    expect(out.platformCampaignId).toBe('li-1');
    expect(out.platformAdSetId).toBe('li-2');
    expect(out.platformAdId).toBe('li-3');
    // No token in the result; RFC 0079 provenance stamped.
    expect(JSON.stringify(out)).not.toContain('LI_TOKEN');
    const meta = (await storage.getRun('lr-1'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'linkedin-ads')).toBe(true);
  });

  it('also accepts the legacy x-linkedin-id response header', async () => {
    legacyIdHeader = true;
    const out = await adapter('lr-1').publishAd(args('lbrief-LEGACY'));
    expect(out.outcome).toBe('published');
    if (out.outcome === 'published') expect(out.platformCampaignId).toMatch(/^li-\d+$/);
  });

  it('FORK-STABLE idempotency on the linkedin key: new runId + same briefId reuses ids, no new create', async () => {
    const first = await adapter('lr-1').publishAd(args('lbrief-FORK'));
    expect(first.outcome).toBe('published');
    if (first.outcome !== 'published') return;
    hits = [];
    const forked = await adapter('lr-2-fork').publishAd(args('lbrief-FORK'));
    expect(forked.outcome).toBe('published');
    if (forked.outcome !== 'published') return;
    expect(forked.reused).toBe(true);
    expect(forked.platform).toBe('linkedin');
    expect(forked.platformCampaignId).toBe(first.platformCampaignId);
    expect(hits).toHaveLength(0); // the platform was NOT called again
  });

  it('fails closed on a mid-pipeline rejection: no rollback (objects left DRAFT/PAUSED — no spend), no idempotency record', async () => {
    failOn = 'adCampaigns';
    const out = await adapter('lr-1').publishAd(args('lbrief-ERR'));
    expect(out.outcome).toBe('failed');
    if (out.outcome === 'failed') expect(out.error).toBe('rejected'); // the platform message surfaced
    expect(hits.filter((h) => h.method === 'DELETE')).toHaveLength(0); // no rollback calls
    expect(out).not.toHaveProperty('platformCampaignId');
    // No idem record → a corrected retry proceeds with a fresh create.
    hits = []; failOn = null;
    const retry = await adapter('lr-1').publishAd(args('lbrief-ERR'));
    expect(retry.outcome).toBe('published');
    if (retry.outcome === 'published') expect(retry.reused).toBe(false);
  });

  it('returns no_connection (→ document fallback) when the acting user has no LinkedIn connection', async () => {
    const out = await adapter('lr-1', 'u-no-conn').publishAd(args('lbrief-NONE'));
    expect(out.outcome).toBe('no_connection');
  });
});
