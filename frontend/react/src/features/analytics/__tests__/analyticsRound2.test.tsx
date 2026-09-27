/**
 * UX_UPGRADE-analytics ROUND 2 — XAN-0/1/2 (frontend).
 *
 *  - AN-SP-1: a failed summary read shows a NAMED failure + retry — never the
 *    permanent skeleton (and never "no analytics yet").
 *  - AN-SP-2: zero events in a WINDOW is "quiet window" + a switch to all
 *    time — never the false "beacon not installed" claim.
 *  - AN-SP-3: a stale response from the previous org/window never lands.
 *  - AN-R2-1: the trend chart renders for windowed views with data.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AnalyticsSummary, TrendPoint } from '../analyticsClient.js';

const getSummary = vi.fn();
const getEvents = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const getTrend = vi.fn(async (..._a: unknown[]): Promise<TrendPoint[]> => []);
const getNavReport = vi.fn(async (..._a: unknown[]) => ({ rows: [], totalRecorded: 0 }));

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../analyticsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSummary: (...a: unknown[]) => getSummary(...a),
  getEvents: (...a: unknown[]) => getEvents(...a),
  getTrend: (...a: unknown[]) => getTrend(...a),
  getNavReport: (...a: unknown[]) => getNavReport(...a),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { AnalyticsPage } = await import('../AnalyticsPage.js');

const summary = (total: number): AnalyticsSummary => ({
  total, sessions: 2, byType: { pageview: total, event: 0, conversion: 0 },
  topPaths: [], utmSources: [], vitals: [],
} as unknown as AnalyticsSummary);

const renderPage = () => render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  getNavReport.mockResolvedValue({ rows: [], totalRecorded: 0 });
  getEvents.mockResolvedValue([]);
  getTrend.mockResolvedValue([]);
});
afterEach(cleanup);

describe('AN-SP-1 — failed summary read', () => {
  it('shows the named failure with retry, not the skeleton or "no analytics yet"', async () => {
    getSummary.mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findByText(/didn.t load/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(/no analytics yet/i)).toBeNull();
  });
});

describe('AN-SP-2 / ANL-UX-2 — the empty state is decided from a WIRE SIGNAL', () => {
  // The round-2 fix over-corrected: it replaced one unfalsifiable claim ("the
  // beacon isn't installed") with its exact opposite ("The beacon is connected
  // — this window is just quiet"), asserted from `summary.total === 0` and
  // nothing else. `firstEventAt` is the signal that actually discriminates,
  // and these three cases are the three states `total === 0` collapsed into one.
  it('a quiet 30-day window on a tenant that HAS reported says so and offers all time', async () => {
    getSummary.mockResolvedValue({ summary: summary(0), comparison: undefined, firstEventAt: '2026-01-05T10:00:00.000Z' });
    renderPage();
    await screen.findByText(/no events in the last 30 days/i);
    expect(screen.queryByText(/no analytics yet/i)).toBeNull();
    // The all-time switch is the offered action.
    expect(screen.getByRole('button', { name: /show all time/i })).toBeTruthy();
  });

  it('a tenant that has NEVER reported gets the not-installed copy, even on a WINDOW', async () => {
    // Pre-fix this said "The beacon is connected — this window is just quiet"
    // to someone who had never pasted the snippet.
    // ANL-UX-2 R2 — `lifetime` is what makes the absence of `firstEventAt` a
    // STATEMENT rather than a gap; without it the page must not claim either
    // way (pinned in summaryFailureScope.test.tsx).
    getSummary.mockResolvedValue({ summary: summary(0), comparison: undefined, lifetime: {} });
    renderPage();
    await screen.findByText(/no analytics yet/i);
    expect(screen.queryByText(/no events in the last 30 days/i)).toBeNull();
  });

  it('all-time zero with a REPORTING beacon is the web-vitals-only state, not "no analytics yet"', async () => {
    // `total` excludes web-vital telemetry, so a vitals-only site read as
    // never-installed on the all-time view. Now it says what is true.
    getSummary.mockResolvedValue({ summary: summary(0), comparison: undefined, firstEventAt: '2026-01-05T10:00:00.000Z' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /show all time/i }));
    await screen.findByText(/only performance telemetry so far/i);
    expect(screen.queryByText(/no analytics yet/i)).toBeNull();
  });

  it('all-time zero with NO history keeps the true not-installed copy (positive case)', async () => {
    getSummary.mockResolvedValue({ summary: summary(0), comparison: undefined, lifetime: {} });
    renderPage();
    await screen.findByText(/no analytics yet/i);
  });
});

describe('AN-SP-3 — stale responses never land', () => {
  it('the previous window\'s late summary does not overwrite the new one', async () => {
    let resolveFirst!: (v: unknown) => void;
    getSummary
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValue({ summary: summary(7), comparison: undefined });
    renderPage();
    // Switch the window while the first read hangs.
    const select = await screen.findByLabelText(/period|window/i);
    fireEvent.change(select, { target: { value: '7' } });
    resolveFirst({ summary: summary(999), comparison: undefined }); // stale lands last
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('999')).toBeNull();
  });
});

describe('AN-R2-1 — the trend chart', () => {
  it('renders for a windowed view with data; hidden when the read fails', async () => {
    getSummary.mockResolvedValue({ summary: summary(5), comparison: undefined });
    getTrend.mockResolvedValue([
      { day: '2026-08-03', pageviews: 1, events: 0, conversions: 0, uniques: 0 },
      { day: '2026-08-04', pageviews: 4, events: 0, conversions: 0, uniques: 0 },
    ]);
    renderPage();
    await screen.findByText(/per utc day over the last 30 days/i);
    expect(document.querySelector('.an-trend')).toBeTruthy();

    cleanup();
    getTrend.mockRejectedValue(new Error('boom'));
    renderPage();
    // Review F2 — assert absence only AFTER the page has finished rendering
    // its figures; the earlier immediate queryByText passed on the first tick
    // (while everything was still loading) and proved nothing.
    await screen.findAllByText(/pageviews/i);
    await new Promise((r) => setTimeout(r, 20)); // let the rejection settle
    expect(screen.queryByText(/per utc day/i)).toBeNull();
    expect(document.querySelector('.an-trend')).toBeNull();
  });
});
