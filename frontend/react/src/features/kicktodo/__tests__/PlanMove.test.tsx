/**
 * ADR 0496 P3/P4 regression net — the §5.5 Plan surface:
 *  - the Move affordance appears ONLY on future, incomplete items (past/
 *    completed rows never offer it);
 *  - the flow is preview-BEFORE-confirm: confirm is unreachable until the
 *    server's dry-run compare renders, and a refusal shows the server's
 *    verbatim message;
 *  - the three views re-project the same read (challenge view groups rows);
 *  - the calendar disclosure renders only store-backed states and a failed
 *    status read never hides the plan.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const iso = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ITEMS = [
  { enrollmentId: 'enr:1', challengeId: 'chal:1', dateLocal: iso(0), day: 1, stableActivityId: 'a1', title: 'Today action', completed: false },
  { enrollmentId: 'enr:1', challengeId: 'chal:1', dateLocal: iso(2), day: 3, stableActivityId: 'a3', title: 'Future action', completed: false },
  { enrollmentId: 'enr:1', challengeId: 'chal:1', dateLocal: iso(1), day: 2, stableActivityId: 'a2', title: 'Done action', completed: true },
];

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPlan: vi.fn(() => Promise.resolve(ITEMS)),
  listChallengesForLocale: vi.fn(() => Promise.resolve([{ challenge: { id: 'chal:1', title: 'Deep Reading' } }])),
  previewRevision: vi.fn(() => Promise.resolve([{ lane: 'move', line: 'Move day 3 to a new date.', day: 3, fromDate: iso(2), toDate: iso(5) }])),
  applyRevision: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../client/kicktodoIntegrationsClient.js', () => ({
  getCalendarStatus: vi.fn(() => Promise.resolve({ transportConfigured: true })),
  getConsents: vi.fn(() => Promise.resolve([{ kind: 'calendar-project', grantedAt: '2026-07-01T00:00:00Z' }])),
}));

import { PlanPage } from '../PlanPage.js';
import { getPlan, previewRevision, applyRevision, RevisionRefusedError } from '../../../client/kicktodoClient.js';
import { getCalendarStatus } from '../../../client/kicktodoIntegrationsClient.js';

afterEach(cleanup);
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
    fireEvent.change(screen.getByLabelText('New date'), { target: { value: iso(5) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the change' }));
    await waitFor(() => screen.getByText('Move day 3 to a new date.'));
    expect(vi.mocked(previewRevision)).toHaveBeenCalledWith('enr:1', [{ lane: 'move', day: 3, toDate: iso(5) }]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }));
    await waitFor(() => expect(vi.mocked(applyRevision)).toHaveBeenCalledWith('enr:1', [{ lane: 'move', day: 3, toDate: iso(5) }]));
  });

  it('a server refusal renders VERBATIM (never a generic paint-over)', async () => {
    vi.mocked(previewRevision).mockRejectedValueOnce(new RevisionRefusedError('Command 0 (move) failed: window', 0));
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: /^Move “/ }));
    fireEvent.change(screen.getByLabelText('New date'), { target: { value: iso(5) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the change' }));
    await waitFor(() => screen.getByText('Command 0 (move) failed: window'));
    expect(screen.queryByRole('button', { name: 'Confirm move' })).toBeNull();
  });

  it('the challenge view groups the same read under the catalog title', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Future action'));
    fireEvent.click(screen.getByRole('button', { name: 'Challenge' }));
    await waitFor(() => screen.getByRole('heading', { name: 'Deep Reading' }));
  });

  it('calendar disclosure: connected renders the chip; a failed status read states unavailability WITHOUT hiding the plan', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Calendar connected'));
    cleanup();
    vi.mocked(getCalendarStatus).mockRejectedValueOnce(new Error('down'));
    renderPage();
    await waitFor(() => screen.getByText('Calendar status unavailable'));
    await waitFor(() => screen.getByText('Future action')); // the plan still renders
  });
});
