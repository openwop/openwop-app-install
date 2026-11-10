/**
 * ADR 0907 D3/D4 — `null` conversions/revenue mean UNREPORTED, never zero.
 *
 * TikTok's reader cannot report revenue, so its rows carry `revenue: null`.
 * Before the type allowed null, every consumer would have summed a placeholder
 * 0, which reads as "this platform earned nothing": ROAS 0, a bottom performer,
 * and the platform the budget optimizer drains first. These pin that each
 * consumer leaves an unreported row OUT of the ratio instead.
 *
 * Sabotage that turns it red: sum `?? 0` into the KPI ROAS denominator; drop the
 * `revenue === null` skip in optimizeBudget or topBottomPerformers; let the
 * planSync gate read an unverified platform.
 */
import { beforeAll, describe, expect, it, afterEach } from 'vitest';
import { createApp } from '../src/index.js';
import { kpiSummary, persistRecords, listRecords } from '../src/features/campaign-connectors/performanceService.js';
import { computeDerived, type ParsedRow } from '../src/features/campaign-connectors/csvImport.js';
import { planSync, recordAccountRows } from '../src/features/campaign-connectors/syncService.js';
import { optimizeBudget } from '../src/features/campaign-intel/intelligence.js';
import { topBottomPerformers } from '../src/features/campaign-intel/budgetPlanner.js';
import type { CampaignPerformanceRecord } from '../src/features/campaign-connectors/types.js';

const ORG = 'org-unrep';
const row = (platform: 'meta' | 'tiktok' | 'google', date: string, spend: number, revenue: number | null): ParsedRow => {
  const base = { spend, impressions: 1000, clicks: 50, conversions: 5, revenue };
  return { platform, campaignName: `${platform} c`, adSet: '(campaign)', date, ...base, ...computeDerived(base) };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
afterEach(() => { delete process.env.OPENWOP_ADS_VERIFIED_READERS; });

describe('ADR 0907 — unreported metrics stay out of the ratios', () => {
  it('the store keeps null; the KPI sums reported values, computes ROAS over reporting rows, and counts the rest', async () => {
    const T = 'user:unrep-kpi';
    await persistRecords(T, ORG, [row('meta', '2026-10-01', 100, 400), row('tiktok', '2026-10-01', 100, null)], 'api');
    const stored = await listRecords(T, ORG);
    expect(stored.find((r) => r.platform === 'tiktok')?.revenue).toBeNull();
    const k = await kpiSummary(T, ORG);
    expect(k.totals.spend).toBe(200);
    expect(k.totals.revenue).toBe(400);
    expect(k.totals.roas).toBe(4); // 400 / 100 (meta's spend) — NOT 400 / 200
    expect(k.unreported).toEqual({ conversions: 0, revenue: 1 });
    const tiktok = k.byPlatform.find((p) => p.platform === 'tiktok')!;
    expect(tiktok.roas).toBe(0);
    expect(tiktok.revenue).toBe(0);
  });

  it('a workspace where every row reports carries no `unreported` field', async () => {
    const T = 'user:unrep-none';
    await persistRecords(T, ORG, [row('meta', '2026-10-01', 100, 400)], 'csv');
    expect(await kpiSummary(T, ORG)).not.toHaveProperty('unreported');
  });

  const rec = (platform: string, campaignName: string, spend: number, revenue: number | null): CampaignPerformanceRecord => ({
    id: `${platform}-${campaignName}`, tenantId: 't', orgId: ORG, platform: platform as CampaignPerformanceRecord['platform'], campaignName, adSet: '(campaign)',
    date: '2026-10-01', spend, impressions: 1000, clicks: 10, conversions: 1, revenue, ctr: 0, cpc: 0, cvr: 0, cpa: 0, roas: 0, source: 'api', createdAt: 'x',
  });

  it('the budget optimizer never reads an unreported platform as ROAS 0', () => {
    const out = optimizeBudget([rec('meta', 'a', 500, 2000), rec('google', 'b', 500, 1000), rec('tiktok', 'c', 500, null)]);
    expect(JSON.stringify(out)).not.toContain('tiktok');
  });

  it('top/bottom performers leave an unreported campaign out instead of ranking it last', () => {
    const { top, bottom } = topBottomPerformers([rec('meta', 'a', 500, 2000), rec('google', 'b', 500, 600), rec('tiktok', 'c', 500, null)], { minSpend: 100 });
    expect([...top, ...bottom].map((r) => r.platform)).not.toContain('tiktok');
  });

  it('planSync refuses an unverified reader before anything else; a verified one plans', async () => {
    const T = 'user:unrep-plan';
    expect(await planSync(T, ORG, 'tiktok', [])).toEqual({ outcome: 'not_verified', platform: 'tiktok' });
    process.env.OPENWOP_ADS_VERIFIED_READERS = 'tiktok';
    expect((await planSync(T, ORG, 'tiktok', [])).outcome).toBe('no_dispatches');
  });

  it('recordAccountRows persists a TikTok null revenue as null', async () => {
    const T = 'user:unrep-record';
    process.env.OPENWOP_ADS_VERIFIED_READERS = 'tiktok';
    const plan = { platform: 'tiktok' as const, scope: 'account' as const, since: '2026-10-01', until: '2026-10-01', adAccountIds: ['1'], ledger: [] };
    await recordAccountRows(T, ORG, plan, [{ date: '2026-10-01', campaignId: '9', campaignName: 'TT', impressions: 10, clicks: 1, spend: 5, conversions: 2, revenue: null }]);
    const [r] = await listRecords(T, ORG);
    expect(r).toMatchObject({ platform: 'tiktok', conversions: 2, revenue: null, roas: 0 });
  });
});

// PERF-4: keep the numeric sentinel assertions above; availability is additive.
// These cases call actual persistence and KPI aggregation, not a copied reducer.
describe('PERF-4 — reporting availability is distinct from numeric ROAS', () => {
  it('mixed Google revenue and unreported Meta retain numeric math and expose exact platform counts', async () => {
    const tenant = 'user:perf4-mixed-platform';
    await persistRecords(tenant, ORG, [row('google', '2026-10-02', 100, 500), row('meta', '2026-10-02', 100, null)], 'csv');
    const result = await kpiSummary(tenant, ORG);
    expect(result.recordCount).toBe(2);
    expect(result.totals).toMatchObject({ spend: 200, revenue: 500, roas: 5, reportedRevenueRecordCount: 1 });
    expect(result.byPlatform.find(p => p.platform === 'google')).toMatchObject({ spend: 100, revenue: 500, roas: 5, reportedRevenueRecordCount: 1 });
    expect(result.byPlatform.find(p => p.platform === 'meta')).toMatchObject({ spend: 100, revenue: 0, roas: 0, reportedRevenueRecordCount: 0 });
    expect(result.unreported).toEqual({ conversions: 0, revenue: 1 });
    expect((await listRecords(tenant, ORG)).find(p => p.platform === 'meta')?.revenue).toBeNull();
  });

  it('all-null revenue emits explicit zero availability for totals and every platform, retaining numeric sentinels', async () => {
    const tenant = 'user:perf4-all-unreported';
    await persistRecords(tenant, ORG, [row('google', '2026-10-02', 100, null), row('meta', '2026-10-02', 100, null)], 'csv');
    const result = await kpiSummary(tenant, ORG);
    expect(result.totals).toMatchObject({ spend: 200, revenue: 0, roas: 0, reportedRevenueRecordCount: 0 });
    expect(result.byPlatform).toHaveLength(2);
    expect(result.byPlatform.map(p => ({ platform: p.platform, revenue: p.revenue, roas: p.roas, reportedRevenueRecordCount: p.reportedRevenueRecordCount })).sort((a, b) => a.platform.localeCompare(b.platform))).toEqual([
      { platform: 'google', revenue: 0, roas: 0, reportedRevenueRecordCount: 0 },
      { platform: 'meta', revenue: 0, roas: 0, reportedRevenueRecordCount: 0 },
    ]);
    expect(result.unreported).toEqual({ conversions: 0, revenue: 2 });
  });

  it('measured zero revenue counts as reported and leaves the existing zero ROAS unchanged', async () => {
    const tenant = 'user:perf4-measured-zero';
    await persistRecords(tenant, ORG, [row('meta', '2026-10-02', 100, 0)], 'csv');
    const result = await kpiSummary(tenant, ORG);
    expect(result.totals).toMatchObject({ spend: 100, revenue: 0, roas: 0, reportedRevenueRecordCount: 1 });
    expect(result.byPlatform).toEqual([expect.objectContaining({ platform: 'meta', revenue: 0, roas: 0, reportedRevenueRecordCount: 1 })]);
    expect(result).not.toHaveProperty('unreported');
  });

  it('partially reported rows within a platform keep the reporting-only denominator and counts sum across platforms', async () => {
    const tenant = 'user:perf4-partial-platform';
    await persistRecords(tenant, ORG, [row('meta', '2026-10-01', 100, 400), row('meta', '2026-10-02', 100, null), row('meta', '2026-10-03', 50, 0), row('google', '2026-10-01', 50, 100)], 'csv');
    const result = await kpiSummary(tenant, ORG);
    expect(result.recordCount).toBe(4);
    expect(result.totals).toMatchObject({ spend: 300, revenue: 500, roas: 2.5, reportedRevenueRecordCount: 3 });
    expect(result.byPlatform.find(p => p.platform === 'meta')).toMatchObject({ spend: 250, revenue: 400, roas: 2.6667, reportedRevenueRecordCount: 2 });
    expect(result.byPlatform.find(p => p.platform === 'google')).toMatchObject({ spend: 50, revenue: 100, roas: 2, reportedRevenueRecordCount: 1 });
    expect(result.totals.reportedRevenueRecordCount).toBe(result.byPlatform.reduce((sum, platform) => {
      if (platform.reportedRevenueRecordCount === undefined) throw new Error('New server omitted a platform reporting count');
      return sum + platform.reportedRevenueRecordCount;
    }, 0));
    expect(result.unreported).toEqual({ conversions: 0, revenue: 1 });
  });

  it('zero-spend reported revenue still counts a reporting row without changing the zero-denominator sentinel', async () => {
    const tenant = 'user:perf4-zero-spend';
    await persistRecords(tenant, ORG, [row('meta', '2026-10-02', 0, 10)], 'csv');
    const result = await kpiSummary(tenant, ORG);
    expect(result.totals).toMatchObject({ spend: 0, revenue: 10, roas: 0, reportedRevenueRecordCount: 1 });
    expect(result.byPlatform).toEqual([expect.objectContaining({ platform: 'meta', spend: 0, revenue: 10, roas: 0, reportedRevenueRecordCount: 1 })]);
    expect(result).not.toHaveProperty('unreported');
  });
});
