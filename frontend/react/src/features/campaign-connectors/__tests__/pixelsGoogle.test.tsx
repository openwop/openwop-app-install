/**
 * ADR 0907 D5 — the Google pixel's conversion-action mapping, and D2 honesty
 * about which pixels actually receive server-side conversions.
 *
 *  - a google pixel saves its customer id and the `event = resource` map;
 *  - a malformed mapping line is NAMED and nothing is saved (never dropped);
 *  - a pixel whose sender is not live says so beside it, and Dispatch stays
 *    disabled unless some active pixel is on a live sender.
 *
 * Sabotage that turns it red: drop the bad-lines guard; send the raw text;
 * hard-code meta/tiktok as wired again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { KpiSummary, PixelConfig } from '../campaignConnectorsClient.js';

const upsertPixel = vi.fn();
const listPixels = vi.fn();
const getPlatformStatus = vi.fn();
const getConversionHealth = vi.fn();
const KPI: KpiSummary = {
  totals: { spend: 1, impressions: 1, clicks: 1, conversions: 1, revenue: 1, ctr: 1, cpc: 1, cvr: 1, cpa: 1, roas: 1 },
  byPlatform: [{ platform: 'google', spend: 1, impressions: 1, clicks: 1, conversions: 1, revenue: 1, roas: 1 }],
  recordCount: 1, dateRange: { start: '2026-10-01', end: '2026-10-01' }, currency: 'USD',
};

vi.mock('../campaignConnectorsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    getKpi: vi.fn(async () => KPI),
    listPixels: () => listPixels(),
    upsertPixel: (...a: unknown[]) => upsertPixel(...a),
    removePixel: vi.fn(async () => {}),
    getSyncStatus: vi.fn(async () => []),
    listConversions: vi.fn(async () => [{ eventId: 'e1', eventName: 'purchase', at: '2026-10-01T00:00:00Z', status: 'queued' }]),
    dispatchConversions: vi.fn(async () => ({ sent: 0 })),
    getConnectorSettings: vi.fn(async () => ({ orgId: 'org-1', platform: 'meta', syncScope: 'dispatched', adAccountIds: [], updatedAt: '' })),
    getPlatformStatus: () => getPlatformStatus(),
    getConversionHealth: () => getConversionHealth(),
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
    fireEvent.change(card.getByLabelText(/^conversion actions$/i), { target: { value: 'purchase = purchase' } });
    fireEvent.click(screen.getByRole('button', { name: /save pixel/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/purchase = purchase/);
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
    cleanup();
    getConversionHealth.mockRejectedValue(new Error('down'));
    await view();
    expect(screen.queryByRole('heading', { name: /conversion delivery/i })).toBeNull();
  });
});
