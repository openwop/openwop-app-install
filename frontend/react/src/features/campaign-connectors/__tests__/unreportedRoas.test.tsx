/** PERF-4: the actual Performance page distinguishes missing revenue from
 * measured zero using additive server counts. Numeric legacy responses stay
 * compatible. Client reads are controlled fixtures; no API/provider writes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import i18n from '../../../i18n/index.js';
import type { KpiSummary } from '../campaignConnectorsClient.js';

const api = vi.hoisted(() => ({ getKpi: vi.fn<(orgId: string) => Promise<KpiSummary>>() }));
vi.mock('../campaignConnectorsClient.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../campaignConnectorsClient.js')>();
  return { ...actual,
    listOrgs: vi.fn(async () => [{ orgId: 'org-perf4', name: 'Synthetic reporting client' }]),
    getKpi: api.getKpi,
    getSyncStatus: vi.fn(async () => []),
    listPixels: vi.fn(async () => []),
    listConversions: vi.fn(async () => []),
    getCatalogFeed: vi.fn(async () => ({ enabled: false, version: 1, contentLanguage: 'en', feedLabel: 'US', items: 0, excluded: [] })),
    getConnectorSettings: vi.fn(async () => ({ orgId: 'org-perf4', platform: 'meta', syncScope: 'dispatched', adAccountIds: [], updatedAt: '' })),
    getPlatformStatus: vi.fn(async () => ({ liveSync: [], liveConversions: [] })),
    getConversionHealth: vi.fn(async () => { throw new Error('No conversion health fixture requested'); }),
  };
});
import { CampaignConnectorsPage } from '../CampaignConnectorsPage.js';
const tr = (key: string): string => i18n.t('campaign-connectors:' + key);
function mixed(): KpiSummary {
  return {
    totals: { spend: 200, impressions: 2000, clicks: 100, conversions: 10, revenue: 500, ctr: 0.05, cpc: 2, cvr: 0.1, cpa: 20, roas: 5, reportedRevenueRecordCount: 1 },
    byPlatform: [
      { platform: 'google', spend: 100, impressions: 1000, clicks: 50, conversions: 5, revenue: 500, roas: 5, reportedRevenueRecordCount: 1 },
      { platform: 'meta', spend: 100, impressions: 1000, clicks: 50, conversions: 5, revenue: 0, roas: 0, reportedRevenueRecordCount: 0 },
    ],
    recordCount: 2, dateRange: { start: '2026-10-02', end: '2026-10-02' }, currency: 'USD', currencyKnown: true,
    unreported: { conversions: 0, revenue: 1 },
  };
}
function totalRoasCard(): HTMLElement {
  const cards = screen.getAllByText(tr('kpiRoas')).map(label => label.closest('.surface-card.u-flex-1')).filter((card): card is HTMLElement => card instanceof HTMLElement);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  if (!card) throw new Error('Total ROAS card missing');
  return card;
}
function platformRoas(platform: 'google' | 'meta'): HTMLElement {
  const row = screen.getByRole('row', { name: new RegExp(tr('platform_' + platform)) });
  const cells = within(row).getAllByRole('cell');
  expect(cells).toHaveLength(5);
  const roasCell = cells[4];
  if (!roasCell) throw new Error('Platform ROAS cell missing');
  return roasCell;
}
async function page(): Promise<void> {
  render(<CampaignConnectorsPage />);
  await screen.findByRole('heading', { name: tr('byPlatformTitle') });
}
beforeEach(() => { api.getKpi.mockReset(); });
afterEach(cleanup);

it('mixed reporting shows Meta Not reported and retains Google/total5x on a fresh page read', async () => {
  api.getKpi.mockResolvedValue(mixed());
  await page();
  expect(platformRoas('meta').textContent).toContain(tr('notReported'));
  expect(platformRoas('meta').textContent).not.toContain('0.00×');
  expect(platformRoas('google').textContent).toContain('5.00×');
  expect(within(totalRoasCard()).getByText('5.00×')).toBeTruthy();
  expect(screen.getByText(i18n.t('campaign-connectors:unreportedNote', { revenue: 1, conversions: 0 }))).toBeTruthy();
  cleanup();
  await page(); // New component/read; this is not a server persistence claim.
  expect(api.getKpi).toHaveBeenCalledTimes(2);
  expect(api.getKpi).toHaveBeenLastCalledWith('org-perf4');
  expect(platformRoas('meta').textContent).toContain(tr('notReported'));
  expect(within(totalRoasCard()).getByText('5.00×')).toBeTruthy();
});
it('all-unreported total and platform ROAS say Not reported instead of numeric zero', async () => {
  const data = mixed();
  data.totals = { ...data.totals, revenue: 0, roas: 0, reportedRevenueRecordCount: 0 };
  data.byPlatform = data.byPlatform.map(p => ({ ...p, revenue: 0, roas: 0, reportedRevenueRecordCount: 0 }));
  data.unreported = { conversions: 0, revenue: 2 };
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalRoasCard()).getByText(tr('notReported'))).toBeTruthy();
  expect(platformRoas('google').textContent).toContain(tr('notReported'));
  expect(platformRoas('meta').textContent).toContain(tr('notReported'));
  expect(within(totalRoasCard()).queryByText('0.00×')).toBeNull();
});
it.each([{ name: 'measured zero revenue', spend: 100, revenue: 0 }, { name: 'reported revenue with zero spend', spend: 0, revenue: 10 }])('positive reporting count retains numeric0x for $name', async row => {
  const data = mixed();
  data.totals = { ...data.totals, spend: row.spend, revenue: row.revenue, roas: 0, reportedRevenueRecordCount: 1 };
  data.byPlatform = [{ platform: 'meta', spend: row.spend, impressions: 1000, clicks: 50, conversions: 5, revenue: row.revenue, roas: 0, reportedRevenueRecordCount: 1 }];
  data.recordCount = 1;
  delete data.unreported;
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalRoasCard()).getByText('0.00×')).toBeTruthy();
  expect(platformRoas('meta').textContent).toContain('0.00×');
  expect(screen.queryByText(tr('notReported'))).toBeNull();
});
it('older responses without optional counts keep numeric rendering despite global missing-revenue disclosure', async () => {
  const data = mixed();
  delete data.totals.reportedRevenueRecordCount;
  for (const platform of data.byPlatform) delete platform.reportedRevenueRecordCount;
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalRoasCard()).getByText('5.00×')).toBeTruthy();
  expect(platformRoas('google').textContent).toContain('5.00×');
  expect(platformRoas('meta').textContent).toContain('0.00×');
  expect(screen.queryByText(tr('notReported'))).toBeNull();
});
