/**
 * KTUX-7 regression net — the join form's display-name control must resolve by
 * an accessible LABEL, not its placeholder (the Phase-1 Field migration). The
 * form renders only in the not-yet-opted-in state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../client/kicktodoEngagementClient.js', () => ({
  getOptIn: vi.fn(() => Promise.resolve(null)),          // not opted in → join form shows
  joinLeaderboard: vi.fn(),
  leaveLeaderboard: vi.fn(),
  // Shape matches `LeaderboardView` — the previous `{ rows, k }` was not the
  // API's shape at all, and nothing caught it because the board only rendered
  // for an opted-in caller and this test is the not-opted-in case. ADR 0641 d13
  // makes the board visible to any enrolled caller, so the branch now renders.
  getLeaderboard: vi.fn(() => Promise.resolve({ entries: [], belowFloor: true })),
  getAwards: vi.fn(() => Promise.resolve([])),
}));

// ADR 0641 decision 13 — the page now resolves WHICH challenge's board to show
// from the caller's own enrollments, so these two reads are on the load path.
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve([
    { id: 'enr:1', challengeId: 'chal:sleep', challengeVersion: 1, state: 'active', goalId: 'g', planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01' },
  ])),
  listChallenges: vi.fn(() => Promise.resolve([{ id: 'chal:sleep', title: 'Sleep Reset' }])),
}));

import { EngagementPage } from '../EngagementPage.js';
afterEach(cleanup);

describe('EngagementPage', () => {
  it('the display-name control resolves by an accessible label', async () => {
    render(<EngagementPage />);
    await waitFor(() => expect(screen.getByLabelText('Display name')).toBeTruthy());
  });
});
