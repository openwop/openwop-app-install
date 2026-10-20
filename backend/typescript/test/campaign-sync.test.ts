/**
 * Live ad-metrics sync (ADR 0215 / campaign gap plan C2; ADR 0907 D3):
 *   - runMetricsSync plans which ad accounts to read (the dispatch ledger's, or
 *     the connector settings' under `account` scope), claims the cooldown, reads
 *     a 7-day look-back through getAccountMetrics, and records campaign-level
 *     daily rows WITH conversions + revenue;
 *   - under `dispatched` scope, campaigns this app did not launch are dropped;
 *     a dispatched campaign keeps its launch name;
 *   - a re-pull REPLACES the earlier row for the same day (late conversions),
 *     and replaces a pre-ADR-0907 `'dispatched'`-labelled row instead of
 *     double-counting beside it;
 *   - the 15-minute cooldown blocks an immediate re-pull (durable state); a
 *     no_dispatches / no_accounts probe does not consume it (CC-SP-14);
 *   - the backfill walks 7-day windows newest-first, resumes, never moves the
 *     daily cooldown, and does not advance past a throttled window;
 *   - the routes validate platform + RBAC (a SAME-tenant non-member gets 403).
 *
 * Gap ids: AUDIT-6 (natural-key delimiter), AUDIT-7 (cooldown claimed up front),
 * CC-SP-14, CONN-1 (platform-reported date — now every row's own date).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { runMetricsSync, runMetricsBackfill, saveConnectorSettings, getSyncStatus, yesterdayIso, isoDaysBefore, CAMPAIGN_LEVEL_ADSET } from '../src/features/campaign-connectors/syncService.js';
import { listRecords, persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { computeDerived } from '../src/features/campaign-connectors/csvImport.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import type { AdsAdapter, AccountMetricsRow, GetAccountMetricsArgs, GetAccountMetricsResult } from '../src/host/adsAdapter.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('campaign-connectors');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const TENANT = 'user:campaign-sync-test';
const ORG = 'org-sync-1';

const LEDGER = (briefX: string) => [
  { platform: 'meta' as const, platformCampaignId: 'pc-1', platformAdSetId: 'as-1', platformAdId: 'ad-1', briefId: briefX, campaignName: 'Summer Launch', adAccountId: 'act_1', createdAt: '2026-07-01T00:00:00Z' },
  { platform: 'meta' as const, platformCampaignId: 'pc-2', platformAdSetId: 'as-2', platformAdId: 'ad-2', briefId: 'brief-y', campaignName: 'Winback', adAccountId: 'act_2', createdAt: '2026-07-01T00:00:00Z' },
  { platform: 'google' as const, platformCampaignId: 'pc-3', platformAdSetId: 'ag-1', platformAdId: 'ad-3', adAccountId: '123', createdAt: '2026-07-01T00:00:00Z' },
];

const row = (date: string, campaignId: string, campaignName: string, over: Partial<AccountMetricsRow> = {}): AccountMetricsRow => ({
  date, campaignId, campaignName, impressions: 1000, clicks: 50, spend: 42.5, conversions: 3, revenue: 120, currency: 'USD', ...over,
});

function fakeAdapter(
  read: (args: GetAccountMetricsArgs) => GetAccountMetricsResult,
  briefX = 'brief-x',
  ledger = LEDGER(briefX),
): { adapter: AdsAdapter; reads: GetAccountMetricsArgs[] } {
  const reads: GetAccountMetricsArgs[] = [];
  const adapter: AdsAdapter = {
    publishAd: async () => ({ outcome: 'no_connection' }),
    syncAudience: async () => ({ outcome: 'unsupported', platform: 'meta' }),
    sendConversion: async () => ({ outcome: 'no_connection' }),
    listDispatches: async () => ledger,
    getMetrics: async () => ({ outcome: 'unsupported', platform: 'meta' }),
    getAccountMetrics: async (args) => { reads.push(args); return read(args); },
    updateBudget: async () => ({ outcome: 'unsupported', platform: 'meta' }),
  };
  return { adapter, reads };
}

/** act_1 reports pc-1 (dispatched) AND pc-9 (not ours); act_2 has no connection. */
const accountReader = (conv = 3) => (args: GetAccountMetricsArgs): GetAccountMetricsResult => (args.adAccountId === 'act_2'
  ? { outcome: 'no_connection' }
  : { outcome: 'ok', platform: args.platform, pages: 1, truncated: false, rows: [
      row('2026-07-14', 'pc-1', 'Summer Launch (renamed on Meta)', { conversions: conv }),
      row('2026-07-13', 'pc-1', 'Summer Launch (renamed on Meta)'),
      row('2026-07-14', 'pc-9', 'Agency legacy campaign'),
    ] });

const pinClock = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-07-15T12:00:00Z')); };

describe('ADR 0907 D3 — runMetricsSync', () => {
  it('dispatched scope: reads the ledger accounts over the 7-day look-back, keeps only our campaigns, with conversions + revenue', async () => {
    pinClock();
    try {
      const brief = await createBrief(TENANT, ORG, 'test', { name: 'Summer Launch' });
      const camp = await finalizeFromBrief(TENANT, brief, 'test');
      const { adapter, reads } = fakeAdapter(accountReader(), brief.id);
      const r = await runMetricsSync(adapter, TENANT, ORG, 'meta');
      expect(r.outcome).toBe('synced');
      if (r.outcome !== 'synced') return;
      // Both meta accounts in the ledger, one window: 2026-07-08 .. 2026-07-14.
      expect(reads.map((a) => a.adAccountId).sort()).toEqual(['act_1', 'act_2']);
      for (const a of reads) expect({ since: a.since, until: a.until, level: a.level }).toEqual({ since: '2026-07-08', until: '2026-07-14', level: 'campaign' });
      expect(r).toMatchObject({ scope: 'dispatched', since: '2026-07-08', until: '2026-07-14', date: '2026-07-14', campaigns: 1, imported: 2, truncated: false });
      // act_2's no_connection is a per-account failure, not an abort.
      expect(r.failures).toEqual([{ adAccountId: 'act_2', reason: 'no_connection' }]);

      const rows = await listRecords(TENANT, ORG);
      // pc-9 (not dispatched by this app) is dropped; pc-1 keeps its LAUNCH name.
      expect(rows.map((x) => x.date)).toEqual(['2026-07-14', '2026-07-13']);
      expect(rows[0]).toMatchObject({
        platform: 'meta', campaignName: 'Summer Launch', adSet: CAMPAIGN_LEVEL_ADSET,
        spend: 42.5, impressions: 1000, clicks: 50, conversions: 3, revenue: 120, currency: 'USD', source: 'api',
        campaignId: camp.id,
      });
      expect(rows[0].roas).toBeCloseTo(120 / 42.5);

      // Immediate re-pull → cooldown (durable state), nothing re-fetched.
      const again = await runMetricsSync(adapter, TENANT, ORG, 'meta');
      expect(again.outcome).toBe('cooldown');
      expect(reads).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late conversion REPLACES the day it settles into — never a duplicate row', async () => {
    const T = 'user:campaign-sync-late';
    pinClock();
    try {
      await runMetricsSync(fakeAdapter(accountReader(3)).adapter, T, ORG, 'meta');
      vi.setSystemTime(new Date('2026-07-15T12:20:00Z')); // past the 15-minute cooldown
      const second = await runMetricsSync(fakeAdapter(accountReader(7)).adapter, T, ORG, 'meta');
      expect(second.outcome).toBe('synced');
      const day = (await listRecords(T, ORG)).filter((x) => x.date === '2026-07-14');
      expect(day).toHaveLength(1);
      expect(day[0].conversions).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a pre-ADR-0907 "dispatched"-labelled row instead of counting the day twice; CSV rows are untouched', async () => {
    const T = 'user:campaign-sync-legacy';
    const base = { spend: 10, impressions: 10, clicks: 1, conversions: 0, revenue: 0 };
    await persistRecords(T, ORG, [{ platform: 'meta', campaignName: 'Summer Launch', adSet: 'dispatched', date: '2026-07-14', ...base, ...computeDerived(base) }], 'api');
    await persistRecords(T, ORG, [{ platform: 'meta', campaignName: 'Summer Launch', adSet: 'dispatched', date: '2026-07-12', ...base, ...computeDerived(base) }], 'csv');
    pinClock();
    try {
      await runMetricsSync(fakeAdapter(accountReader()).adapter, T, ORG, 'meta');
    } finally {
      vi.useRealTimers();
    }
    const rows = await listRecords(T, ORG);
    expect(rows.filter((x) => x.date === '2026-07-14').map((x) => x.adSet)).toEqual([CAMPAIGN_LEVEL_ADSET]);
    expect(rows.filter((x) => x.date === '2026-07-12').map((x) => x.source)).toEqual(['csv']);
  });

  it('account scope reads the configured accounts and keeps every campaign, under the platform name', async () => {
    const T = 'user:campaign-sync-account';
    await saveConnectorSettings(T, ORG, 'meta', { syncScope: 'account', adAccountIds: ['act_1'], conversionActionTypes: ['lead'] });
    pinClock();
    try {
      const { adapter, reads } = fakeAdapter(accountReader());
      const r = await runMetricsSync(adapter, T, ORG, 'meta');
      expect(r.outcome).toBe('synced');
      expect(reads.map((a) => [a.adAccountId, a.conversionActionTypes])).toEqual([['act_1', ['lead']]]);
      const names = new Set((await listRecords(T, ORG)).map((x) => x.campaignName));
      expect(names).toEqual(new Set(['Summer Launch', 'Agency legacy campaign']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports no_dispatches / no_accounts honestly, and neither probe consumes the cooldown (CC-SP-14)', async () => {
    const T = 'user:campaign-sync-probe';
    const empty = fakeAdapter(accountReader(), 'b', []);
    expect((await runMetricsSync(empty.adapter, T, ORG, 'meta')).outcome).toBe('no_dispatches');
    expect((await runMetricsSync(empty.adapter, T, ORG, 'meta', { scope: 'account' })).outcome).toBe('no_accounts');
    expect(empty.reads).toHaveLength(0);
    // A dispatch lands; the immediate real sync must run, not report cooldown.
    expect((await runMetricsSync(fakeAdapter(accountReader()).adapter, T, ORG, 'meta')).outcome).toBe('synced');
  });

  it('settings validation refuses malformed ids and an empty account scope', async () => {
    await expect(saveConnectorSettings('user:cs-v', ORG, 'meta', { syncScope: 'account', adAccountIds: [] })).rejects.toThrow(/at least one/);
    await expect(saveConnectorSettings('user:cs-v', ORG, 'meta', { adAccountIds: ['act_1; DROP'] })).rejects.toThrow(/not an ad-account id/);
    await expect(saveConnectorSettings('user:cs-v', ORG, 'google', { conversionActionTypes: ['Bad Type'] })).rejects.toThrow(/not an action type/);
    const ok = await saveConnectorSettings('user:cs-v', ORG, 'google', { syncScope: 'account', adAccountIds: ['123-456-7890'] });
    expect(ok).toMatchObject({ syncScope: 'account', adAccountIds: ['123-456-7890'] });
  });
});

describe('ADR 0907 D3 — runMetricsBackfill', () => {
  it('walks 7-day windows newest-first, resumes across calls, finishes, and never moves the daily cooldown', async () => {
    const T = 'user:campaign-backfill';
    pinClock();
    try {
      const { adapter, reads } = fakeAdapter(accountReader(), 'b', [LEDGER('b')[0]]);
      const first = await runMetricsBackfill(adapter, T, ORG, 'meta', { days: 30 });
      // 4 windows per call: 07-08..07-14, 07-01..07-07, 06-24..06-30, 06-17..06-23.
      expect(first).toMatchObject({ outcome: 'progress', targetSince: '2026-06-15', windowsDone: 4, remainingDays: 2 });
      expect(reads.map((a) => `${a.since}..${a.until}`)).toEqual([
        '2026-07-08..2026-07-14', '2026-07-01..2026-07-07', '2026-06-24..2026-06-30', '2026-06-17..2026-06-23',
      ]);
      // A backfill does not stamp lastSyncAt, so it cannot lock out the daily sync.
      expect(await getSyncStatus(T, ORG)).toEqual([]);

      const second = await runMetricsBackfill(adapter, T, ORG, 'meta', { days: 30 });
      expect(second).toMatchObject({ outcome: 'done', remainingDays: 0, windowsDone: 5 });
      expect(reads.at(-1)).toMatchObject({ since: '2026-06-15', until: '2026-06-16' }); // clamped to the target
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not advance past a throttled window', async () => {
    const T = 'user:campaign-backfill-429';
    pinClock();
    try {
      let throttle = true;
      const { adapter, reads } = fakeAdapter((args) => (throttle ? { outcome: 'rate_limited', retryAfterS: 60 } : accountReader()(args)), 'b', [LEDGER('b')[0]]);
      const r = await runMetricsBackfill(adapter, T, ORG, 'meta', { days: 14 });
      expect(r).toMatchObject({ outcome: 'rate_limited', windowsDone: 0, remainingDays: 14 });
      expect(r.outcome === 'rate_limited' && r.failures[0]).toEqual({ adAccountId: 'act_1', reason: 'rate_limited', retryAfterS: 60 });
      throttle = false;
      const again = await runMetricsBackfill(adapter, T, ORG, 'meta', { days: 14 });
      expect(again).toMatchObject({ outcome: 'done', windowsDone: 2 });
      expect(reads[1]).toMatchObject({ since: '2026-07-08', until: '2026-07-14' }); // the throttled window, re-read
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses more than 90 days', async () => {
    await expect(runMetricsBackfill(fakeAdapter(accountReader()).adapter, 'user:bf-big', ORG, 'meta', { days: 91 })).rejects.toThrow(/1 to 90/);
  });

  it('isoDaysBefore is calendar arithmetic', () => {
    expect(isoDaysBefore('2026-03-01', 1)).toBe('2026-02-28');
    expect(yesterdayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ADR 0215 — sync route', () => {
  interface Res<T> { status: number; body: T }
  interface Body { orgId?: string; outcome?: string; error?: string; message?: string; settings?: Record<string, unknown> }
  function client(): { post: (p: string, b?: unknown) => Promise<Res<Body>>; put: (p: string, b?: unknown) => Promise<Res<Body>>; get: (p: string) => Promise<Res<Body>> } {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<Res<Body>> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
    };
    return { post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), get: (p) => call('GET', p) };
  }

  it('validates the platform, requires org write, and reports honestly on an empty ledger', async () => {
    const tenantId = `user:cs-route-${Date.now()}`;
    const owner = client();
    const login = await owner.post('/host/openwop-app/test/login', { email: `cs-${Date.now()}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    const orgId = org.body.orgId as string;

    const bad = await owner.post('/host/openwop-app/campaign-connectors/sync', { orgId, platform: 'pinterest' });
    expect(bad.status).toBe(400); // no metrics reader at all
    expect(bad.body.message).toMatch(/meta, google, tiktok, linkedin/);
    // ADR 0907 D2 — TikTok has a reader, but it is not verified on this host: honest, no call.
    const unverified = await owner.post('/host/openwop-app/campaign-connectors/sync', { orgId, platform: 'tiktok' });
    expect(unverified.status).toBe(200);
    expect(unverified.body.outcome).toBe('not_verified');

    const ok = await owner.post('/host/openwop-app/campaign-connectors/sync', { orgId, platform: 'meta' });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe('no_dispatches'); // empty ledger — honest

    // A SAME-tenant user with no membership in the org: the org-write check is
    // the only thing that can refuse it.
    const peer = client();
    expect((await peer.post('/host/openwop-app/test/login', { email: `cs-peer-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const denied = await peer.post('/host/openwop-app/campaign-connectors/sync', { orgId, platform: 'meta' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');
  });

  it('ADR 0907 D3: connector settings + backfill routes — validated, org-scoped, honest on an empty ledger', async () => {
    const tenantId = `cs-settings-${Date.now()}`; // NOT a personal `user:` tenant — there every signed-in caller is its implicit owner
    const owner = client();
    expect((await owner.post('/host/openwop-app/test/login', { email: `css-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
    const base = `/host/openwop-app/campaign-connectors/orgs/${orgId}`;

    const dflt = await owner.get(`${base}/connector-settings/meta`);
    expect(dflt.status).toBe(200);
    expect(dflt.body.settings).toMatchObject({ syncScope: 'dispatched', adAccountIds: [] });
    expect(dflt.body.settings).not.toHaveProperty('tenantId');

    expect((await owner.put(`${base}/connector-settings/tiktok`, { syncScope: 'account' })).status).toBe(400);
    expect((await owner.put(`${base}/connector-settings/meta`, { syncScope: 'account', adAccountIds: [] })).status).toBe(400);
    const saved = await owner.put(`${base}/connector-settings/meta`, { syncScope: 'account', adAccountIds: ['act_42'] });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ syncScope: 'account', adAccountIds: ['act_42'] });

    expect((await owner.post(`${base}/sync/backfill`, { platform: 'meta', days: 120 })).status).toBe(400);
    const bf = await owner.post(`${base}/sync/backfill`, { platform: 'google', days: 7 });
    expect(bf.status).toBe(200);
    expect(bf.body.outcome).toBe('no_dispatches'); // google: dispatched scope, empty ledger

    const peer = client();
    expect((await peer.post('/host/openwop-app/test/login', { email: `css-peer-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    // Reads follow the org's workspace:read policy (the pixels GET precedent);
    // the WRITES are what a same-tenant non-member must never reach.
    expect((await peer.put(`${base}/connector-settings/meta`, { syncScope: 'dispatched' })).status).toBe(403);
    expect((await peer.post(`${base}/sync/backfill`, { platform: 'meta', days: 7 })).status).toBe(403);
  });
});

describe('performance store — natural-key delimiter safety (grade-code AUDIT-6)', () => {
  it('does not collide rows when a campaignName contains the "|" delimiter', async () => {
    const T = 'user:natkey-test';
    const ORG = 'org-natkey';
    const mk = (campaignName: string, adSet: string, spend: number) => {
      const base = { spend, impressions: 100, clicks: 10, conversions: 1, revenue: 5 };
      return { platform: 'meta' as const, campaignName, adSet, date: '2026-07-01', ...base, ...computeDerived(base) };
    };
    // Pre-fix, `Brand|Q3` + adSet `x` and `Brand` + adSet `Q3|x` would join to the
    // same `meta|Brand|Q3|x|...` key and clobber each other.
    await persistRecords(T, ORG, [mk('Brand|Q3', 'x', 100), mk('Brand', 'Q3|x', 200)], 'csv');
    const rows = await listRecords(T, ORG);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.spend))).toEqual(new Set([100, 200]));
  });
});
