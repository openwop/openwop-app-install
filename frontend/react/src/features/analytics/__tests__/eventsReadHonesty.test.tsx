/**
 * AN-R2-1 (analytics round 2) — a failed recent-events read must not
 * impersonate "No events.".
 *
 * `getEvents(...).catch(() => setEvents([]))` flattened a failed read into
 * the same `[]` a genuinely quiet site produces, so the section claimed
 * "No events." while the summary above rendered fine — the mixed state
 * where silence reads as an answer. The 'error' sentinel renders a distinct
 * unavailable line instead.
 *
 * Both polarities: a REAL empty array still says "No events." (the claim
 * stays available for the truthful case).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ getSummary: vi.fn(), getEvents: vi.fn(), listOrgs: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../analyticsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, useFeatureAccess: access.useFeatureAccess };
});

import { AnalyticsPage } from '../AnalyticsPage.js';

// A COMPLETE fixture matching AnalyticsSummary exactly (byType needs all three
// keys; the tables iterate topPaths/utmSources).
const SUMMARY = {
  summary: {
    total: 5,
    sessions: 3,
    byType: { pageview: 4, event: 0, conversion: 1 },
    topPaths: [],
    utmSources: [],
    vitals: [],
  },
  comparison: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Id-sensitive: the page now hosts TWO toggles — `analytics` (on for these
  // cases) and the default-OFF `workspace-nav-telemetry` (ADR 0512), whose
  // section must NOT render here (a blanket enabled:true made its failure
  // line trip the truthful-empty polarity below).
  access.useFeatureAccess.mockImplementation((id: string) => makeFeatureAccess({ enabled: id === 'analytics', loading: false }));
  api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Org One' }]);
  api.getSummary.mockResolvedValue(SUMMARY);
});
afterEach(cleanup);

function view(): void {
  render(<MemoryRouter><AnalyticsPage /></MemoryRouter>);
}

describe('AN-R2-1 — the events section declares a failed read', () => {
  it("FAILED read: says events couldn't be loaded — never 'No events.'", async () => {
    api.getEvents.mockRejectedValue(new Error('events_500'));
    view();
    expect(await screen.findByText(/Recent events couldn.t be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/^No events\.$/)).toBeNull();
  });

  it("TRUTHFUL empty: a real [] still says 'No events.' (the polarity)", async () => {
    api.getEvents.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No events\./)).toBeTruthy();
    // scoped to the EVENTS copy: the trend section has its own polite failed state
    // now (ANL-UX-18), and this fixture never mocks getTrend.
    expect(screen.queryByText(/Recent events couldn.t be loaded/i)).toBeNull();
  });
});
