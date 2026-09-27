/**
 * Google Ads dispatch adapter (ADR 0167 Phase 2; ADR 0223 production payloads) via
 * the Connections broker. Proves ctx.ads.publishAd creates the
 * budget→campaign→adGroup→ad :mutate pipeline ALL PAUSED with BOTH the per-user OAuth
 * Bearer token (broker-resolved) AND the app-level developer-token (operator env
 * config, via brokeredPost extraHeaders); carries the v18 SEARCH network settings;
 * REQUIRES landingUrl (finalUrls is mandatory — fails closed missing_landing_url);
 * fails closed with no developer-token; is fork-stable idempotent on the 'google'
 * platform key; completes the ADR 0217 Customer Match deferral (userLists:mutate →
 * offlineUserDataJobs create → :addOperations in ≤20-identifier batches → :run); and
 * — the CRITICAL guard — a caller cannot override the broker's Authorization via any
 * case-variant in extraHeaders.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { brokeredPost } from '../src/host/brokeredEgress.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { resolveApproval } from '../src/host/approvalService.js';

interface Hit { method: string; path: string; auth?: string; dev?: string; extra?: string; body: Record<string, unknown> }

describe('Google Ads dispatch adapter (ADR 0167 Phase 2)', () => {
  let g: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let seq = 0;
  let failOn: string | null = null;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV_TOKEN';
    const app = await createApp({ port: 18963, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    g = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = req.url ?? '';
        hits.push({ method: req.method ?? '', path, auth: req.headers.authorization, dev: req.headers['developer-token'] as string, extra: req.headers['x-custom'] as string, body: raw ? JSON.parse(raw) : {} });
        const resource = (path.match(/\/customers\/\d+\/([a-zA-Z]+):mutate/) ?? [])[1] ?? 'obj';
        if (failOn && resource === failOn) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'rejected' } })); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        // Customer Match legs (ADR 0217 → ADR 0223): job create returns a top-level
        // resourceName; addOperations/run return non-mutate shapes.
        if (path.includes('offlineUserDataJobs:create')) { res.end(JSON.stringify({ resourceName: `customers/777/offlineUserDataJobs/${++seq}` })); return; }
        if (path.endsWith(':addOperations')) { res.end(JSON.stringify({})); return; }
        if (path.endsWith(':run')) { res.end(JSON.stringify({ name: `op-${++seq}` })); return; }
        res.end(JSON.stringify({ results: [{ resourceName: `customers/777/${resource}/${++seq}` }] }));
      });
    });
    await new Promise<void>((r) => g.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_GOOGLE_ADS_API_BASE = `http://127.0.0.1:${(g.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tg', provider: 'google-ads', kind: 'bearer', secret: 'GOOG_OAUTH', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'gr-1', workflowId: 'w', tenantId: 'tg', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    await storage.insertRun({ runId: 'gr-2-fork', workflowId: 'w', tenantId: 'tg', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
    delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
    await new Promise<void>((r) => g.close(() => r()));
  });

  beforeEach(() => { hits = []; failOn = null; });

  const adapter = (runId: string, actingUserId = 'u1') =>
    makeAdsAdapter({ storage, tenantId: 'tg', runId, ...(actingUserId ? { actingUserId } : {}), orgId: 'tg' });
  const args = (briefId: string) => ({ platform: 'google' as const, briefId, adAccountId: '123-456-7890', campaignName: 'Q3 Search', landingUrl: 'https://example.com/lp', copy: { headline: 'Pick faster', description: '40% faster checkout' }, dailyBudgetMinor: 5000 });
  const create = (h: Hit) => (h.body.operations as Array<{ create: Record<string, any> }>)[0].create;

  it('creates budget→campaign→adGroup→ad :mutate ALL PAUSED, with Bearer + developer-token headers', async () => {
    const out = await adapter('gr-1').publishAd(args('gbrief-A'));
    expect(out.outcome).toBe('published');
    if (out.outcome !== 'published') return;
    expect(out.platform).toBe('google');
    expect(out.paused).toBe(true);

    const mutates = hits.filter((h) => h.method === 'POST' && /:mutate$/.test(h.path));
    expect(mutates.map((h) => (h.path.match(/\/([a-zA-Z]+):mutate/) ?? [])[1])).toEqual(['campaignBudgets', 'campaigns', 'adGroups', 'adGroupAds']);
    for (const m of mutates) {
      expect(m.auth).toBe('Bearer GOOG_OAUTH');     // per-user OAuth, broker-resolved
      expect(m.dev).toBe('DEV_TOKEN');               // app-level operator config via extraHeaders
      expect(m.path).toContain('/customers/1234567890/'); // non-digits stripped from the account id
    }
    // campaign / adGroup / adGroupAd creates are PAUSED (budget has no status).
    const statuses = mutates.filter((m) => /campaigns:|adGroups:|adGroupAds:/.test(m.path)).map((m) => create(m).status);
    expect(statuses).toEqual(['PAUSED', 'PAUSED', 'PAUSED']);
    // The campaign carries the v18 SEARCH channel + explicit network settings (ADR 0223).
    const campaignCreate = create(mutates.find((m) => /campaigns:mutate/.test(m.path))!);
    expect(campaignCreate.advertisingChannelType).toBe('SEARCH');
    expect(campaignCreate.networkSettings).toEqual({ targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false });
    // The responsive search ad meets Google's minimums (≥3 headlines, ≥2 descriptions) + finalUrls.
    const adCreate = create(mutates.find((m) => /adGroupAds:mutate/.test(m.path))!);
    expect(adCreate.ad.responsiveSearchAd.headlines.length).toBeGreaterThanOrEqual(3);
    expect(adCreate.ad.responsiveSearchAd.descriptions.length).toBeGreaterThanOrEqual(2);
    expect(adCreate.ad.finalUrls).toEqual(['https://example.com/lp']);
    expect(JSON.stringify(out)).not.toContain('GOOG_OAUTH');
    expect(JSON.stringify(out)).not.toContain('DEV_TOKEN');
    const meta = (await storage.getRun('gr-1'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'google-ads')).toBe(true);
  });

  it('FORK-STABLE idempotency on the google key: new runId + same briefId reuses ids, no new mutate', async () => {
    const first = await adapter('gr-1').publishAd(args('gbrief-FORK'));
    expect(first.outcome).toBe('published');
    if (first.outcome !== 'published') return;
    hits = [];
    const forked = await adapter('gr-2-fork').publishAd(args('gbrief-FORK'));
    expect(forked.outcome).toBe('published');
    if (forked.outcome !== 'published') return;
    expect(forked.reused).toBe(true);
    expect(forked.platform).toBe('google'); // the Phase-1 prior.platform fix
    expect(forked.platformCampaignId).toBe(first.platformCampaignId);
    expect(hits.filter((h) => /:mutate$/.test(h.path))).toHaveLength(0);
  });

  it('fails closed missing_landing_url without a landing URL (finalUrls is mandatory) — zero calls', async () => {
    const { landingUrl: _omit, ...noUrl } = args('gbrief-NOURL');
    const out = await adapter('gr-1').publishAd(noUrl);
    expect(out).toEqual({ outcome: 'failed', error: 'missing_landing_url' });
    expect(hits).toHaveLength(0);
  });

  it('Customer Match (ADR 0217 deferral closed): userLists:mutate → offlineUserDataJobs create → :addOperations (≤20/op) → :run', async () => {
    const memberHashes = Array.from({ length: 45 }, (_, i) => i.toString(16).padStart(64, '0'));
    const syncArgs = { platform: 'google' as const, adAccountId: '123-456-7890', audienceName: 'Customers', memberHashes, membersKey: 'k'.repeat(64) };
    const a = adapter('gr-1');

    // PII-adjacent default gate: first call requires approval (nothing dispatched)…
    const gated = await a.syncAudience(syncArgs);
    expect(gated.outcome).toBe('requires_approval');
    expect(hits).toHaveLength(0);
    await resolveApproval((gated as { approvalId: string }).approvalId, { status: 'approved' });

    // …approved → the FULL member-upload pipeline runs.
    const out = await a.syncAudience(syncArgs);
    expect(out.outcome).toBe('synced');
    if (out.outcome !== 'synced') return;
    expect(out.uploaded).toBe(45);
    expect(out.platformAudienceId).toMatch(/^customers\/777\/userLists\/\d+$/);

    const paths = hits.map((h) => h.path.replace(/\/customers\/1234567890\//, '').replace(/customers\/777\//, ''));
    expect(paths[0]).toBe('userLists:mutate');
    expect(paths[1]).toBe('offlineUserDataJobs:create');
    expect(paths[2]).toMatch(/offlineUserDataJobs\/\d+:addOperations$/);
    expect(paths[3]).toMatch(/offlineUserDataJobs\/\d+:run$/);
    for (const h of hits) {
      expect(h.auth).toBe('Bearer GOOG_OAUTH');
      expect(h.dev).toBe('DEV_TOKEN');
    }
    // The list is CRM-based CONTACT_INFO; the job binds CUSTOMER_MATCH_USER_LIST to it.
    const listOp = (hits[0]!.body.operations as Array<{ create: Record<string, unknown> }>)[0]!.create;
    expect(listOp.crmBasedUserList).toEqual({ uploadKeyType: 'CONTACT_INFO' });
    const job = hits[1]!.body.job as { type: string; customerMatchUserListMetadata: { userList: string } };
    expect(job.type).toBe('CUSTOMER_MATCH_USER_LIST');
    expect(job.customerMatchUserListMetadata.userList).toBe(out.platformAudienceId);
    // 45 hashed emails → 3 operations of 20/20/5 identifiers, hashedEmail-keyed (never raw).
    const ops = hits[2]!.body.operations as Array<{ create: { userIdentifiers: Array<{ hashedEmail: string }> } }>;
    expect(ops.map((o) => o.create.userIdentifiers.length)).toEqual([20, 20, 5]);
    expect(ops[0]!.create.userIdentifiers[0]).toEqual({ hashedEmail: memberHashes[0] });
  });

  it('fails closed (no call) when the operator developer-token is unset', async () => {
    const saved = process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
    delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
    try {
      const out = await adapter('gr-1').publishAd(args('gbrief-NOTOK'));
      expect(out.outcome).toBe('failed');
      if (out.outcome === 'failed') expect(out.error).toBe('no_developer_token');
      expect(hits).toHaveLength(0); // never dispatched a blank-header call
    } finally { process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = saved; }
  });

  it('returns no_connection when the acting user has no Google connection', async () => {
    const out = await adapter('gr-1', 'u-none').publishAd(args('gbrief-NONE'));
    expect(out.outcome).toBe('no_connection');
  });

  it('CRITICAL: a caller cannot override the broker Authorization via any case-variant in extraHeaders', async () => {
    const base = process.env.OPENWOP_GOOGLE_ADS_API_BASE!;
    const r = await brokeredPost(
      { storage, tenantId: 'tg', runId: 'gr-1', actingUserId: 'u1', orgId: 'tg' },
      { provider: 'google-ads', url: `${base}/customers/777/x:mutate`, body: '{}', extraHeaders: { Authorization: 'Bearer EVIL', authorization: 'EVIL2', AUTHORIZATION: 'EVIL3', 'content-type': 'text/evil', 'X-Custom': 'ok' } },
    );
    expect(r.outcome).toBe('sent');
    const hit = hits.find((h) => h.path.endsWith('/x:mutate'));
    expect(hit?.auth).toBe('Bearer GOOG_OAUTH'); // the broker token wins; no EVIL variant survived
    expect(hit?.extra).toBe('ok');                // a genuine custom header DOES pass through
  });
});
