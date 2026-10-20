/**
 * ADR 0907 D3 — account-scope metrics readers (Meta insights, Google Ads
 * search), against a local server that replays recorded response shapes. No
 * real ad platform is called and no real token is used.
 *
 * Pins: paging to exhaustion (Meta `after` cursor, Google `pageToken`); the
 * response's absolute `paging.next` URL is NEVER followed (host pinning); the
 * page cap reports `truncated`; conversions/revenue come from the configured
 * Meta action types and Google's conversions/conversions_value; money in major
 * units; a 429 is `rate_limited` with Retry-After; the circuit breaker wraps
 * reads; bad dates never reach the GAQL string.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeAdsAdapter, ACCOUNT_METRICS_MAX_PAGES, LINKEDIN_ANALYTICS_MAX_ELEMENTS } from '../src/host/adsAdapter.js';
import { __resetConnectionsStore, createSecretConnection, circuitStatus } from '../src/features/connections/connectionsService.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';

interface Hit { method: string; path: string; rawQuery: string; query: URLSearchParams; auth?: string; dev?: string; access?: string; liVersion?: string; body: Record<string, unknown> }

const T = 'acct-metrics-t';

describe('ADR 0907 D3 — getAccountMetrics', () => {
  let srv: http.Server;
  let storage: Storage;
  let hits: Hit[] = [];
  let handler: (h: Hit) => { status?: number; headers?: Record<string, string>; body: unknown };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN = 'DEV_TOKEN';
    const app = await createApp({ port: 18994, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const hit: Hit = { method: req.method ?? '', path: u.pathname, rawQuery: (req.url ?? '').split('?')[1] ?? '', query: u.searchParams, auth: req.headers.authorization, dev: req.headers['developer-token'] as string, access: req.headers['access-token'] as string, liVersion: req.headers['linkedin-version'] as string, body: raw ? JSON.parse(raw) : {} };
        hits.push(hit);
        const out = handler(hit);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    process.env.OPENWOP_META_API_BASE = `${base}/meta`;
    process.env.OPENWOP_GOOGLE_ADS_API_BASE = `${base}/google`;
    process.env.OPENWOP_TIKTOK_ADS_API_BASE = `${base}/tiktok`;
    process.env.OPENWOP_LINKEDIN_ADS_API_BASE = `${base}/linkedin`;
    for (const id of ['meta-ads', 'google-ads', 'tiktok-ads', 'linkedin-ads']) {
      registerProvider({ id, label: id, kind: 'oauth2', authFlow: 'manual', reach: 'openapi', scopes: { read: [] }, refreshable: true, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
    }
    await createSecretConnection({ tenantId: T, provider: 'meta-ads', kind: 'bearer', secret: 'META_TOKEN', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: T, provider: 'google-ads', kind: 'bearer', secret: 'GOOG_TOKEN', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: T, provider: 'tiktok-ads', kind: 'bearer', secret: 'TT_TOKEN', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: T, provider: 'linkedin-ads', kind: 'bearer', secret: 'LI_TOKEN', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'am-run', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_META_API_BASE;
    delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
    delete process.env.OPENWOP_TIKTOK_ADS_API_BASE;
    delete process.env.OPENWOP_LINKEDIN_ADS_API_BASE;
    delete process.env.OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN;
    delete process.env.OPENWOP_ADS_VERIFIED_READERS;
    await new Promise<void>((r) => srv.close(() => r()));
  });

  beforeEach(() => { hits = []; delete process.env.OPENWOP_ADS_VERIFIED_READERS; });

  const adapter = (tenantId = T) => makeAdsAdapter({ storage, tenantId, runId: 'am-run', actingUserId: 'u1', orgId: tenantId });

  // A Meta insights page in the documented shape (daily rows, actions[] lists).
  const metaRow = (date: string, campaign: string, purchases: string, value: string) => ({
    campaign_id: campaign, campaign_name: `Campaign ${campaign}`, impressions: '1000', clicks: '40', spend: '25.50',
    actions: [{ action_type: 'link_click', value: '40' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: purchases }, { action_type: 'lead', value: '2' }],
    action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: value }],
    account_currency: 'EUR', date_start: date, date_stop: date,
  });

  it('Meta: pages by the `after` cursor to exhaustion and ignores the absolute paging.next URL', async () => {
    handler = (h) => {
      if (!h.query.get('after')) {
        return { body: { data: [metaRow('2026-10-10', '11', '3', '90.00')], paging: { cursors: { after: 'CUR1' }, next: 'https://evil.example/steal?after=CUR1' } } };
      }
      return { body: { data: [metaRow('2026-10-11', '11', '1', '30.00')], paging: { cursors: { after: 'CUR2' } } } }; // no `next`: last page
    };
    const r = await adapter().getAccountMetrics({ platform: 'meta', adAccountId: 'act_555', level: 'campaign', since: '2026-10-10', until: '2026-10-11' });
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') return;
    expect(r).toMatchObject({ pages: 2, truncated: false });
    expect(hits.map((h) => h.path)).toEqual(['/meta/act_555/insights', '/meta/act_555/insights']);
    expect(hits[1].query.get('after')).toBe('CUR1');
    expect(hits[0].auth).toBe('Bearer META_TOKEN');
    expect(hits[0].query.get('level')).toBe('campaign');
    expect(hits[0].query.get('time_increment')).toBe('1');
    expect(JSON.parse(hits[0].query.get('time_range')!)).toEqual({ since: '2026-10-10', until: '2026-10-11' });
    // Default action types: purchase + lead + complete_registration (3 + 2 = 5), revenue from purchase values.
    expect(r.rows[0]).toEqual({ date: '2026-10-10', campaignId: '11', campaignName: 'Campaign 11', impressions: 1000, clicks: 40, spend: 25.5, conversions: 5, revenue: 90, currency: 'EUR' });
  });

  it('Meta: the configured action types decide what counts as a conversion', async () => {
    handler = () => ({ body: { data: [metaRow('2026-10-10', '11', '3', '90.00')], paging: {} } });
    const r = await adapter().getAccountMetrics({ platform: 'meta', adAccountId: '555', level: 'campaign', since: '2026-10-10', until: '2026-10-10', conversionActionTypes: ['lead'] });
    expect(r.outcome === 'ok' && r.rows[0]).toMatchObject({ conversions: 2, revenue: 0 });
    expect(hits[0].path).toBe('/meta/act_555/insights'); // a bare account id is normalised to act_<n>
  });

  it('Meta: stops at the page cap and SAYS so (truncated), keeping the rows read', async () => {
    let n = 0;
    handler = () => ({ body: { data: [metaRow('2026-10-10', String(++n), '1', '1')], paging: { cursors: { after: `C${n}` }, next: 'more' } } });
    const r = await adapter().getAccountMetrics({ platform: 'meta', adAccountId: 'act_1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' });
    expect(r).toMatchObject({ outcome: 'ok', truncated: true, pages: ACCOUNT_METRICS_MAX_PAGES });
    expect(r.outcome === 'ok' && r.rows).toHaveLength(ACCOUNT_METRICS_MAX_PAGES);
  });

  it('Meta: a 429 is rate_limited with Retry-After, not a failure that reads as no data', async () => {
    handler = () => ({ status: 429, headers: { 'retry-after': '120' }, body: { error: { message: 'slow down' } } });
    const r = await adapter('acct-metrics-429').getAccountMetrics({ platform: 'meta', adAccountId: 'act_1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' });
    expect(r).toEqual({ outcome: 'no_connection' }); // a different tenant has no connection — the broker answers first
    const own = await adapter().getAccountMetrics({ platform: 'meta', adAccountId: 'act_1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' });
    expect(own).toEqual({ outcome: 'rate_limited', retryAfterS: 120 });
  });

  it('Google: pages by pageToken, converts micros, reads conversions + conversions_value + currency', async () => {
    handler = (h) => {
      const page2 = h.body.pageToken === 'TOK2';
      const result = (date: string) => ({
        campaign: { id: '901', name: 'Search Brand' }, segments: { date },
        metrics: { impressions: '2000', clicks: '80', costMicros: '12340000', conversions: 4.5, conversionsValue: 210.25 },
        customer: { currencyCode: 'USD' },
      });
      return { body: page2 ? { results: [result('2026-10-11')] } : { results: [result('2026-10-10')], nextPageToken: 'TOK2' } };
    };
    const r = await adapter().getAccountMetrics({ platform: 'google', adAccountId: '123-456-7890', level: 'campaign', since: '2026-10-10', until: '2026-10-11' });
    expect(r).toMatchObject({ outcome: 'ok', pages: 2, truncated: false });
    expect(hits.map((h) => h.path)).toEqual(['/google/customers/1234567890/googleAds:search', '/google/customers/1234567890/googleAds:search']);
    expect(hits[0].dev).toBe('DEV_TOKEN');
    expect(hits[0].body.query).toContain("FROM campaign WHERE segments.date BETWEEN '2026-10-10' AND '2026-10-11'");
    expect(hits[0].body.query).toContain('metrics.conversions_value');
    expect(hits[1].body.pageToken).toBe('TOK2');
    expect(r.outcome === 'ok' && r.rows[0]).toEqual({ date: '2026-10-10', campaignId: '901', campaignName: 'Search Brand', impressions: 2000, clicks: 80, spend: 12.34, conversions: 4.5, revenue: 210.25, currency: 'USD' });
  });

  it('Google ad-set level reads ad_group and carries the ad-group id', async () => {
    handler = () => ({ body: { results: [{ campaign: { id: '901', name: 'S' }, adGroup: { id: '77', name: 'AG' }, segments: { date: '2026-10-10' }, metrics: {} }] } });
    const r = await adapter().getAccountMetrics({ platform: 'google', adAccountId: '1', level: 'adset', since: '2026-10-10', until: '2026-10-10' });
    expect(hits[0].body.query).toContain('FROM ad_group');
    expect(r.outcome === 'ok' && r.rows[0]).toMatchObject({ adSetId: '77', adSetName: 'AG' });
  });

  it('refuses a malformed date range before any call (GAQL takes literals)', async () => {
    handler = () => ({ body: {} });
    for (const since of ["2026-10-10' OR 1=1 --", '2026/10/10']) {
      expect(await adapter().getAccountMetrics({ platform: 'google', adAccountId: '1', level: 'campaign', since, until: '2026-10-11' })).toEqual({ outcome: 'failed', error: 'invalid_date_range' });
    }
    expect(await adapter().getAccountMetrics({ platform: 'meta', adAccountId: '1', level: 'campaign', since: '2026-10-12', until: '2026-10-11' })).toEqual({ outcome: 'failed', error: 'invalid_date_range' });
    expect(hits).toHaveLength(0);
  });

  it('tiktok/linkedin readers stay OFF (not_sandbox_verified) until the operator lists them — no call is made (ADR 0907 D2)', async () => {
    handler = () => ({ body: {} });
    for (const platform of ['tiktok', 'linkedin'] as const) {
      expect(await adapter().getAccountMetrics({ platform, adAccountId: '1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' }))
        .toEqual({ outcome: 'unsupported', platform, reason: 'not_sandbox_verified' });
    }
    expect(hits).toHaveLength(0);
  });

  it('TikTok (verified): raw Access-Token GET, BASIC campaign report, pages by total_page, revenue null (not a fake 0)', async () => {
    process.env.OPENWOP_ADS_VERIFIED_READERS = 'tiktok';
    handler = (h) => {
      const page = Number(h.query.get('page'));
      const item = (day: string) => ({ dimensions: { campaign_id: '1700', stat_time_day: `${day} 00:00:00` }, metrics: { campaign_name: 'TT Launch', spend: '15.25', impressions: '3000', clicks: '90', conversion: '6' } });
      return { body: { code: 0, message: 'OK', data: { list: [item(page === 1 ? '2026-10-10' : '2026-10-11')], page_info: { page, page_size: 1000, total_number: 2, total_page: 2 } } } };
    };
    const r = await adapter().getAccountMetrics({ platform: 'tiktok', adAccountId: '7000123', level: 'campaign', since: '2026-10-10', until: '2026-10-11' });
    expect(r).toMatchObject({ outcome: 'ok', pages: 2, truncated: false });
    expect(hits.map((h) => [h.method, h.path, h.query.get('page')])).toEqual([['GET', '/tiktok/report/integrated/get/', '1'], ['GET', '/tiktok/report/integrated/get/', '2']]);
    expect(hits[0].access).toBe('TT_TOKEN');
    expect(hits[0].auth).toBeUndefined();
    expect(Object.fromEntries(['advertiser_id', 'report_type', 'data_level', 'start_date', 'end_date'].map((k) => [k, hits[0].query.get(k)])))
      .toEqual({ advertiser_id: '7000123', report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', start_date: '2026-10-10', end_date: '2026-10-11' });
    expect(JSON.parse(hits[0].query.get('dimensions')!)).toEqual(['campaign_id', 'stat_time_day']);
    expect(r.outcome === 'ok' && r.rows[0]).toEqual({ date: '2026-10-10', campaignId: '1700', campaignName: 'TT Launch', impressions: 3000, clicks: 90, spend: 15.25, conversions: 6, revenue: null });
  });

  it('TikTok: a 200 with a non-zero code is a failure; 40100 is rate_limited', async () => {
    process.env.OPENWOP_ADS_VERIFIED_READERS = 'tiktok';
    handler = () => ({ body: { code: 40001, message: 'No permission' } });
    expect(await adapter().getAccountMetrics({ platform: 'tiktok', adAccountId: '1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' })).toEqual({ outcome: 'failed', error: 'No permission' });
    handler = () => ({ body: { code: 40100, message: 'Too many requests' } });
    expect(await adapter().getAccountMetrics({ platform: 'tiktok', adAccountId: '1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' })).toEqual({ outcome: 'rate_limited' });
  });

  it('LinkedIn (verified): Rest.li daily CAMPAIGN pivot, version header, cost in MAJOR units, revenue from conversion value', async () => {
    process.env.OPENWOP_ADS_VERIFIED_READERS = 'linkedin';
    handler = () => ({ body: { elements: [{
      dateRange: { start: { year: 2026, month: 10, day: 9 }, end: { year: 2026, month: 10, day: 9 } },
      pivotValues: ['urn:li:sponsoredCampaign:5551'], impressions: 4000, clicks: 31,
      costInLocalCurrency: '120.50', externalWebsiteConversions: 4, conversionValueInLocalCurrency: '800.00',
    }] } });
    const r = await adapter().getAccountMetrics({ platform: 'linkedin', adAccountId: '508000', level: 'campaign', since: '2026-10-09', until: '2026-10-10' });
    expect(r).toMatchObject({ outcome: 'ok', truncated: false });
    expect(hits[0].path).toBe('/linkedin/rest/adAnalytics');
    expect(hits[0].auth).toBe('Bearer LI_TOKEN');
    expect(hits[0].liVersion).toBe('202610');
    expect(hits[0].rawQuery).toContain('q=analytics&pivot=CAMPAIGN&timeGranularity=DAILY');
    expect(hits[0].rawQuery).toContain('dateRange=(start:(year:2026,month:10,day:9),end:(year:2026,month:10,day:10))');
    expect(hits[0].rawQuery).toContain('accounts=List(urn%3Ali%3AsponsoredAccount%3A508000)');
    // 120.50 stays 120.50 — MyndHyve's ÷100 (wart 10) is not ported.
    expect(r.outcome === 'ok' && r.rows[0]).toEqual({ date: '2026-10-09', campaignId: '5551', campaignName: 'LinkedIn campaign 5551', impressions: 4000, clicks: 31, spend: 120.5, conversions: 4, revenue: 800 });
    // No ad-set level on LinkedIn.
    expect(await adapter().getAccountMetrics({ platform: 'linkedin', adAccountId: '508000', level: 'adset', since: '2026-10-09', until: '2026-10-10' })).toEqual({ outcome: 'unsupported', platform: 'linkedin' });
  });

  it('LinkedIn: a response at the element cap is reported truncated', async () => {
    process.env.OPENWOP_ADS_VERIFIED_READERS = 'linkedin';
    const el = { dateRange: { start: { year: 2026, month: 10, day: 9 } }, pivotValues: ['urn:li:sponsoredCampaign:1'], impressions: 1, clicks: 0, costInLocalCurrency: '0' };
    handler = () => ({ body: { elements: Array.from({ length: LINKEDIN_ANALYTICS_MAX_ELEMENTS }, () => el) } });
    const r = await adapter().getAccountMetrics({ platform: 'linkedin', adAccountId: '1', level: 'campaign', since: '2026-10-09', until: '2026-10-09' });
    expect(r).toMatchObject({ outcome: 'ok', truncated: true });
  });

  it('the circuit breaker wraps reads: repeated 5xx opens it, then reads are refused with no call', async () => {
    handler = () => ({ status: 503, body: { error: { message: 'http_503 upstream' } } });
    for (let i = 0; i < 10 && circuitStatus(T, 'ads:google') !== 'open'; i++) {
      await adapter().getAccountMetrics({ platform: 'google', adAccountId: '1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' });
    }
    expect(circuitStatus(T, 'ads:google')).toBe('open');
    hits = [];
    expect(await adapter().getAccountMetrics({ platform: 'google', adAccountId: '1', level: 'campaign', since: '2026-10-10', until: '2026-10-10' })).toEqual({ outcome: 'failed', error: 'circuit_open' });
    expect(hits).toHaveLength(0);
  });
});
