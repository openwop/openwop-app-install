/** PERF-4: the actual Performance page distinguishes missing revenue from
 * measured zero using additive server counts. Numeric legacy responses stay
 * compatible. Client reads are controlled fixtures; no API/provider writes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import i18n from '../../../i18n/index.js';
import { formatCurrency, formatNumber } from '../../../i18n/format.js';
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

// PERF-REVENUE-AVAILABILITY-1: scope the amount oracle to Revenue, not the
// separate ROAS card or missing-row notice. All client reads remain explicit.
function totalRevenueCard(): HTMLElement {
  const cards = screen.getAllByText(tr('kpiRevenue')).map(label => label.closest('.surface-card.u-flex-1')).filter((card): card is HTMLElement => card instanceof HTMLElement);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  if (!card) throw new Error('Total Revenue card missing');
  return card;
}
function singleRevenue(revenue: number, reportedCount: number, spend = 100): KpiSummary {
  return {
    totals: { spend, impressions: 1000, clicks: 50, conversions: 5, revenue, ctr: 0.05, cpc: spend / 50, cvr: 0.1, cpa: spend / 5, roas: spend > 0 ? revenue / spend : 0, reportedRevenueRecordCount: reportedCount },
    byPlatform: [{ platform: 'meta', spend, impressions: 1000, clicks: 50, conversions: 5, revenue, roas: spend > 0 ? revenue / spend : 0, reportedRevenueRecordCount: reportedCount }],
    recordCount: 1, dateRange: { start: '2026-11-05', end: '2026-11-05' }, currency: 'USD', currencyKnown: true,
    ...(reportedCount === 0 ? { unreported: { revenue: 1, conversions: 0 } } : {}),
  };
}
it('Revenue says Not reported when the only record has no reported revenue', async () => {
  api.getKpi.mockResolvedValue(singleRevenue(0, 0));
  await page();
  expect(within(totalRevenueCard()).getByText(tr('notReported'))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(formatCurrency(0, 'USD', { maximumFractionDigits: 0 }))).toBeNull();
  expect(within(totalRoasCard()).getByText(tr('notReported'))).toBeTruthy();
  expect(screen.getByText(i18n.t('campaign-connectors:unreportedNote', { revenue: 1, conversions: 0 }))).toBeTruthy();
  expect(api.getKpi).toHaveBeenLastCalledWith('org-perf4');
});
it('Revenue retains the reported subtotal when another platform has unknown revenue', async () => {
  api.getKpi.mockResolvedValue(mixed());
  await page();
  expect(within(totalRevenueCard()).getByText(formatCurrency(500, 'USD', { maximumFractionDigits: 0 }))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(tr('notReported'))).toBeNull();
  expect(platformRoas('meta').textContent).toContain(tr('notReported'));
});
it('Revenue retains a measured zero when one record actually reports zero', async () => {
  api.getKpi.mockResolvedValue(singleRevenue(0, 1));
  await page();
  expect(within(totalRevenueCard()).getByText(formatCurrency(0, 'USD', { maximumFractionDigits: 0 }))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(tr('notReported'))).toBeNull();
  expect(within(totalRoasCard()).getByText('0.00×')).toBeTruthy();
});
it('Revenue keeps legacy numeric zero when the server omits the optional reporting count', async () => {
  const data = singleRevenue(0, 0);
  delete data.totals.reportedRevenueRecordCount;
  for (const platform of data.byPlatform) delete platform.reportedRevenueRecordCount;
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalRevenueCard()).getByText(formatCurrency(0, 'USD', { maximumFractionDigits: 0 }))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(tr('notReported'))).toBeNull();
  expect(screen.getByText(i18n.t('campaign-connectors:unreportedNote', { revenue: 1, conversions: 0 }))).toBeTruthy();
});
it('Revenue retains a reported amount even when its spend denominator is zero', async () => {
  api.getKpi.mockResolvedValue(singleRevenue(10, 1, 0));
  await page();
  expect(within(totalRevenueCard()).getByText(formatCurrency(10, 'USD', { maximumFractionDigits: 0 }))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(tr('notReported'))).toBeNull();
  expect(within(totalRoasCard()).getByText('0.00×')).toBeTruthy();
});
it('Revenue keeps reported mixed-currency totals unlabelled', async () => {
  const data = mixed();
  data.currencyMixed = true;
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalRevenueCard()).getByText(formatNumber(500))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(formatCurrency(500, 'USD', { maximumFractionDigits: 0 }))).toBeNull();
});
it('Revenue keeps reported unknown-currency totals unlabelled', async () => {
  const data = mixed();
  data.currencyKnown = false;
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalRevenueCard()).getByText(formatNumber(500))).toBeTruthy();
  expect(within(totalRevenueCard()).queryByText(formatCurrency(500, 'USD', { maximumFractionDigits: 0 }))).toBeNull();
});
it('an empty record set remains the no-data state instead of an unavailable Revenue card', async () => {
  const data = singleRevenue(0, 0);
  data.totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, ctr: 0, cpc: 0, cvr: 0, cpa: 0, roas: 0, reportedRevenueRecordCount: 0 };
  data.recordCount = 0;
  data.byPlatform = [];
  data.dateRange = null;
  delete data.unreported;
  api.getKpi.mockResolvedValue(data);
  render(<CampaignConnectorsPage />);
  await screen.findByText(tr('emptyTitle'));
  expect(screen.queryByText(tr('kpiRevenue'))).toBeNull();
  expect(screen.queryByText(tr('notReported'))).toBeNull();
});


// Independent Conversions faces: neither oracle is hidden behind Revenue.
function totalConversionsCard(): HTMLElement {
  const cards = screen.getAllByText(tr('kpiConversions')).map(label => label.closest('.surface-card.u-flex-1')).filter((card): card is HTMLElement => card instanceof HTMLElement);
  expect(cards).toHaveLength(1);
  const card = cards[0];
  if (!card) throw new Error('Total Conversions card missing');
  return card;
}
function platformConversions(platform: 'google' | 'meta'): HTMLElement {
  const cells = within(screen.getByRole('row', { name: new RegExp(tr('platform_' + platform)) })).getAllByRole('cell');
  expect(cells).toHaveLength(5);
  const cell = cells[3];
  if (!cell) throw new Error('Platform Conversions cell missing');
  return cell;
}
function singleConversions(conversions: number, reportedCount: number, spend = 100): KpiSummary {
  const data = singleRevenue(0, 1, spend);
  data.totals = { ...data.totals, conversions, reportedConversionRecordCount: reportedCount, cvr: conversions / 50, cpa: conversions > 0 ? spend / conversions : 0 };
  data.byPlatform = data.byPlatform.map(platform => ({ ...platform, conversions, reportedConversionRecordCount: reportedCount }));
  if (reportedCount === 0) data.unreported = { conversions: 1, revenue: 0 };
  return data;
}
it('Conversions total says Not reported independently when both metrics are unknown', async () => {
  const data = singleConversions(0, 0);
  data.totals.reportedRevenueRecordCount = 0;
  data.byPlatform = data.byPlatform.map(platform => ({ ...platform, reportedRevenueRecordCount: 0 }));
  data.unreported = { conversions: 1, revenue: 1 };
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalConversionsCard()).getByText(tr('notReported'))).toBeTruthy();
  expect(within(totalConversionsCard()).queryByText(formatNumber(0))).toBeNull();
});
it('Conversions platform says Not reported independently while another platform reports', async () => {
  const data = mixed();
  data.totals = { ...data.totals, conversions: 2, reportedConversionRecordCount: 1, cvr: 0.04, cpa: 50 };
  data.byPlatform = data.byPlatform.map(platform => ({ ...platform, conversions: platform.platform === 'meta' ? 0 : 2, reportedConversionRecordCount: platform.platform === 'meta' ? 0 : 1 }));
  data.unreported = { conversions: 1, revenue: 1 };
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(platformConversions('meta').textContent).toContain(tr('notReported'));
  expect(platformConversions('meta').textContent).not.toMatch(/(?:^|\s)0(?:$|\s)/);
  expect(platformConversions('google').textContent).toContain(formatNumber(2));
  expect(within(totalConversionsCard()).getByText(formatNumber(2))).toBeTruthy();
});
it('Conversions retains measured zero in both the total card and platform cell', async () => {
  api.getKpi.mockResolvedValue(singleConversions(0, 1));
  await page();
  expect(within(totalConversionsCard()).getByText(formatNumber(0))).toBeTruthy();
  expect(platformConversions('meta').textContent).toContain(formatNumber(0));
  expect(screen.queryByText(tr('notReported'))).toBeNull();
});
it('Conversions retains a reported subtotal alongside unknown platform data', async () => {
  const data = mixed();
  data.totals = { ...data.totals, conversions: 3, reportedConversionRecordCount: 1, cvr: 0.06, cpa: 33.3333 };
  data.byPlatform = data.byPlatform.map(platform => ({ ...platform, conversions: platform.platform === 'meta' ? 3 : 0, reportedConversionRecordCount: platform.platform === 'meta' ? 1 : 0 }));
  data.unreported = { conversions: 1, revenue: 1 };
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalConversionsCard()).getByText(formatNumber(3))).toBeTruthy();
  expect(within(totalConversionsCard()).queryByText(tr('notReported'))).toBeNull();
  expect(platformConversions('meta').textContent).toContain(formatNumber(3));
});
it('Conversions keeps legacy numeric rendering when optional counts are absent', async () => {
  const data = singleConversions(0, 0);
  delete data.totals.reportedConversionRecordCount;
  for (const platform of data.byPlatform) delete platform.reportedConversionRecordCount;
  api.getKpi.mockResolvedValue(data);
  await page();
  expect(within(totalConversionsCard()).getByText(formatNumber(0))).toBeTruthy();
  expect(platformConversions('meta').textContent).toContain(formatNumber(0));
  expect(screen.queryByText(tr('notReported'))).toBeNull();
  expect(screen.getByText(i18n.t('campaign-connectors:unreportedNote', { revenue: 0, conversions: 1 }))).toBeTruthy();
});
it('Conversions does not mistake zero spend for unavailable reporting', async () => {
  api.getKpi.mockResolvedValue(singleConversions(2, 1, 0));
  await page();
  expect(within(totalConversionsCard()).getByText(formatNumber(2))).toBeTruthy();
  expect(platformConversions('meta').textContent).toContain(formatNumber(2));
  expect(screen.queryByText(tr('notReported'))).toBeNull();
});
