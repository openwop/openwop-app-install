/**
 * PT-2 — a failed SIDE read is "we could not check", never "there is nothing".
 *
 * Five participant pages fetched a secondary read (the enrolment rows or the
 * catalog titles) with `.catch(() => [])`. The page survived, but the failure
 * rendered as absence: Today's reminder controls and enrolment welcome
 * vanished, Progress/Plan showed raw challenge ids as titles, Journal entries
 * lost their challenge chip, and Discover lost its whole catalog when only the
 * enrolment badge read failed. Each now states the gap with a working Retry
 * (the KT-G1 `enrollmentUnknown` posture in ChallengeDetailPage).
 *
 * Mocked: the kicktodo client module (every read below), the calendar
 * integrations client, the auth/session hooks. Breaks if any page goes back to
 * swallowing its side read to `[]`, if the Retry stops re-reading, or if
 * Today's welcome is again confirmed ONLY by the enrolment-list read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  ChallengeSummary, Enrollment, getJournal, getPlan, getToday, listChallenges, listChallengesForLocale,
  listEnrollments, listEnrollmentsWithProgress, NegotiatedChallenge, recommendedChallenges, TodayAction, TodayView,
} from '../../../client/kicktodoClient.js';

vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: null, resolved: true }) }));
// A STABLE user object: DiscoverPage's read effect depends on `user`, so a fresh
// object per render would re-read forever.
const auth = vi.hoisted(() => ({ user: { uid: 'u1' }, loading: false }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../../client/kicktodoIntegrationsClient.js', () => ({
  getCalendarStatus: vi.fn(async () => ({ transportConfigured: false })),
  getConsents: vi.fn(async () => []),
}));

const kt = vi.hoisted(() => ({
  getToday: vi.fn<typeof getToday>(),
  listEnrollments: vi.fn<typeof listEnrollments>(),
  listChallenges: vi.fn<typeof listChallenges>(),
  listChallengesForLocale: vi.fn<typeof listChallengesForLocale>(),
  listEnrollmentsWithProgress: vi.fn<typeof listEnrollmentsWithProgress>(),
  getJournal: vi.fn<typeof getJournal>(),
  getPlan: vi.fn<typeof getPlan>(),
  recommendedChallenges: vi.fn<typeof recommendedChallenges>(),
}));
vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { TodayPage } from '../TodayPage.js';
import { ProgressPage } from '../ProgressPage.js';
import { JournalPage } from '../JournalPage.js';
import { PlanPage } from '../PlanPage.js';
import { DiscoverPage } from '../DiscoverPage.js';
import { messages as en } from '../i18n/en.js';

const summary = (id: string, title: string): ChallengeSummary => ({
  id, version: 1, status: 'published', title, summary: `${title} summary`, outcome: `${title} outcome`, durationDays: 14, activities: [],
});
const negotiated = (c: ChallengeSummary): NegotiatedChallenge => ({ challenge: c, servedLocale: 'en', exactLocale: true });
const enrollmentRow = (id: string, challengeId: string): Enrollment => ({
  id, challengeId, challengeVersion: 1, state: 'active', goalId: `goal-${id}`, planRevision: 1, timezone: 'UTC', startDateLocal: '2026-09-01',
});
const action = (id: string, title: string): TodayAction => ({
  occurrence: { cardId: `card-${id}`, stableActivityId: id, occurrenceDateLocal: '2026-09-20', evidencePolicy: 'attestation' },
  alternatives: [],
  card: { id: `card-${id}`, title, columnId: 'todo', completed: false },
  checkIn: null,
});
const today = (): TodayView => ({
  dateLocal: '2026-09-20',
  enrollments: [{ enrollmentId: 'enroll-focus', challengeId: 'chal:focus', challengeVersion: 1, state: 'active', actions: [action('a', 'Protect a focus block')] }],
});
const FOCUS = summary('chal:focus', 'Focus gently');
const RETRY = 'Retry';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.getToday.mockResolvedValue(today());
  kt.listEnrollments.mockResolvedValue([enrollmentRow('enroll-focus', 'chal:focus')]);
  kt.listChallenges.mockResolvedValue([FOCUS]);
  kt.listChallengesForLocale.mockResolvedValue([negotiated(FOCUS)]);
  kt.listEnrollmentsWithProgress.mockResolvedValue({ enrollments: [enrollmentRow('enroll-focus', 'chal:focus')], progress: {} });
  kt.getJournal.mockResolvedValue([{ cardId: 'c1', enrollmentId: 'enroll-focus', challengeId: 'chal:focus', note: 'Felt good.', createdAt: '2026-09-20T09:00:00Z' }]);
  kt.recommendedChallenges.mockResolvedValue([]);
});

describe('PT-2 — Today', () => {
  it('a failed enrolment read states the reminder gap (with Retry) instead of hiding the controls', async () => {
    kt.listEnrollments.mockRejectedValueOnce(new Error('503'));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(await screen.findByText(en.reminderUnknown)).toBeTruthy();
    expect(screen.queryByRole('group', { name: en.reminderHeading })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: RETRY }));
    // The retry re-reads, and the real controls replace the notice.
    expect(await screen.findByRole('group', { name: en.reminderHeading })).toBeTruthy();
    expect(screen.queryByText(en.reminderUnknown)).toBeNull();
    expect(kt.listEnrollments).toHaveBeenCalledTimes(2);
  });

  it('a successful read renders the controls and no warning (the control case)', async () => {
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole('group', { name: en.reminderHeading })).toBeTruthy();
    expect(screen.queryByText(en.reminderUnknown)).toBeNull();
    expect(screen.queryByText(en.todayNamesUnknown)).toBeNull();
  });

  it('a failed catalog read is stated rather than silently degrading the names', async () => {
    kt.listChallenges.mockRejectedValueOnce(new Error('503'));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    expect(await screen.findByText(en.todayNamesUnknown)).toBeTruthy();
    // The Retry re-reads the catalog, and the notice clears once it succeeds.
    fireEvent.click(screen.getByRole('button', { name: RETRY }));
    await waitFor(() => expect(screen.queryByText(en.todayNamesUnknown)).toBeNull());
    expect(kt.listChallenges).toHaveBeenCalledTimes(2);
  });

  it('the enrolment welcome survives a failed enrolment-list read when Today confirms the id', async () => {
    kt.listEnrollments.mockRejectedValueOnce(new Error('503'));
    render(
      <MemoryRouter initialEntries={[{ pathname: '/today', state: { kicktodoWelcome: { enrollmentId: 'enroll-focus', challengeTitle: 'Focus gently' } } }]}>
        <TodayPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(en.todayWelcomeTitle.replace('{{title}}', 'Focus gently'))).toBeTruthy();
  });

  it('a fabricated welcome id is still refused when neither read confirms it', async () => {
    kt.listEnrollments.mockRejectedValueOnce(new Error('503'));
    render(
      <MemoryRouter initialEntries={[{ pathname: '/today', state: { kicktodoWelcome: { enrollmentId: 'enroll-forged', challengeTitle: 'Forged' } } }]}>
        <TodayPage />
      </MemoryRouter>,
    );
    await screen.findByText(en.reminderUnknown);
    expect(screen.queryByText(en.todayWelcomeTitle.replace('{{title}}', 'Forged'))).toBeNull();
  });
});

describe('PT-2 — Progress, Journal, Plan, Discover', () => {
  it('Progress: a failed title read is stated with a Retry that re-reads', async () => {
    kt.listChallengesForLocale.mockRejectedValueOnce(new Error('503'));
    render(<MemoryRouter><ProgressPage /></MemoryRouter>);
    expect(await screen.findByText(en.progressNamesUnknown)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: RETRY }));
    expect(await screen.findByRole('heading', { name: 'Focus gently' })).toBeTruthy();
    expect(screen.queryByText(en.progressNamesUnknown)).toBeNull();
  });

  it('Journal: a failed title read is stated with a Retry that re-reads', async () => {
    kt.listChallenges.mockRejectedValueOnce(new Error('503'));
    render(<MemoryRouter><JournalPage /></MemoryRouter>);
    expect(await screen.findByText(en.journalNamesUnknown)).toBeTruthy();
    expect(screen.getByText('Felt good.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: RETRY }));
    expect(await screen.findByText('Focus gently')).toBeTruthy();
    expect(screen.queryByText(en.journalNamesUnknown)).toBeNull();
  });

  it('Plan: the challenge view states a failed title read with a Retry that re-reads', async () => {
    // Pin "today" (Date only — RTL's polling timers stay real) so the plan row is
    // tomorrow by construction, not by a wall-clock computation racing midnight.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 20, 12, 0, 0));
    try {
      kt.getPlan.mockResolvedValue([{ enrollmentId: 'enroll-focus', challengeId: 'chal:focus', dateLocal: '2026-09-21', day: 2, stableActivityId: 'a', title: 'Protect a focus block', completed: false }]);
      kt.listChallengesForLocale.mockRejectedValueOnce(new Error('503'));
      render(<MemoryRouter><PlanPage /></MemoryRouter>);
      await screen.findByText('Protect a focus block');
      fireEvent.click(screen.getByRole('button', { name: en.planView_challenge }));
      expect(await screen.findByText(en.planNamesUnknown)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: RETRY }));
      expect(await screen.findByRole('heading', { name: 'Focus gently' })).toBeTruthy();
      expect(screen.queryByText(en.planNamesUnknown)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Discover: a failed enrolment read keeps the catalog and states the badge gap', async () => {
    kt.listEnrollments.mockRejectedValueOnce(new Error('503'));
    render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
    expect(await screen.findByText(en.discoverEnrolledUnknown)).toBeTruthy();
    // The catalog the participant came for is still there.
    expect(screen.getByRole('heading', { name: 'Focus gently' })).toBeTruthy();
    expect(screen.queryByText(en.loadChallengesError)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: RETRY }));
    await waitFor(() => expect(screen.queryByText(en.discoverEnrolledUnknown)).toBeNull());
    expect(screen.getByText(en.enrolledBadge)).toBeTruthy();
  });

  it('Discover: a failed catalog read offers a Retry that re-reads', async () => {
    kt.listChallengesForLocale.mockRejectedValueOnce(new Error('503'));
    render(<MemoryRouter><DiscoverPage /></MemoryRouter>);
    expect(await screen.findByText(en.loadChallengesError)).toBeTruthy();
    // Failed ≠ empty: the read failed, so "no challenges published" must not show.
    // A DOUBLE guard in DiscoverPage — the catch writes only `error` (never
    // `challenges=[]`), and the empty card renders only when `!error` — so no
    // single edit makes this line red on its own (the catch→[] edit reds the
    // `loadChallengesError` read above instead; w54g3-sr-discover-catch-to-empty-r2).
    expect(screen.queryByText(en.discoverEmptyTitle)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: RETRY }));
    expect(await screen.findByRole('heading', { name: 'Focus gently' })).toBeTruthy();
  });
});
