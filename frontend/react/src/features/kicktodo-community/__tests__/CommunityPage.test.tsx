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
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

const emptyReviews = { reviews: [], aggregate: { count: 0, average: null } };

vi.mock('../../../client/kicktodoClient.js', () => ({
  listEnrollments: vi.fn(() => Promise.resolve([{ id: 'enr:1', challengeId: 'ch:1', state: 'active' }])),
  listChallenges: vi.fn(() => Promise.resolve([{ id: 'ch:1', title: 'Focus Sprint' }])),
}));

// Per-test behaviour via a mutable ref read inside the factory — the pattern
// that keeps the rejected promise inside the factory closure (a delegating
// arrow to a hoisted vi.fn surfaced the rejection as unhandled under vitest 4).
const state: { getReviews: () => Promise<typeof emptyReviews> } = {
  getReviews: () => Promise.resolve(emptyReviews),
};
vi.mock('../../../client/kicktodoCommunityClient.js', () => ({
  getMyProfile: vi.fn(() => Promise.resolve({ handle: 'ada', displayName: 'Ada', bio: '' })),
  saveProfile: vi.fn(),
  submitMyProfile: vi.fn(),
  getReviews: () => state.getReviews(),
  writeReview: vi.fn(),
  CommunityRequestError: class extends Error {},
}));

import { CommunityPage } from '../CommunityPage.js';

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
    state.getReviews = () => Promise.reject(Object.assign(new Error('HTTP 429'), { status: 429 }));
    render(<CommunityPage />);
    // The reviews section renders (the challenge title is present)…
    await waitFor(() => expect(screen.getByText('Focus Sprint')).toBeTruthy());
    // …and the honest failure copy appears where the aggregate would be.
    expect(screen.getByText('Could not load this.')).toBeTruthy();
  });

  it('KTUX-11 — a successful empty fetch does NOT show the failure copy', async () => {
    render(<CommunityPage />);
    await waitFor(() => expect(screen.getByLabelText('Handle')).toBeTruthy());
    expect(screen.queryByText('Could not load this.')).toBeNull();
  });
});
