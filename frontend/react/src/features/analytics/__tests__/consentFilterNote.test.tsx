/**
 * ANL-UX-23 / ADR 0857 — while consent management is on, the beacon records
 * only consented visitors, so every figure is a consent-filtered count. The page
 * says so; with consent off it says nothing (there is no filter to disclose).
 *
 * Sabotage witnesses (grade-tests wave 8): dropping or forcing the `consentOn`
 * branch, or reading the wrong toggle id for it, turns a case red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AnalyticsSummary } from '../analyticsClient.js';
import type * as Client from '../analyticsClient.js';

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
  // ADR 0951 — the behavior-capture section reads its own status; inert here.
  getHeatPages: async () => [],
  getHeatmap: async () => { throw new Error('not read in this suite'); },
  getBehaviorSettings: async () => ({ heatmaps: { enabled: false }, replay: { enabled: false, storageConfigured: false, consentEnabled: false, available: false, retentionDays: 30 } }),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
const toggles: Record<string, boolean> = {};
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: toggles[id] ?? true, loading: false }),
}));

const { AnalyticsPage } = await import('../AnalyticsPage.js');

const summary: AnalyticsSummary = { total: 5, sessions: 2, byType: { pageview: 5, event: 0, conversion: 0 }, topPaths: [], utmSources: [] };
const renderPage = () => render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);

beforeEach(() => { vi.resetAllMocks(); getNavReport.mockResolvedValue({ weeks: [], rows: [] }); getEvents.mockResolvedValue([]); getTrend.mockResolvedValue([]); getSummary.mockResolvedValue({ summary }); });
afterEach(() => { cleanup(); for (const k of Object.keys(toggles)) delete toggles[k]; });

describe('ANL-UX-23 — the consent-filter disclosure', () => {
  it('renders when the consent toggle is on', async () => {
    toggles.consent = true;
    renderPage();
    expect(await screen.findByText(/Consent management is on/i)).toBeTruthy();
  });

  it('is absent when the consent toggle is off', async () => {
    toggles.consent = false;
    renderPage();
    await screen.findByText('Pageviews');
    expect(screen.queryByText(/Consent management is on/i)).toBeNull();
  });
});
