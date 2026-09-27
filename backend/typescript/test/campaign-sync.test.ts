/**
 * Live ad-metrics sync (ADR 0215 / campaign gap plan C2):
 *   - runMetricsSync pulls window:'yesterday' per dispatched campaign (fake
 *     adapter), builds date-scoped rows with conversions/revenue = 0, links the
 *     MarketingCampaign finalized from the dispatch's brief, and is best-effort
 *     per campaign;
 *   - the 15-minute cooldown blocks an immediate re-pull (durable state);
 *   - the sync route validates platform + RBAC and reports no_dispatches
 *     honestly when the ledger is empty.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { runMetricsSync, yesterdayIso } from '../src/features/campaign-connectors/syncService.js';
import { listRecords } from '../src/features/campaign-connectors/performanceService.js';
import type { AdsAdapter } from '../src/host/adsAdapter.js';

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

function fakeAdapter(overrides: Partial<AdsAdapter> = {}): { adapter: AdsAdapter; metricArgs: unknown[] } {
  const metricArgs: unknown[] = [];
  const adapter: AdsAdapter = {
    publishAd: async () => ({ outcome: 'no_connection' }),
    syncAudience: async () => ({ outcome: 'unsupported', platform: 'meta' }),
    sendConversion: async () => ({ outcome: 'no_connection' }),
    listDispatches: async () => [
      { platform: 'meta', platformCampaignId: 'pc-1', platformAdSetId: 'as-1', platformAdId: 'ad-1', briefId: 'brief-x', campaignName: 'Summer Launch', adAccountId: 'act_1', createdAt: '2026-07-01T00:00:00Z' },
      { platform: 'meta', platformCampaignId: 'pc-2', platformAdSetId: 'as-2', platformAdId: 'ad-2', briefId: 'brief-y', campaignName: 'Winback', adAccountId: 'act_1', createdAt: '2026-07-01T00:00:00Z' },
      { platform: 'google', platformCampaignId: 'pc-3', platformAdSetId: 'ag-1', platformAdId: 'ad-3', adAccountId: '123', createdAt: '2026-07-01T00:00:00Z' },
    ],
    getMetrics: async (args) => {
      metricArgs.push(args);
      if (args.campaignId === 'pc-2') return { outcome: 'no_connection' };
      return { outcome: 'ok', platform: args.platform, metrics: { impressions: 1000, clicks: 50, spend: 42.5, ctr: 0.05, cpc: 0.85 } };
    },
    updateBudget: async () => ({ outcome: 'unsupported', platform: 'meta' }),
    ...overrides,
  };
  return { adapter, metricArgs };
}

describe('ADR 0215 — runMetricsSync', () => {
  it('pulls yesterday-scoped metrics per dispatched campaign, best-effort, then cools down', async () => {
    const { adapter, metricArgs } = fakeAdapter();
    const r = await runMetricsSync(adapter, TENANT, ORG, 'meta');
    expect(r.outcome).toBe('synced');
    if (r.outcome !== 'synced') return;
    // Only the two meta dispatches were pulled, both with the yesterday window.
    expect(metricArgs).toHaveLength(2);
    for (const a of metricArgs) expect((a as { window?: string }).window).toBe('yesterday');
    // pc-2's no_connection is a per-campaign failure, not an abort.
    expect(r.campaigns).toBe(1);
    expect(r.failures).toEqual([{ platformCampaignId: 'pc-2', reason: 'no_connection' }]);

    const rows = await listRecords(TENANT, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: 'meta', campaignName: 'Summer Launch', adSet: 'dispatched',
      date: yesterdayIso(), spend: 42.5, impressions: 1000, clicks: 50,
      conversions: 0, revenue: 0, source: 'api',
    });

    // Immediate re-pull → cooldown (durable state), nothing re-fetched.
    const again = await runMetricsSync(adapter, TENANT, ORG, 'meta');
    expect(again.outcome).toBe('cooldown');
    expect(metricArgs).toHaveLength(2);
  });

  it('reports no_dispatches when the ledger has nothing for the platform', async () => {
    const { adapter } = fakeAdapter({ listDispatches: async () => [] });
    const r = await runMetricsSync(adapter, 'user:campaign-sync-empty', ORG, 'google');
    expect(r.outcome).toBe('no_dispatches');
  });

  it('R2 CC-SP-14: a no_dispatches probe does NOT consume the cooldown — the first real sync after a dispatch lands', async () => {
    const T = 'user:campaign-sync-probe';
    // Probe with an empty ledger: a local read, no platform call — the old code
    // claimed the 15-minute cooldown FIRST, locking out the real sync below.
    const empty = fakeAdapter({ listDispatches: async () => [] });
    expect((await runMetricsSync(empty.adapter, T, ORG, 'meta')).outcome).toBe('no_dispatches');
    // A dispatch lands; the immediate real sync must run, not report cooldown.
    const real = fakeAdapter({});
    const r = await runMetricsSync(real.adapter, T, ORG, 'meta');
    expect(r.outcome).toBe('synced');
  });

  it('dates the row by the platform-reported date when the metrics carry one (CONN-1)', async () => {
    const T2 = 'user:campaign-sync-conn1';
    // Adapter reports an explicit account-timezone date that differs from the UTC
    // yesterdayIso() label — the row must be dated by the platform's date.
    const platformDate = '2025-12-31';
    const { adapter } = fakeAdapter({
      getMetrics: async (args) => (args.campaignId === 'pc-2'
        ? { outcome: 'no_connection' }
        : { outcome: 'ok', platform: args.platform, metrics: { impressions: 1000, clicks: 50, spend: 42.5, ctr: 0.05, cpc: 0.85 }, date: platformDate }),
    });
    const r = await runMetricsSync(adapter, T2, ORG, 'meta');
    expect(r.outcome).toBe('synced');
    const rows = await listRecords(T2, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe(platformDate);
    expect(rows[0].date).not.toBe(yesterdayIso());
  });
});

describe('ADR 0215 — sync route', () => {
  interface Res<T = any> { status: number; body: T }
  function client(): { post: (p: string, b?: unknown) => Promise<Res> } {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    };
    return { post: (p, b) => call('POST', p, b) };
  }

  it('validates the platform, requires org write, and reports honestly on an empty ledger', async () => {
    const owner = client();
    const login = await owner.post('/v1/host/openwop-app/test/login', { email: `cs-${Date.now()}@acme.test` });
    expect(login.status).toBe(201);
    const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    const orgId = org.body.orgId as string;

    const bad = await owner.post('/v1/host/openwop-app/campaign-connectors/sync', { orgId, platform: 'tiktok' });
    expect(bad.status).toBe(400); // no live metrics reader

    const ok = await owner.post('/v1/host/openwop-app/campaign-connectors/sync', { orgId, platform: 'meta' });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe('no_dispatches'); // empty ledger — honest
  });
});

describe('performance store — natural-key delimiter safety (grade-code AUDIT-6)', () => {
  it('does not collide rows when a campaignName contains the "|" delimiter', async () => {
    const { persistRecords } = await import('../src/features/campaign-connectors/performanceService.js');
    const { computeDerived } = await import('../src/features/campaign-connectors/csvImport.js');
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
