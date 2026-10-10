/**
 * ADR 0569 (frontend) — the "Daily uniques" figure + cookieless disclosure.
 *
 * Both polarities: WITH `uniqueVisitors` on the summary the tile renders with
 * its value and the disclosure names the mechanism + the start date; WITHOUT
 * it (the operator opt-out, or counts-only history) neither renders — the
 * page adapts to counts only rather than showing a dishonest zero.
 *
 * Sabotage witnesses (grade-tests wave 8): forcing either `uniqueVisitors !==
 * undefined` gate, or dropping the `uniqueVisitorsSince` date from the
 * disclosure, turns a case red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AnalyticsSummary } from '../analyticsClient.js';
import type * as Client from '../analyticsClient.js';
import { formatDate } from '../../../i18n/format.js';

const getSummary = vi.fn<typeof Client.getSummary>();
const getEvents = vi.fn<typeof Client.getEvents>();
const getTrend = vi.fn<typeof Client.getTrend>();
const getNavReport = vi.fn<typeof Client.getNavReport>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../analyticsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSummary: (...a: Parameters<typeof Client.getSummary>) => getSummary(...a),
  getEvents: (...a: Parameters<typeof Client.getEvents>) => getEvents(...a),
  getTrend: (...a: Parameters<typeof Client.getTrend>) => getTrend(...a),
  getNavReport: () => getNavReport(),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { AnalyticsPage } = await import('../AnalyticsPage.js');

const summary = (extra?: Partial<AnalyticsSummary>): AnalyticsSummary => ({
  total: 5, sessions: 2, byType: { pageview: 5, event: 0, conversion: 0 },
  topPaths: [], utmSources: [], ...extra,
});

const renderPage = () => render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);

beforeEach(() => { vi.resetAllMocks(); getNavReport.mockResolvedValue({ weeks: [], rows: [] }); getEvents.mockResolvedValue([]); getTrend.mockResolvedValue([]); });
afterEach(cleanup);

describe('ADR 0569 — the Daily uniques figure', () => {
  it('renders the tile + the cookieless disclosure (with the start date) when the dimension exists', async () => {
    getSummary.mockResolvedValue({ summary: summary({ uniqueVisitors: 3, uniqueVisitorsSince: '2026-08-15T10:00:00.000Z' }) });
    renderPage();
    await screen.findByText('Daily uniques');
    expect(screen.getByText('3')).toBeTruthy();
    const disclosure = screen.getByText(/cookieless/i);
    expect(disclosure.textContent).toMatch(/rotates every UTC day/i);
    // The START DATE itself, via the page's own formatter (locale/TZ-stable).
    expect(disclosure.textContent).toContain(`Counting began ${formatDate('2026-08-15T10:00:00.000Z')}`);
  });

  it('renders NEITHER tile nor disclosure when the summary has no visitor dimension (counts only)', async () => {
    getSummary.mockResolvedValue({ summary: summary() });
    renderPage();
    await screen.findAllByText(/events/i);
    expect(screen.queryByText('Daily uniques')).toBeNull();
    expect(screen.queryByText(/cookieless/i)).toBeNull();
  });
});
