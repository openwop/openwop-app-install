/**
 * ANL-UX-1 / ANL-UX-3 / ANL-UX-5 (UX-ASSESSMENT 2026-08-18) — three things the
 * page said that it had not measured.
 *
 *  - ANL-UX-1: a failed SUMMARY read hid the events stream and the trend chart
 *    THAT LOADED FINE, because `error && !summary` replaced the whole body.
 *    `DESIGN.md:325-330` names this direction explicitly and §4.6's `partial`
 *    row requires the failure be scoped to the panel that failed. The tracker
 *    recorded it closed (`UX_UPGRADE-analytics.md:238`, XAN-0); the round-2 fix
 *    had only replaced a permanent skeleton with a retry card.
 *  - ANL-UX-3: `deltaFor(current, comparison?.uniqueVisitors ?? 0)` coerced an
 *    ABSENT prior measurement to a measured zero and printed "new vs prior 30
 *    days" — a growth claim for a window in which the dimension did not exist.
 *    The whole body of `deltaFor` below its first line had ZERO coverage: every
 *    fixture in all four existing test files passes `comparison: undefined`.
 *  - ANL-UX-5: the trend's right edge is permanently partial (today is still
 *    running) and nothing said so.
 *
 * Sabotage witnesses (grade-tests wave 8): dropping the trend/events sections
 * from the summary-failure branch, widening that branch to an events failure,
 * coercing an absent prior with `?? 0` OR deleting the `prior === undefined`
 * guard, the `deltaNew`/`deltaFlat`/sign branches, the `partial` flag either
 * way, `historyKnown` either way, or the first-event date each turn a case red.
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
  // ADR 0951 — the behavior-capture section reads its own status; inert here.
  getHeatPages: async () => [],
  getHeatmap: async () => { throw new Error('not read in this suite'); },
  getBehaviorSettings: async () => ({ heatmaps: { enabled: false }, replay: { enabled: false, storageConfigured: false, consentEnabled: false, available: false, retentionDays: 30 } }),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { AnalyticsPage } = await import('../AnalyticsPage.js');

const summary = (extra?: Partial<AnalyticsSummary>): AnalyticsSummary => ({
  total: 12, sessions: 2, byType: { pageview: 12, event: 0, conversion: 0 },
  topPaths: [], utmSources: [], ...extra,
});

const renderPage = (): void => { render(<MemoryRouter><AnalyticsPage /></MemoryRouter>); };

beforeEach(() => {
  vi.resetAllMocks();
  getNavReport.mockResolvedValue({ weeks: [], rows: [] });
  getEvents.mockResolvedValue([]);
  getTrend.mockResolvedValue([]);
});
afterEach(cleanup);

describe('ANL-UX-1 — a failed summary read does not discard what DID load', () => {
  it('keeps the events stream and the trend chart when only the summary failed', async () => {
    getSummary.mockRejectedValue(new Error('summary_500'));
    getEvents.mockResolvedValue([
      { eventId: 'e1', orgId: 'org:1', type: 'pageview', path: '/pricing', ts: '2026-08-17T09:00:00.000Z' },
    ]);
    getTrend.mockResolvedValue([
      { day: '2026-08-16', pageviews: 1, events: 0, conversions: 0, uniques: 0 },
      { day: '2026-08-17', pageviews: 4, events: 0, conversions: 0, uniques: 0 },
    ]);
    renderPage();

    // The failure is still named + retryable (the round-2 behaviour is kept)…
    await screen.findByText(/didn.t load/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    // …and the two reads that SUCCEEDED are still on screen. Pre-fix both were
    // replaced by the failure card.
    expect(await screen.findByText('/pricing')).toBeTruthy();
    expect(document.querySelector('.an-trend')).toBeTruthy();
    // The stream must not present as empty, either — that would be the other
    // dishonest direction.
    expect(screen.queryByText(/^no events\.$/i)).toBeNull();
  });

  it('a failed EVENTS read beside a good summary still says so per-panel (the mirror case)', async () => {
    getSummary.mockResolvedValue({ summary: summary(), firstEventAt: '2026-01-01T00:00:00.000Z' });
    getEvents.mockRejectedValue(new Error('events_500'));
    renderPage();
    await screen.findByText(/recent events couldn.t be loaded/i);
    // …while the figures it does not affect stay visible.
    expect(screen.getAllByText('12').length).toBeGreaterThan(0);
  });
});

describe('ANL-UX-3 — an ABSENT prior measurement renders no delta at all', () => {
  const comparison = { days: 30, total: 5, sessions: 1, pageviews: 5, conversions: 0 };

  it('omits the uniques delta when the prior window has no uniqueVisitors', async () => {
    // The real wire shape: `comparison.uniqueVisitors` is omitted whenever the
    // prior window holds no hashed rows — every tenant whose prior window
    // predates the ADR 0569 deployment.
    getSummary.mockResolvedValue({
      summary: summary({ uniqueVisitors: 9, uniqueVisitorsSince: '2026-08-10T00:00:00.000Z' }),
      comparison,
      firstEventAt: '2026-01-01T00:00:00.000Z',
    });
    renderPage();
    // Pre-fix this printed "new vs prior 30 days" beside the uniques tile. The
    // claim is NO delta of any spelling (a dropped guard renders "NaN% vs …"),
    // so assert on the whole tile, not one wrong sentence.
    const tile = (await screen.findByText('Daily uniques')).closest('button');
    expect(tile).not.toBeNull();
    expect(tile?.textContent ?? '').not.toMatch(/prior/i);
    // The CONTROL: the figures whose prior IS measured still show their delta,
    // so "renders nothing" cannot be satisfied by a page that lost deltas
    // entirely.
    expect(screen.getAllByText(/vs prior 30 days/i).length).toBeGreaterThan(0);
  });

  // ANL-UX-3 R2 — this case was hand-built and the "must stay reachable" claim
  // was UNBACKED: `computeSummary` emitted `uniqueVisitors` only when
  // `uniques > 0`, so a `0` could not occur on the wire and no tenant could ever
  // see this branch. The backend now emits an explicit `0` when the dimension
  // was live across the whole window (`summarizeForReport`'s
  // `withVisitorDimension`, pinned in `test/analytics-route.test.ts`), so the
  // fixture below is a shape the server actually sends.
  it('a genuinely MEASURED zero prior still says "new" (a shape the wire can now produce)', async () => {
    getSummary.mockResolvedValue({
      summary: summary({ uniqueVisitors: 9, uniqueVisitorsSince: '2026-08-10T00:00:00.000Z' }),
      comparison: { ...comparison, uniqueVisitors: 0 },
      firstEventAt: '2026-01-01T00:00:00.000Z',
    });
    renderPage();
    await screen.findByText('Daily uniques');
    expect(screen.getByText(/new vs prior 30 days/i)).toBeTruthy();
  });

  it('a non-zero prior renders the signed percentage, and an equal one renders "level"', async () => {
    // `deltaFor`'s remaining branches, which had no coverage at all.
    getSummary.mockResolvedValue({
      summary: summary({ total: 10, byType: { pageview: 10, event: 0, conversion: 0 } }),
      comparison: { days: 30, total: 5, sessions: 2, pageviews: 10, conversions: 0 },
      firstEventAt: '2026-01-01T00:00:00.000Z',
    });
    renderPage();
    await screen.findByText('Events');
    expect(screen.getAllByText(/\+100% vs prior 30 days/).length).toBeGreaterThan(0);   // total 10 vs 5
    expect(screen.getAllByText(/level with prior 30 days/i).length).toBeGreaterThan(0); // pageviews 10 vs 10
  });
});

describe('ANL-UX-5 — the trend discloses its partial right edge', () => {
  it('renders the in-progress note when the server marks today partial', async () => {
    getSummary.mockResolvedValue({ summary: summary(), firstEventAt: '2026-01-01T00:00:00.000Z' });
    getTrend.mockResolvedValue([
      { day: '2026-08-16', pageviews: 8, events: 0, conversions: 0, uniques: 0 },
      { day: '2026-08-17', pageviews: 2, events: 0, conversions: 0, uniques: 0, partial: true },
    ]);
    renderPage();
    expect(await screen.findByText(/today is still in progress/i)).toBeTruthy();
  });

  it('does NOT render it when no bucket is partial (so the note cannot become wallpaper)', async () => {
    getSummary.mockResolvedValue({ summary: summary(), firstEventAt: '2026-01-01T00:00:00.000Z' });
    getTrend.mockResolvedValue([
      { day: '2026-08-16', pageviews: 8, events: 0, conversions: 0, uniques: 0 },
      { day: '2026-08-17', pageviews: 9, events: 0, conversions: 0, uniques: 0 },
    ]);
    renderPage();
    await screen.findByText(/per utc day over the last 30 days/i);
    expect(screen.queryByText(/today is still in progress/i)).toBeNull();
  });
});

/**
 * ANL-UX-2 R2 — the absence guard. `firstEventAt === undefined` was read as PROOF
 * that this org has never reported, but an omitted field is also exactly what a
 * new SPA sees from an older backend (or from a stale cached summary). So the
 * "honest" zero-state was liable to tell a tenant with real history that
 * analytics is not installed — the inverse of the claim ANL-UX-2 removed.
 * `lifetime` is always sent by a backend that knows the answer; its own absence
 * is "unknown", and unknown is not "never".
 */
describe('ANL-UX-2 R2 — "never reported" is only claimed when the backend said so', () => {
  const empty = (): AnalyticsSummary => summary({ total: 0, sessions: 0, byType: { pageview: 0, event: 0, conversion: 0 } });

  it('claims "No analytics yet" when the backend REPORTED that this org has no history', async () => {
    getSummary.mockResolvedValue({ summary: empty(), lifetime: {} });
    renderPage();
    expect(await screen.findByText(/no analytics yet/i)).toBeTruthy();
  });

  it('does NOT claim it when the backend did not send the signal at all', async () => {
    // The old-backend / stale-summary shape: no `lifetime`, no `firstEventAt`.
    getSummary.mockResolvedValue({ summary: empty() });
    renderPage();
    expect(await screen.findByText(/no events to show/i)).toBeTruthy();
    expect(
      screen.queryByText(/no analytics yet/i),
      'an unknown history must never be presented as a missing installation',
    ).toBeNull();
  });

  it('still uses the reported first-event date when there IS history', async () => {
    getSummary.mockResolvedValue({
      summary: empty(),
      firstEventAt: '2026-01-01T00:00:00.000Z',
      lifetime: { firstEventAt: '2026-01-01T00:00:00.000Z' },
    });
    renderPage();
    // The windowed "quiet period" card, not either of the two above…
    expect(await screen.findByText(/no events in the last 30 days/i)).toBeTruthy();
    // …and it states the reported first-event date (the page's own formatter).
    expect(screen.getByText(new RegExp(`first event was ${formatDate('2026-01-01T00:00:00.000Z')}`))).toBeTruthy();
  });
});
