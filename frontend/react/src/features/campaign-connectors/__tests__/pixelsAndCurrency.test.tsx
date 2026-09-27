/**
 * UX_UPGRADE-campaign-connectors — CC-G1 / CC-G2.
 *
 *  - CC-G1: removing a pixel silently stops conversion tracking for that
 *    platform on the public pages — outward-facing and easy not to notice. It
 *    had neither a confirmation nor a `catch`, so a failed delete left the row
 *    in place with no message, immediately beside a save handler whose own
 *    comment reads "never swallow a failed save".
 *  - CC-G2: `kpi.currency` collapses "unanimously USD" and "mixed, here is a
 *    default" into the same string, so a EUR+GBP workspace read its spend and
 *    revenue in `$`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { KpiSummary, PixelConfig } from '../campaignConnectorsClient.js';

const getKpi = vi.fn();
const listPixels = vi.fn();
const removePixel = vi.fn();
const confirmMock = vi.fn();
// R2 review m4 — the new client fns must be EXPLICIT stubs: spreading
// `...actual` left them as real jsdom fetches, so the new surfaces had zero
// coverage while their tracker rows said done.
const getSyncStatus = vi.fn();
const listConversions = vi.fn();
const dispatchConversions = vi.fn();

vi.mock('../campaignConnectorsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    getKpi: () => getKpi(),
    listPixels: () => listPixels(),
    removePixel: (...a: unknown[]) => removePixel(...a),
    upsertPixel: vi.fn(async () => {}),
    getSyncStatus: (..._a: unknown[]) => getSyncStatus(),
    listConversions: (..._a: unknown[]) => listConversions(),
    dispatchConversions: (...a: unknown[]) => dispatchConversions(...a),
  };
});
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { CampaignConnectorsPage } from '../CampaignConnectorsPage.js';

// R2 CC-SP-16 — full literals, no `as`-casts (a cast fixture hid `active`, so
// SSoT drift never failed these tests).
const kpi = (currency: string, currencyMixed?: boolean, currencyKnown?: boolean): KpiSummary => ({
  totals: { spend: 12345, impressions: 100, clicks: 10, conversions: 2, revenue: 54321, ctr: 0.1, cpc: 1, cvr: 0.2, cpa: 5, roas: 4.4 },
  byPlatform: [{ platform: 'google', spend: 12345, impressions: 100, clicks: 10, conversions: 2, revenue: 54321, roas: 4.4 }],
  recordCount: 5, dateRange: { start: '2026-07-01', end: '2026-07-10' },
  currency, ...(currencyMixed === undefined ? {} : { currencyMixed }), ...(currencyKnown === undefined ? {} : { currencyKnown }),
});

const PIXEL: PixelConfig = { platform: 'meta', pixelId: 'PX-123', active: true, updatedAt: '2026-07-01T00:00:00.000Z' };

const view = async (): Promise<void> => {
  render(<CampaignConnectorsPage />);
  await act(async () => {});
  await waitFor(() => expect(screen.getByText('PX-123')).toBeTruthy());
};

beforeEach(() => {
  getKpi.mockReset(); listPixels.mockReset(); removePixel.mockReset(); confirmMock.mockReset();
  getKpi.mockResolvedValue(kpi('USD', false));
  listPixels.mockResolvedValue([PIXEL]);
  removePixel.mockResolvedValue(undefined);
  confirmMock.mockResolvedValue(true);
  getSyncStatus.mockReset().mockResolvedValue([]);
  listConversions.mockReset().mockResolvedValue([]);
  dispatchConversions.mockReset().mockResolvedValue({ sent: 0 });
});
afterEach(cleanup);

describe('CC-G1: removing a pixel is a disclosed, checked action', () => {
  it('asks before removing, and says what stops working', async () => {
    await view();
    fireEvent.click(screen.getByRole('button', { name: /remove.*meta/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const opts = confirmMock.mock.calls[0][0] as { title: string; body: string; danger?: boolean };
    expect(opts.danger).toBe(true);
    expect(opts.body).toMatch(/conversion tracking/i);
    // The irrecoverable part is stated, not implied.
    expect(opts.body).toMatch(/not recovered/i);
  });

  it('declining the confirm does NOT remove', async () => {
    confirmMock.mockResolvedValue(false);
    await view();
    fireEvent.click(screen.getByRole('button', { name: /remove.*meta/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(removePixel).not.toHaveBeenCalled();
  });

  it('a FAILED removal is surfaced, not swallowed', async () => {
    removePixel.mockRejectedValue(new Error('pixel store unavailable'));
    await view();
    fireEvent.click(screen.getByRole('button', { name: /remove.*meta/i }));
    // Previously this was an unhandled rejection: the row stayed and nothing
    // told the operator why.
    expect(await screen.findByText(/pixel store unavailable/)).toBeTruthy();
  });
});

describe('CC-G2: KPI totals never claim a currency the workspace does not use', () => {
  it('a unanimous currency IS shown', async () => {
    getKpi.mockResolvedValue(kpi('GBP', false));
    await view();
    expect(screen.getAllByText(/£12,345/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
  });

  it('a MIXED workspace drops the symbol and explains why', async () => {
    getKpi.mockResolvedValue(kpi('USD', true));
    await view();
    expect(screen.getAllByText('12,345').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$12,345/)).toBeNull();
    expect(screen.getByText(/more than one currency/i)).toBeTruthy();
  });

  it('a genuinely-USD workspace still shows $ — the flag decides, not the string', async () => {
    getKpi.mockResolvedValue(kpi('USD', false));
    await view();
    expect(screen.getAllByText(/\$12,345/).length).toBeGreaterThan(0);
  });

  it('an OLDER backend with no flag keeps today\'s labelled behaviour', async () => {
    getKpi.mockResolvedValue(kpi('EUR'));
    await view();
    // R2 CC-SP-16 — the old /12,345/ regex matched the LABELLED and UNLABELLED
    // renders alike (vacuous both polarities). Assert the label itself.
    expect(screen.getAllByText(/€12,345/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
  });
});

describe('R2 CC-SP-1/2 — the failure + unknown legs', () => {
  it('a FAILED pixels read never claims "No pixels configured."', async () => {
    listPixels.mockRejectedValue(new Error('pixels boom'));
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    expect(await screen.findByText(/Couldn't load the pixel configs/)).toBeTruthy();
    expect(screen.queryByText('No pixels configured.')).toBeNull();
  });

  it('an INACTIVE pixel is visibly marked (active was fetched and discarded)', async () => {
    listPixels.mockResolvedValue([{ ...PIXEL, active: false }]);
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    await screen.findByText('PX-123');
    expect(screen.getByText('Inactive')).toBeTruthy();
  });

  it('UNKNOWN currency (no evidence anywhere) renders unlabelled — the size-0 branch claimed $ with confidence', async () => {
    getKpi.mockResolvedValue(kpi('USD', false, false));
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    await screen.findByText('PX-123');
    expect(screen.getAllByText('12,345').length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$12,345/)).toBeNull();
  });

  it('a FAILED KPI read shows the failure card with retry — not an eternal spinner', async () => {
    getKpi.mockRejectedValue(new Error('kpi boom'));
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    expect(await screen.findByText(/Could not load this/i)).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });
});

describe('R2 CC-SP-6/13 — the new surfaces have real coverage (review m4)', () => {
  it('the queue chip shows depth and Dispatch sends; sent:0 is NOT a success', async () => {
    listConversions.mockResolvedValue([
      { eventId: 'e1', eventName: 'purchase', at: '2026-08-01T00:00:00.000Z', status: 'queued' },
      { eventId: 'e2', eventName: 'lead', at: '2026-08-01T00:00:00.000Z', status: 'sent' },
    ]);
    dispatchConversions.mockResolvedValue({ sent: 0 });
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    expect(await screen.findByText('1 conversion queued')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Dispatch to platforms/ }));
    await act(async () => {});
    expect(dispatchConversions).toHaveBeenCalled();
    // The old code toasted SUCCESS for zero sent — the failed-as-success family.
    const { toast } = await import('../../../ui/toast.js');
    expect((toast.info as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((toast.success as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith(expect.stringMatching(/Dispatched 0/));
  });

  it('the Dispatch button disables when no active pixel is on a WIRED platform', async () => {
    listPixels.mockResolvedValue([{ platform: 'google', pixelId: 'G-1', active: true, updatedAt: '2026-07-01T00:00:00.000Z' }]);
    listConversions.mockResolvedValue([{ eventId: 'e1', eventName: 'purchase', at: '2026-08-01T00:00:00.000Z', status: 'queued' }]);
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    await screen.findByText('1 conversion queued');
    // google is not in the dispatch route's wired set (meta/tiktok) — the old
    // predicate enabled the button and the click "succeeded" with 0 sent.
    expect((screen.getByRole('button', { name: /Dispatch to platforms/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the last-synced freshness line renders from the sync-status read', async () => {
    getSyncStatus.mockResolvedValue([{ platform: 'meta', lastSyncAt: '2026-08-09T10:00:00.000Z' }]);
    render(<CampaignConnectorsPage />);
    await act(async () => {});
    expect(await screen.findByText(/Last live sync:/)).toBeTruthy();
  });
});
