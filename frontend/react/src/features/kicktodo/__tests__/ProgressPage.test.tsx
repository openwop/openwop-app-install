/**
 * KickTodo Progress (ADR 0436 §5.6, 6e4a137e1 "make Progress evidence-led").
 * Every figure states its basis ("4 of 10 required actions"); an UNKNOWN plan
 * basis is stated, never rendered as 0% / an empty meter; a failed read is an
 * ANNOUNCED failure with a working retry, never the empty "browse challenges"
 * state (failed ≠ empty). Breaks if: the catalog title, meter basis, narrative
 * or next-step link drift; `hasPlanBasis` admits a zero total; the catch maps
 * to rows; retry stops re-reading; or the failure card stops announcing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Enrollment, NegotiatedChallenge, ProgressView } from '../../../client/kicktodoClient.js';
import type { listChallengesForLocale, listEnrollmentsWithProgress } from '../../../client/kicktodoClient.js';

const kt = vi.hoisted(() => ({
  listEnrollmentsWithProgress: vi.fn<typeof listEnrollmentsWithProgress>(),
  listChallengesForLocale: vi.fn<typeof listChallengesForLocale>(),
}));

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { ProgressPage } from '../ProgressPage.js';
import { messages as en } from '../i18n/en.js';
import { announce, currentAnnouncements } from '../../../ui/announce.js';

const progress = (overrides: Partial<ProgressView> = {}): ProgressView => ({
  enrollmentId: 'enroll-focus',
  state: 'active',
  goalState: null,
  currentDay: 4,
  durationDays: 14,
  totalRequiredActivities: 10,
  completedActivities: 4,
  checkInCount: 3,
  trace: [],
  recovery: { offered: 0, completed: 0 },
  ...overrides,
});
const enrollment: Enrollment = {
  id: 'enroll-focus', challengeId: 'focus', challengeVersion: 1, state: 'active', goalId: 'goal-focus',
  planRevision: 1, timezone: 'UTC', startDateLocal: '2026-09-01',
};
const catalog: NegotiatedChallenge[] = [{
  challenge: {
    id: 'focus', version: 1, status: 'published', title: 'Focus gently', summary: 'Protect one block.', outcome: 'A focus rhythm.',
    durationDays: 14, activities: [],
  },
  servedLocale: 'en',
  exactLocale: true,
}];

const mount = () => render(<MemoryRouter><ProgressPage /></MemoryRouter>);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  announce('');
  kt.listChallengesForLocale.mockResolvedValue(catalog);
  kt.listEnrollmentsWithProgress.mockResolvedValue({
    enrollments: [enrollment],
    progress: { 'enroll-focus': progress() },
  });
});

describe('Progress — evidence-led journey', () => {
  it('separates plan position, observed evidence, interpretation, and the next move', async () => {
    mount();

    expect(await screen.findByRole('heading', { name: 'Focus gently' })).toBeTruthy();
    expect(screen.getByText(en.progressPlanHeading)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '4 of 10 required actions complete' })).toBeTruthy();
    expect(screen.getByText(en.progressFigObserved)).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.progressNarrativeBuildingTitle })).toBeTruthy();
    expect(screen.getByRole('heading', { name: en.progressNextActionTitle })).toBeTruthy();
    expect(screen.getByRole('link', { name: en.navTodayLabel }).getAttribute('href')).toBe('/today');
  });

  it('states an unknown plan basis instead of fabricating zero progress', async () => {
    kt.listEnrollmentsWithProgress.mockResolvedValue({
      enrollments: [enrollment],
      progress: { 'enroll-focus': progress({ totalRequiredActivities: 0, completedActivities: 0 }) },
    });

    mount();

    expect(await screen.findByText(en.progressPlanUnknown)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.body.textContent).not.toContain('0%');
  });

  it('turns a failed read into an announced, working recovery action', async () => {
    kt.listEnrollmentsWithProgress
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce({ enrollments: [], progress: {} });

    mount();

    expect(await screen.findByText(en.progressLoadErrorBody)).toBeTruthy();
    // Announced through the ONE global live region (StateCard `announce`).
    // The announcement comes from a passive effect that can flush after findBy sees the DOM; wait for it.
    await waitFor(() => expect(currentAnnouncements().polite).toContain(en.progressLoadError));
    expect(screen.queryByRole('link', { name: en.browseChallenges })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.progressRetry }));
    await waitFor(() => expect(kt.listEnrollmentsWithProgress).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('link', { name: en.browseChallenges })).toBeTruthy();
    expect(screen.queryByText(en.progressLoadErrorBody)).toBeNull();
  });
});

describe('Progress — the goal is the outcome truth (ADR 0908, GL2UX-3)', () => {
  it('a satisfied goal reads complete even before the enrollment row is projected', async () => {
    kt.listEnrollmentsWithProgress.mockResolvedValue({ enrollments: [enrollment], progress: { 'enroll-focus': progress({ goalState: 'satisfied' }) } });
    mount();
    expect(await screen.findByText(en.progressCompleted)).toBeTruthy();
  });

  it('a goal past its limit says the journey ended and offers the next move', async () => {
    kt.listEnrollmentsWithProgress.mockResolvedValue({ enrollments: [enrollment], progress: { 'enroll-focus': progress({ goalState: 'bound-exceeded' }) } });
    mount();
    expect(await screen.findByText(en.progressEndedChip)).toBeTruthy();
    expect(screen.getByText(en.progressJourneyEnded)).toBeTruthy();
    expect(screen.getByText(en.progressStatusEnded)).toBeTruthy();
    expect(screen.queryByText(en.progressCompleted)).toBeNull();
    expect(screen.getByRole('link', { name: en.browseChallenges }).getAttribute('href')).toBe('/discover');
  });

  it('an escalated goal says it waits on a review', async () => {
    kt.listEnrollmentsWithProgress.mockResolvedValue({ enrollments: [enrollment], progress: { 'enroll-focus': progress({ goalState: 'escalated' }) } });
    mount();
    expect(await screen.findByText(en.progressEscalatedChip)).toBeTruthy();
    expect(screen.getByText(en.progressStatusEscalated)).toBeTruthy();
  });
});
