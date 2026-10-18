/**
 * ADR 0496 P3/P4 regression net — the §5.5 Plan surface:
 *  - the Move affordance appears ONLY on future, incomplete items (past/
 *    completed rows never offer it);
 *  - the flow is preview-BEFORE-confirm: confirm is unreachable until the
 *    server's dry-run compare renders;
 *  - PT-4: a refusal renders LOCALIZED copy keyed by its reason/status, never
 *    the server's English message or a bare `revision request failed: 500`
 *    (breaks if PlanPage renders `err.message` again);
 *  - PT-5: closing the panel (cancel or confirm) returns focus to the item's
 *    Move trigger, or to the page title when the item left the window (breaks
 *    if the pending-focus effect is removed);
 *  - the three views re-project the same read (challenge view groups rows);
 *  - the calendar disclosure renders only store-backed states and a failed
 *    status read never hides the plan.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { NegotiatedChallenge, PlanChange, PlanItem } from '../../../client/kicktodoClient.js';
import type { IntegrationConsent } from '../../../client/kicktodoIntegrationsClient.js';

// The page computes "today" at RENDER (`isoDaysFromToday(0)`), so the fixture
// dates must be derived from the SAME pinned clock, never at module load (a run
// straddling local midnight re-classified the rows). Only `Date` is faked; React
// and testing-library timers stay real.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const iso = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const items = (): PlanItem[] => [
  { enrollmentId: 'enr:1', challengeId: 'chal:1', dateLocal: iso(0), day: 1, stableActivityId: 'a1', title: 'Today action', completed: false },
  { enrollmentId: 'enr:1', challengeId: 'chal:1', dateLocal: iso(2), day: 3, stableActivityId: 'a3', title: 'Future action', completed: false },
  { enrollmentId: 'enr:1', challengeId: 'chal:1', dateLocal: iso(1), day: 2, stableActivityId: 'a2', title: 'Done action', completed: true },
];
const catalog = (): NegotiatedChallenge[] => [{
  challenge: {
    id: 'chal:1', version: 1, status: 'published', title: 'Deep Reading', summary: 'Read deeply.', outcome: 'A reading habit.',
    durationDays: 14, activities: [],
  },
  servedLocale: 'en',
  exactLocale: true,
}];
const preview = (): PlanChange[] => [{ lane: 'move', line: 'Move day 3 to a new date.', day: 3, fromDate: iso(2), toDate: iso(5) }];
const consents = (): IntegrationConsent[] => [{ kind: 'calendar-project', grantedAt: '2026-07-01T00:00:00Z' }];

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPlan: vi.fn(),
  listChallengesForLocale: vi.fn(),
  previewRevision: vi.fn(),
  applyRevision: vi.fn(),
}));
vi.mock('../../../client/kicktodoIntegrationsClient.js', () => ({
  getCalendarStatus: vi.fn(),
  getConsents: vi.fn(),
}));

import { PlanPage } from '../PlanPage.js';
import { getPlan, listChallengesForLocale, previewRevision, applyRevision, RevisionRefusedError } from '../../../client/kicktodoClient.js';
import { getCalendarStatus, getConsents } from '../../../client/kicktodoIntegrationsClient.js';
import { messages as en } from '../i18n/en.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  vi.mocked(getPlan).mockImplementation(async () => items());
  vi.mocked(listChallengesForLocale).mockImplementation(async () => catalog());
  vi.mocked(previewRevision).mockImplementation(async () => preview());
  vi.mocked(applyRevision).mockResolvedValue(undefined);
  vi.mocked(getCalendarStatus).mockResolvedValue({ transportConfigured: true });
  vi.mocked(getConsents).mockImplementation(async () => consents());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const renderPage = () => render(<MemoryRouter><PlanPage /></MemoryRouter>);

describe('PlanPage §5.5 (ADR 0496)', () => {
  it('empty: leads with the challenge CTA and sample week, without inert plan controls', async () => {
    vi.mocked(getPlan).mockResolvedValueOnce([]);
    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Nothing planned this week' }));
    expect(screen.queryByRole('group', { name: 'Plan view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous week' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Find a challenge' }).getAttribute('href')).toBe('/discover');
    expect(screen.getByRole('img', { name: /Example week/ })).toBeTruthy();
  });

  it('Move… appears ONLY on the future incomplete item; past/completed rows never offer it', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    const moves = screen.getAllByRole('button', { name: /^Move “/ });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.getAttribute('aria-label')).toContain('Future action');
  });

  it('preview-before-confirm: the compare renders the dry-run, THEN confirm applies and the plan reloads', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: /^Move “/ }));
    expect(screen.queryByRole('button', { name: 'Confirm move' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^New date/), { target: { value: iso(5) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the change' }));
    await waitFor(() => screen.getByText('Move day 3 to a new date.'));
    expect(vi.mocked(previewRevision)).toHaveBeenCalledWith('enr:1', [{ lane: 'move', day: 3, toDate: iso(5) }]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() => expect(vi.mocked(applyRevision)).toHaveBeenCalledWith('enr:1', [{ lane: 'move', day: 3, toDate: iso(5) }]));
    // …and the plan reloads (a second read of the same window) with the panel closed.
    await waitFor(() => expect(vi.mocked(getPlan)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('region', { name: en.planMovePanelLabel })).toBeNull());
    expect(screen.getByText('Future action')).toBeTruthy();
  });

  const refuse = async (err: unknown, via: 'preview' | 'confirm' = 'preview'): Promise<void> => {
    if (via === 'preview') vi.mocked(previewRevision).mockRejectedValueOnce(err);
    else vi.mocked(applyRevision).mockRejectedValueOnce(err);
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: /^Move “/ }));
    fireEvent.change(screen.getByLabelText(/^New date/), { target: { value: iso(5) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the change' }));
    if (via === 'confirm') {
      await waitFor(() => screen.getByText('Move day 3 to a new date.'));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
    }
  };

  it('PT-4: a guard refusal renders the localized copy for ITS reason, never the server text', async () => {
    await refuse(new RevisionRefusedError('Command 0 (move) failed: window', 0, 409, 'validation_error'));
    await waitFor(() => screen.getByText(en.planMoveRefusedWindow));
    expect(screen.queryByText(/Command 0/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm move' })).toBeNull();
  });

  it('PT-4: distinct reasons get distinct copy (checked-in on confirm)', async () => {
    await refuse(new RevisionRefusedError('Command 0 (move) failed: checked-in', 0, 409, 'validation_error'), 'confirm');
    await waitFor(() => screen.getByText(en.planMoveRefusedCheckedIn));
    expect(screen.queryByText(en.planMoveRefusedWindow)).toBeNull();
  });

  it('PT-4: a bare HTTP failure never leaks `revision request failed: 500`', async () => {
    await refuse(new RevisionRefusedError('revision request failed: 500', undefined, 500));
    await waitFor(() => screen.getByText(en.planMoveError));
    expect(screen.queryByText(/revision request failed/)).toBeNull();
  });

  it('PT-4: a 404 (enrollment gone / not yours) says the challenge is not active', async () => {
    await refuse(new RevisionRefusedError('Enrollment not found.', undefined, 404, 'not_found'));
    await waitFor(() => screen.getByText(en.planMoveRefusedInactive));
    expect(screen.queryByText('Enrollment not found.')).toBeNull();
  });

  it('PT-5: cancel returns focus to the Move trigger', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: /^Move “/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^New date/)));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label') ?? '').toMatch(/^Move “Future action/));
  });

  it('PT-5: confirm returns focus to the moved item’s trigger after the re-read, or the title if it left the window', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: /^Move “/ }));
    fireEvent.change(screen.getByLabelText(/^New date/), { target: { value: iso(5) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the change' }));
    await waitFor(() => screen.getByText('Move day 3 to a new date.'));
    // After the confirm the re-read no longer has the item in this window.
    vi.mocked(getPlan).mockImplementationOnce(async () => items().filter((it) => it.day !== 3));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: en.planTitle })));
  });

  it('the challenge view groups the same read under the catalog title', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: 'Challenge' }));
    await waitFor(() => screen.getByRole('heading', { name: 'Deep Reading' }));
    // The SAME read, re-projected: no new fetch, and every row sits in the group.
    expect(vi.mocked(getPlan)).toHaveBeenCalledTimes(1);
    const group = within(screen.getByRole('region', { name: 'Deep Reading' }));
    for (const title of ['Today action', 'Future action', 'Done action']) expect(group.getByText(title)).toBeTruthy();
  });

  it('calendar disclosure: connected renders the chip; a failed status read states unavailability WITHOUT hiding the plan; no transport discloses nothing', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Calendar connected'));
    cleanup();
    vi.mocked(getCalendarStatus).mockRejectedValueOnce(new Error('down'));
    renderPage();
    await waitFor(() => screen.getByText('Calendar status unavailable'));
    await waitFor(() => screen.getByText('Future action')); // the plan still renders
    cleanup();
    // No transport configured → nothing is disclosed (disclosure, not an ad).
    vi.mocked(getCalendarStatus).mockResolvedValueOnce({ transportConfigured: false });
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    await waitFor(() => expect(vi.mocked(getCalendarStatus)).toHaveBeenCalledTimes(3));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(screen.queryByText(en.planCalendar_connected)).toBeNull();
    expect(screen.queryByText(en.planCalendar_unavailable)).toBeNull();
  });
});
