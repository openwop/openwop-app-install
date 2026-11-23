/**
 * ADR 0957 correction (2026-11-08, PERF-REVENUE-AVAILABILITY-1) — the two KPI
 * controls that note listed as NOT RUN and that no other file pins:
 *
 *  - "Undefined legacy platform counts remain omitted": a `byPlatform` row from a
 *    source that predates the reporting counts carries no
 *    `reportedRevenueRecordCount` / `reportedConversionRecordCount` key in the
 *    frozen table, rather than a fabricated 0 or a `null`.
 *  - "Missing metric values retain the existing null policy": totals without the
 *    counts freeze as `value: null` count metrics (rendered "Not available"),
 *    never 0, never currency, with the source's lineage.
 *
 * The route-backed null / measured-zero / mixed-platform controls the same note
 * lists live in `adr0957-client-reports.test.ts` (`copies $name revenue reporting
 * counts…`); the render controls in `clientReportsSection.test.tsx` and
 * `publicClientReportView.test.tsx`. This file isolates the source with a module
 * mock, because no real ad-record row can produce an undefined count today.
 *
 * Red witnesses (NOT RUN at authoring, 2026-11-19; the parent session runs them):
 *  - default the platform count to 0 in `sectionSources.ts` (`?? 0`) → "omits";
 *  - map an undefined total through `Number()` (0) in `metric()` → "freezes null".
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReportSnapshot } from '../src/features/campaign-ops/reports/types.js';

vi.mock('../src/host/workflowFeatureGate.js', () => ({ featureAccessRefusal: async () => null }));
vi.mock('../src/features/campaign-connectors/performanceService.js', () => ({
  kpiSummary: async () => ({
    recordCount: 2,
    currency: 'USD', currencyMixed: false, currencyKnown: true,
    totals: { spend: 120, impressions: 2400, clicks: 60, conversions: 3, revenue: 150, ctr: 0.025, cpc: 2, cvr: 0.05, cpa: 40, roas: 1.25 },
    byPlatform: [
      { platform: 'meta', spend: 70, impressions: 1400, clicks: 35, conversions: 2, revenue: 100, roas: 1.43 },
      { platform: 'google', spend: 50, impressions: 1000, clicks: 25, conversions: 1, revenue: 50, roas: 1, reportedRevenueRecordCount: 1, reportedConversionRecordCount: 1 },
    ],
  }),
}));

const { REPORT_SECTION_SOURCES } = await import('../src/features/campaign-ops/reports/sectionSources.js');

async function freeze(): Promise<ReportSnapshot> {
  const into: ReportSnapshot = { metrics: {}, tables: {} };
  await REPORT_SECTION_SOURCES.kpi.run({ kind: 'kpi', key: 'kpi', params: {} }, { tenantId: 't', orgId: 'o', campaignIds: 'all', computedAt: '2026-11-19T00:00:00.000Z' }, into);
  return into;
}

describe('ADR 0957 — legacy KPI sources without reporting counts', () => {
  it('omits an undefined platform count instead of inventing one, and keeps a present one verbatim', async () => {
    const rows = (await freeze()).tables['kpi.byPlatform']!.rows;
    const meta = rows.find((r) => r.platform === 'meta')!;
    const google = rows.find((r) => r.platform === 'google')!;
    expect(meta).not.toHaveProperty('reportedRevenueRecordCount');
    expect(meta).not.toHaveProperty('reportedConversionRecordCount');
    expect(google).toMatchObject({ reportedRevenueRecordCount: 1, reportedConversionRecordCount: 1 });
    // The rest of the legacy row is still the source's own numbers.
    expect(meta).toMatchObject({ spend: 70, revenue: 100, conversions: 2, roas: 1.43 });
  });

  it('freezes undefined total counts as null count metrics with lineage, never 0 or currency', async () => {
    const m = (await freeze()).metrics;
    for (const key of ['kpi.reportedRevenueRecordCount', 'kpi.reportedConversionRecordCount']) {
      expect(m[key], key).toMatchObject({ value: null, unit: 'count', previous: null, lineage: { source: 'campaign-connectors.kpiSummary', rows: 2 } });
      expect(m[key], key).not.toHaveProperty('currency');
    }
    // The measured figures beside them are unchanged.
    expect(m['kpi.revenue']).toMatchObject({ value: 150, unit: 'currency', currency: 'USD' });
  });
});
