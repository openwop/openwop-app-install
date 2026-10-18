/**
 * Public/first-use UX closeout (#4031, df88eb26d) — a signed-out visitor to the
 * leaderboard sees the opt-in privacy explainer and a sign-in action, and the
 * page makes NO opt-in or enrolment read.
 *
 * Breaks it: removing `if (anonymous) return` in `reload` fires getOptIn /
 * listEnrollments; replacing the signed-out card loses the explainer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { getOptIn, listEnrollments } = vi.hoisted(() => ({
  getOptIn: vi.fn(),
  listEnrollments: vi.fn(),
}));

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: null, loading: false, isConfigured: true }),
}));
vi.mock('../../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">Sign in to KickTodo</button>,
}));
vi.mock('../../../client/kicktodoEngagementClient.js', () => ({
  getOptIn,
  joinLeaderboard: vi.fn(),
  leaveLeaderboard: vi.fn(),
  getLeaderboard: vi.fn(),
  getAwards: vi.fn(),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments,
  listChallenges: vi.fn(),
}));

import { EngagementPage } from '../EngagementPage.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EngagementPage signed out', () => {
  it('explains opt-in privacy and never offers or loads the leaderboard', () => {
    render(<EngagementPage />);

    expect(screen.getByText(en.signedOutTitle)).toBeTruthy();
    expect(screen.getByText(en.signedOutPrivacy)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in to KickTodo' })).toBeTruthy();
    // Double guard, kept as a belt: an anonymous `reload` returns before
    // `setLoaded(true)`, so the join card's `loaded` term already hides it and its
    // `!anonymous` term is unreachable here (w42 probe eng-anon-join-gate,
    // vacuous). The load-bearing piece is the `reload` guard, witnessed by the
    // getOptIn / listEnrollments assertions below.
    expect(screen.queryByRole('button', { name: en.joinCta })).toBeNull();
    expect(getOptIn).not.toHaveBeenCalled();
    expect(listEnrollments).not.toHaveBeenCalled();
  });
});
