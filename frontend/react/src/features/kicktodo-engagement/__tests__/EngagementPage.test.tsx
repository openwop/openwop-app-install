/**
 * KTUX-7 regression net — the join form's display-name control must resolve by
 * an accessible LABEL, not its placeholder (the Phase-1 Field migration). The
 * form renders only in the not-yet-opted-in state.
 *
 * Breaks it: a label not wired to the input, a join form that is missing for a
 * caller who has not joined, or one that is still offered to a caller who has.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { EngagementOptIn, KicktodoAward, LeaderboardView } from '../../../client/kicktodoEngagementClient.js';
import type { ChallengeSummary, Enrollment } from '../../../client/kicktodoClient.js';

const { getOptIn } = vi.hoisted(() => ({
  getOptIn: vi.fn<typeof import('../../../client/kicktodoEngagementClient.js').getOptIn>(),
}));

const BOARD: LeaderboardView = { entries: [], belowFloor: true };
const AWARDS: KicktodoAward[] = [];
const ENROLLMENTS: Enrollment[] = [
  { id: 'enr:1', challengeId: 'chal:sleep', challengeVersion: 1, state: 'active', goalId: 'g', planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01' },
];
const CHALLENGES: ChallengeSummary[] = [
  { id: 'chal:sleep', version: 1, status: 'published', title: 'Sleep Reset', summary: 's', outcome: 'o', durationDays: 7, activities: [] },
];

vi.mock('../../../client/kicktodoEngagementClient.js', () => ({
  getOptIn,
  joinLeaderboard: vi.fn(),
  leaveLeaderboard: vi.fn(),
  // Shape matches `LeaderboardView` — the previous `{ rows, k }` was not the
  // API's shape at all, and nothing caught it because the board only rendered
  // for an opted-in caller and this test is the not-opted-in case. ADR 0641 d13
  // makes the board visible to any enrolled caller, so the branch now renders.
  getLeaderboard: vi.fn(() => Promise.resolve(BOARD)),
  getAwards: vi.fn(() => Promise.resolve(AWARDS)),
}));

// ADR 0641 decision 13 — the page now resolves WHICH challenge's board to show
// from the caller's own enrollments, so these two reads are on the load path.
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve(ENROLLMENTS)),
  listChallenges: vi.fn(() => Promise.resolve(CHALLENGES)),
}));

import { EngagementPage } from '../EngagementPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(cleanup);
beforeEach(() => {
  getOptIn.mockReset();
  getOptIn.mockResolvedValue(null); // not opted in → join form shows
});

describe('EngagementPage', () => {
  it('the display-name control resolves by an accessible label', async () => {
    render(<EngagementPage />);
    await waitFor(() => expect(screen.getByLabelText(en.displayNameLabel)).toBeTruthy());
  });

  it('an opted-in caller sees Leave, not the join form', async () => {
    const joined: EngagementOptIn = { displayName: 'Ada', optedInAt: '2026-01-02T00:00:00.000Z' };
    getOptIn.mockResolvedValue(joined);
    render(<EngagementPage />);
    // Positive control first: the page has loaded and rendered the board.
    expect(await screen.findByRole('button', { name: en.leaveCta })).toBeTruthy();
    expect(screen.queryByLabelText(en.displayNameLabel)).toBeNull();
  });
});
