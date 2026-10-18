/**
 * The first KickTodo React component test. Pins two Phase-1 fixes that static
 * gates cannot see:
 *
 *  - KTUX-7: the profile controls carry a real accessible LABEL, not their
 *    placeholder (which vanishes the moment the user types — WCAG 2.2 §3.3.2).
 *    `getByLabelText` only resolves if the label↔control wiring is correct.
 *  - KTUX-11: a review-fetch failure renders a "couldn't load" message, NOT the
 *    designed "no reviews yet" empty state — a rate-limit must never be shown to
 *    the user as a truth about their data.
 *
 * The failed read uses the client's real `CommunityRequestError` (what
 * `getReviews` throws on a non-2xx), and the empty-state copy it must NOT fall
 * back to ("Rating appears after 3 reviews") is asserted absent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ChallengeSummary, Enrollment } from '../../../client/kicktodoClient.js';
import type { CreatorProfile, ReviewAggregate, VisibleReview } from '../../../client/kicktodoCommunityClient.js';

type Reviews = { reviews: VisibleReview[]; aggregate: ReviewAggregate };
const emptyReviews: Reviews = { reviews: [], aggregate: { count: 0, average: null } };
const PROFILE: CreatorProfile = { handle: 'ada', displayName: 'Ada', bio: '', links: [], state: 'draft' };
const ENROLLMENTS: Enrollment[] = [
  { id: 'enr:1', challengeId: 'ch:1', challengeVersion: 1, state: 'active', goalId: 'g:1', planRevision: 1, timezone: 'UTC', startDateLocal: '2026-01-01' },
];
const CHALLENGES: ChallengeSummary[] = [
  { id: 'ch:1', version: 1, status: 'published', title: 'Focus Sprint', summary: 's', outcome: 'o', durationDays: 14, activities: [] },
];

vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve(ENROLLMENTS)),
  listChallenges: vi.fn(() => Promise.resolve(CHALLENGES)),
}));

// Per-test behaviour via a mutable ref read inside the factory — the pattern
// that keeps the rejected promise inside the factory closure (a delegating
// arrow to a hoisted vi.fn surfaced the rejection as unhandled under vitest 4).
const state: { getReviews: () => Promise<Reviews> } = {
  getReviews: () => Promise.resolve(emptyReviews),
};
vi.mock('../../../client/kicktodoCommunityClient.js', async (orig) => ({
  getMyProfile: vi.fn(() => Promise.resolve(PROFILE)),
  saveProfile: vi.fn(),
  submitMyProfile: vi.fn(),
  getReviews: () => state.getReviews(),
  writeReview: vi.fn(),
  // The REAL error class — the type `getReviews` throws in production.
  CommunityRequestError: (await orig<typeof import('../../../client/kicktodoCommunityClient.js')>()).CommunityRequestError,
}));

import { CommunityPage } from '../CommunityPage.js';
import { CommunityRequestError } from '../../../client/kicktodoCommunityClient.js';
import { messages as en } from '../i18n/en.js';

afterEach(() => {
  cleanup();
  state.getReviews = () => Promise.resolve(emptyReviews);
});

describe('CommunityPage', () => {
  it('KTUX-7 — profile controls resolve by an accessible label, not a placeholder', async () => {
    render(<CommunityPage />);
    // Role+name queries use the REAL accname algorithm (aria-label overrides
    // the label association), so the base fields resolve uniquely while each
    // per-locale overlay carries its locale-suffixed aria-label (UX-T3).
    // These queries FAIL if the input is named only by its placeholder.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Handle' })).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Short bio' })).toBeTruthy();
    // And an overlay keeps its unique, locale-qualified accessible name.
    expect(screen.getAllByRole('textbox', { name: /Display name \(/ }).length).toBeGreaterThan(0);
  });

  it('KTUX-11 — a failed review fetch shows "could not load", never a fabricated empty state', async () => {
    state.getReviews = () => Promise.reject(new CommunityRequestError(429));
    render(<CommunityPage />);
    // The reviews section renders (the challenge title is present)…
    await waitFor(() => expect(screen.getByText('Focus Sprint')).toBeTruthy());
    // …and the honest failure copy appears where the aggregate would be.
    expect(screen.getByText('Could not load this.')).toBeTruthy();
    // …and NOT the designed empty-aggregate copy a fabricated `[]` would render.
    expect(screen.queryByText(en.aggregateFloor)).toBeNull();
  });

  it('KTUX-11 — a successful empty fetch does NOT show the failure copy', async () => {
    render(<CommunityPage />);
    await waitFor(() => expect(screen.getByLabelText('Handle')).toBeTruthy());
    // Positive control: the reviews row rendered its (genuinely) empty aggregate.
    expect(screen.getByText(en.aggregateFloor)).toBeTruthy();
    expect(screen.queryByText('Could not load this.')).toBeNull();
  });
});
