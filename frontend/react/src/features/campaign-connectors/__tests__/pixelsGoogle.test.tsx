/**
 * ADR 0907 D5 — the Google pixel's conversion-action mapping, and D2 honesty
 * about which pixels actually receive server-side conversions.
 *
 *  - a google pixel saves its customer id and the `event = resource` map;
 *  - a malformed mapping line is NAMED and nothing is saved (never dropped);
 *  - a pixel whose sender is not live says so beside it, and Dispatch stays
 *    disabled unless some active pixel is on a live sender.
 *
 * Sabotage-witnessed (wave 55/56 probes, each red here): the bad-lines guard
 * dropped, or kept only when NO line parsed (a bad line beside a good one);
 * the raw text sent instead of the map; the "not verified" chip dropped;
 * Dispatch hard-coded to meta, or the status read ignored; the health card
 * listing unconfigured platforms; a failed health read fabricating a card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { KpiSummary, PixelConfig } from '../campaignConnectorsClient.js';

type Client = typeof import('../campaignConnectorsClient.js');
const { upsertPixel, listPixels, getPlatformStatus, getConversionHealth } = vi.hoisted(() => ({
  upsertPixel: vi.fn<Client['upsertPixel']>(),
  listPixels: vi.fn<Client['listPixels']>(),
  getPlatformStatus: vi.fn<Client['getPlatformStatus']>(),
  getConversionHealth: vi.fn<Client['getConversionHealth']>(),
}));
const KPI: KpiSummary = {
  totals: { spend: 1, impressions: 1, clicks: 1, conversions: 1, revenue: 1, ctr: 1, cpc: 1, cvr: 1, cpa: 1, roas: 1 },
  byPlatform: [{ platform: 'google', spend: 1, impressions: 1, clicks: 1, conversions: 1, revenue: 1, roas: 1 }],
  recordCount: 1, dateRange: { start: '2026-10-01', end: '2026-10-01' }, currency: 'USD',
};

vi.mock('../campaignConnectorsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listOrgs: vi.fn<Client['listOrgs']>(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    getKpi: vi.fn<Client['getKpi']>(async () => KPI),
    listPixels,
    upsertPixel,
    removePixel: vi.fn<Client['removePixel']>(async () => {}),
    getSyncStatus: vi.fn<Client['getSyncStatus']>(async () => []),
    listConversions: vi.fn<Client['listConversions']>(async () => [{ eventId: 'e1', eventName: 'purchase', at: '2026-10-01T00:00:00Z', status: 'queued' }]),
    dispatchConversions: vi.fn<Client['dispatchConversions']>(async () => ({ sent: 0 })),
    getCatalogFeed: vi.fn<Client['getCatalogFeed']>(async () => ({ enabled: false, version: 1, contentLanguage: 'en', feedLabel: 'US', items: 0, excluded: [] })),
    getConnectorSettings: vi.fn<Client['getConnectorSettings']>(async () => ({ orgId: 'org-1', platform: 'meta', syncScope: 'dispatched', adAccountIds: [], updatedAt: '' })),
    getPlatformStatus,
    getConversionHealth,
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { CampaignConnectorsPage } from '../CampaignConnectorsPage.js';

const GOOGLE: PixelConfig = { platform: 'google', pixelId: 'AW-1', active: true, updatedAt: '', googleCustomerId: '1234567890', conversionActions: { purchase: 'customers/1234567890/conversionActions/9' } };

const pixelsCard = () => within(screen.getByRole('heading', { name: /tracking pixels/i }).closest('section')!);

const view = async (): Promise<void> => {
  render(<CampaignConnectorsPage />);
  await act(async () => {});
  await waitFor(() => expect(screen.getByText('AW-1')).toBeTruthy());
};

describe('Google conversion actions (ADR 0907 D5)', () => {
  beforeEach(() => {
    upsertPixel.mockReset(); upsertPixel.mockResolvedValue(GOOGLE);
    listPixels.mockReset(); listPixels.mockResolvedValue([GOOGLE]);
    getPlatformStatus.mockReset(); getPlatformStatus.mockResolvedValue({ liveSync: ['meta', 'google'], liveConversions: ['meta'] });
    getConversionHealth.mockReset(); getConversionHealth.mockRejectedValue(new Error('not under test'));
  });
  afterEach(() => cleanup());

  it('saves the customer id and the parsed map', async () => {
    await view();
    const card = pixelsCard();
    fireEvent.change(card.getByLabelText(/^platform$/i), { target: { value: 'google' } });
    fireEvent.change(card.getByLabelText(/pixel id/i), { target: { value: 'AW-1' } });
    fireEvent.change(card.getByLabelText(/google ads customer id/i), { target: { value: '123-456-7890' } });
    fireEvent.change(card.getByLabelText(/^conversion actions$/i), { target: { value: 'purchase = customers/1234567890/conversionActions/9\nlead=customers/1234567890/conversionActions/10' } });
    fireEvent.click(screen.getByRole('button', { name: /save pixel/i }));
    await waitFor(() => expect(upsertPixel).toHaveBeenCalledTimes(1));
    expect(upsertPixel).toHaveBeenCalledWith('org-1', {
      platform: 'google', pixelId: 'AW-1', googleCustomerId: '123-456-7890',
      conversionActions: { purchase: 'customers/1234567890/conversionActions/9', lead: 'customers/1234567890/conversionActions/10' },
    });
  });

  it('names a malformed mapping line and saves nothing', async () => {
    await view();
    const card = pixelsCard();
    fireEvent.change(card.getByLabelText(/^platform$/i), { target: { value: 'google' } });
    fireEvent.change(card.getByLabelText(/pixel id/i), { target: { value: 'AW-1' } });
    // A malformed line BESIDE a good one: the good line must not carry the save
    // (a product that drops bad lines whenever something parsed stays red here).
    fireEvent.change(card.getByLabelText(/^conversion actions$/i), { target: { value: 'lead = customers/1234567890/conversionActions/10\npurchase = purchase' } });
    fireEvent.click(screen.getByRole('button', { name: /save pixel/i }));
    const alert = (await screen.findByRole('alert')).textContent ?? '';
    expect(alert).toMatch(/purchase = purchase/);
    expect(alert).not.toMatch(/conversionActions\/10/);
    expect(upsertPixel).not.toHaveBeenCalled();
  });

  it('a pixel on an unverified sender says so, and Dispatch follows the live list', async () => {
    await view();
    expect(screen.getByText(/1 conversion action mapped/i)).toBeTruthy();
    expect(screen.getByText(/not verified yet/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /dispatch to platforms/i }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    getPlatformStatus.mockResolvedValue({ liveSync: ['meta', 'google'], liveConversions: ['meta', 'google'] });
    await view();
    await waitFor(() => expect((screen.getByRole('button', { name: /dispatch to platforms/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/not verified yet/i)).toBeNull();
  });

  it('ADR 0907 D7: the health card shows per-platform delivery and the last error; a failed read shows no card', async () => {
    getConversionHealth.mockResolvedValue({
      queued: 3, sent: 5, capped: false,
      platforms: [
        { platform: 'meta', configured: false, live: true, delivered: 0, pending: 0 },
        { platform: 'tiktok', configured: false, live: false, delivered: 0, pending: 0 },
        { platform: 'google', configured: true, live: true, delivered: 5, pending: 3, lastError: { error: 'Conversion action not found', at: '2026-10-17T10:00:00Z' } },
      ],
    });
    await view();
    expect(await screen.findByText(/5 delivered, 3 waiting/i)).toBeTruthy();
    expect(screen.getByText(/conversion action not found/i)).toBeTruthy();
    // Per CONFIGURED platform only: meta (live, 0/0) and tiktok (not verified)
    // are not configured, so the card lists google alone.
    const healthCard = within(screen.getByRole('heading', { name: /conversion delivery/i }).parentElement!);
    const rows = healthCard.getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toMatch(/5 delivered, 3 waiting/);
    expect(healthCard.queryByText(/not verified yet/i)).toBeNull();
    expect(screen.getAllByText(/\d+ delivered, \d+ waiting/)).toHaveLength(1);
    cleanup();
    getConversionHealth.mockClear();
    getConversionHealth.mockRejectedValue(new Error('down'));
    await view();
    // Settle on the rejected read itself before reading the absence.
    await waitFor(() => expect(getConversionHealth).toHaveBeenCalledTimes(1));
    await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
    expect(screen.queryByRole('heading', { name: /conversion delivery/i })).toBeNull();
  });
});
