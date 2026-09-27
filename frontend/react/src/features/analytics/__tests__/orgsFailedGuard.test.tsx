/**
 * Analytics — a FAILED workspace read must not be rendered as "No organizations".
 *
 * `AnalyticsPage` consumes the shared `ui/useOrgSelection` seam correctly (its
 * `orgsFailed` branch sits ABOVE both the skeleton and the empty branch), but
 * nothing failed when the seam itself was sabotaged: replacing the hook's
 * `setOrgsFailed(true)` with `setOrgs([])` — the exact idiom the hook exists to
 * kill — left the whole analytics suite green while the page told every user
 * with a 500 that they had no organizations and should "create an organization
 * first". This file is that missing guard: it drives the REAL page through the
 * REAL `analyticsClient.listOrgs`, so a regression in the shared seam turns it
 * red here.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a page that
 * rendered nothing at all would satisfy it:
 *   - read FAILS   → the honest, retryable failure card; NEVER "No organizations"
 *   - read SUCCEEDS but is genuinely empty → the real "No organizations" survives
 *     and no failure card appears
 *   - positive control → with an organization the page renders AND reads
 *
 * HG-4 — the three states now come from `ui/OrgSelectionState`, so the copy
 * asserted here is the SHARED sentence plus this feature's own clause. The page
 * had the branch order INVERTED before the migration (the skeleton was checked
 * ABOVE the zero-org branch), so the zero-org case below also pins that a
 * successful "none" never renders as a `role="status"` "Loading…" live region —
 * the a11y half of the defect, where a screen-reader user is told forever that
 * work is in progress over a read that already answered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  getSummary: vi.fn(),
  getEvents: vi.fn(),
  getNavReport: vi.fn(),
}));
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

beforeEach(() => {
  vi.clearAllMocks();
  // Id-sensitive: the page hosts TWO toggles — `analytics` and the default-OFF
  // `workspace-nav-telemetry` (ADR 0512), whose own failure line must not
  // contaminate these assertions.
  access.useFeatureAccess.mockImplementation((id: string) => makeFeatureAccess({ enabled: id === 'analytics', loading: false }));
  // ANL-UX-2 — `firstEventAt` is what tells the page the beacon has ever
  // reported. This fixture is a tenant that HAS traffic history but a quiet
  // 30-day window, which is the state the positive control below asserts.
  api.getSummary.mockResolvedValue({ summary: { total: 0, sessions: 0, byType: { pageview: 0, event: 0, conversion: 0 }, topPaths: [], utmSources: [], vitals: [] }, comparison: null, firstEventAt: '2026-01-05T10:00:00.000Z' });
  api.getEvents.mockResolvedValue([]);
  api.getNavReport.mockResolvedValue({ rows: [] });
});
afterEach(cleanup);

const view = (): void => { render(<MemoryRouter><AnalyticsPage /></MemoryRouter>); };

describe('analytics — a failed workspace read is not an empty account', () => {
  it('read FAILS: the honest retryable card — and NEVER "No organizations"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view();
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    // EXACT, not a regex over a fragment: a loose match would accept the old
    // per-feature sentence and the shared one alike, so it could never have
    // caught the migration changing which noun the card uses.
    expect(screen.getByText(
      'The analytics summary was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // The false claim must be absent — title AND the zero-org clause under it.
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Analytics belong to an organization.')).toBeNull();
    // …and it must not fall through to the loading branch either. `SkeletonRows`
    // is a `role="status"` live region labelled "Loading…", so that fall-through
    // tells a screen-reader user that a read which already failed is in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    // The dependent reads are org-gated, so a failed org read means they never
    // ran — which is precisely why the failure has to be said out loud here.
    expect(api.getSummary).not.toHaveBeenCalled();
    expect(api.getEvents).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-organization card, never an endless skeleton', async () => {
    api.listOrgs.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Analytics belong to an organization.')).toBeTruthy();
    // …and no failure disclosure, because nothing failed.
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    // The inverted-order defect's signature: the server answered "none", `orgId`
    // stays '', the summary read never starts, and a loading branch above the
    // empty one would therefore never terminate.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(api.getSummary).not.toHaveBeenCalled();
    expect(api.getEvents).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the page renders AND reads', async () => {
    // Without this, both assertions above would pass on a page that rendered
    // nothing and read nothing — for reasons having nothing to do with the guard.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    view();
    // R2 AN-SP-2 — a zero-total summary under the DEFAULT 30-day window now
    // renders the windowed-quiet copy, not the not-installed claim.
    expect(await screen.findByText(/No events in the last 30 days/)).toBeTruthy();
    await waitFor(() => expect(api.getSummary).toHaveBeenCalled());
    expect(api.getSummary.mock.calls[0]?.[0]).toBe('o1');
    expect(api.getEvents).toHaveBeenCalled();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});
