/**
 * KickTodo Today — humane recovery and capacity (2da5a7683 "make recovery
 * humane"; ADR 0429 bounded, read-only recovery preview; ADR 0436 §3.3).
 * Pins: the recovery offer previews its exact impact BEFORE the participant adds
 * one bounded action, and the success notice appears only when the server says
 * something was added; overload (> 2 due OR due across > 1 challenge) becomes an
 * explicit capacity decision whose snooze really pauses that enrollment; a fully
 * paused day stays visible and resumable — never "all caught up".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  acceptRecovery, ChallengeSummary, checkIn, Enrollment, getToday, listChallenges, listEnrollments,
  setSchedulePreference, setSnooze, substituteAction, TodayAction, TodayView,
} from '../../../client/kicktodoClient.js';

vi.mock('../../../auth/backendSession.js', () => ({
  useBackendSession: () => ({ user: null, resolved: true }),
}));

const kt = vi.hoisted(() => ({
  getToday: vi.fn<typeof getToday>(),
  listEnrollments: vi.fn<typeof listEnrollments>(),
  listChallenges: vi.fn<typeof listChallenges>(),
  acceptRecovery: vi.fn<typeof acceptRecovery>(),
  setSnooze: vi.fn<typeof setSnooze>(),
  setSchedulePreference: vi.fn<typeof setSchedulePreference>(),
  checkIn: vi.fn<typeof checkIn>(),
  substituteAction: vi.fn<typeof substituteAction>(),
}));

vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kt,
}));

import { TodayPage } from '../TodayPage.js';
import { messages as en } from '../i18n/en.js';

const challenge = (id: string, title: string): ChallengeSummary => ({
  id,
  version: 1,
  status: 'published',
  title,
  summary: `${title} summary`,
  outcome: `${title} outcome`,
  durationDays: 14,
  activities: [],
});

const action = (id: string, title: string): TodayAction => ({
  occurrence: {
    cardId: `card-${id}`,
    stableActivityId: id,
    occurrenceDateLocal: '2026-09-20',
    evidencePolicy: 'attestation',
  },
  alternatives: [],
  card: { id: `card-${id}`, title, description: 'A useful next step.', columnId: 'todo', completed: false },
  checkIn: null,
});

const enrollmentRow = (id: string, challengeId: string, state: Enrollment['state']): Enrollment => ({
  id, challengeId, challengeVersion: 1, state, goalId: `goal-${id}`, planRevision: 1, timezone: 'UTC', startDateLocal: '2026-09-01',
});

type TodayEnrollment = TodayView['enrollments'][number];
const todayOf = (...enrollments: TodayEnrollment[]): TodayView => ({ dateLocal: '2026-09-20', enrollments });
const active = (enrollmentId: string, challengeId: string, actions: TodayAction[]): TodayEnrollment =>
  ({ enrollmentId, challengeId, challengeVersion: 1, state: 'active', actions });

const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const mount = () => render(<MemoryRouter><TodayPage /></MemoryRouter>);

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.acceptRecovery.mockResolvedValue(true);
  kt.setSnooze.mockImplementation(async (id, snoozed) => enrollmentRow(id, 'chal:focus', snoozed ? 'snoozed' : 'active'));
  kt.listEnrollments.mockResolvedValue([]);
  kt.listChallenges.mockResolvedValue([
    challenge('chal:focus', 'Focus gently'),
    challenge('chal:move', 'Move daily'),
  ]);
});

describe('Today — humane recovery and capacity', () => {
  it('previews the exact recovery impact before adding one bounded action', async () => {
    kt.getToday.mockResolvedValue(todayOf({
      ...active('enroll-focus', 'chal:focus', [action('focus', 'Protect a focus block')]),
      recovery: { missed: 2, mode: 'offer' },
    }));

    mount();

    expect(await screen.findByRole('heading', { name: en.recoveryOfferTitle_other.replace('{{count}}', '2') })).toBeTruthy();
    expect(screen.getByText(en.recoveryOfferImpact)).toBeTruthy();
    expect(screen.getByText(en.whyThisActionPlan.replace('{{title}}', 'Focus gently'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en.recoveryAddAction }));
    await waitFor(() => expect(kt.acceptRecovery).toHaveBeenCalledWith('enroll-focus'));
    expect(await screen.findByText(en.recoveryAddedNotice_other.replace('{{count}}', '2'))).toBeTruthy();
  });

  it('claims no recovery success when the server added nothing', async () => {
    kt.acceptRecovery.mockResolvedValue(false);
    kt.getToday.mockResolvedValue(todayOf({
      ...active('enroll-focus', 'chal:focus', [action('focus', 'Protect a focus block')]),
      recovery: { missed: 2, mode: 'offer' },
    }));

    mount();
    fireEvent.click(await screen.findByRole('button', { name: en.recoveryAddAction }));
    await waitFor(() => expect(kt.acceptRecovery).toHaveBeenCalledWith('enroll-focus'));
    // The reload after accept is the settle signal: a second Today read.
    await waitFor(() => expect(kt.getToday).toHaveBeenCalledTimes(2));
    await drain();
    expect(screen.queryByText(en.recoveryAddedNotice_other.replace('{{count}}', '2'))).toBeNull();
  });

  it('turns overload into an explicit, reversible capacity decision', async () => {
    kt.getToday.mockResolvedValue(todayOf(
      active('enroll-focus', 'chal:focus', [action('focus', 'Protect a focus block'), action('review', 'Review the day')]),
      active('enroll-move', 'chal:move', [action('move', 'Take a short walk')]),
    ));

    mount();
    await screen.findByText(en.capacityTitle);
    fireEvent.click(screen.getByText(en.capacityTitle));

    expect(screen.getByText(en.capacitySummary.replace('{{due}}', '3').replace('{{challenges}}', '2'))).toBeTruthy();
    expect(screen.getByText(en.capacityPauseImpact_other.replace('{{count}}', '2'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.snoozeNamed.replace('{{title}}', 'Focus gently') }));
    await waitFor(() => expect(kt.setSnooze).toHaveBeenCalledWith('enroll-focus', true));
  });

  it('the capacity guard trips on more than two due OR more than one challenge — and not below', async () => {
    // Three due in ONE challenge → overload by count alone.
    kt.getToday.mockResolvedValue(todayOf(
      active('enroll-focus', 'chal:focus', [action('a', 'One'), action('b', 'Two'), action('c', 'Three')]),
    ));
    mount();
    expect(await screen.findByText(en.capacityTitle)).toBeTruthy();
    cleanup();

    // Two due across TWO challenges → overload by spread alone.
    kt.getToday.mockResolvedValue(todayOf(
      active('enroll-focus', 'chal:focus', [action('a', 'One')]),
      active('enroll-move', 'chal:move', [action('m', 'Walk')]),
    ));
    mount();
    expect(await screen.findByText(en.capacityTitle)).toBeTruthy();
    cleanup();

    // Two due in ONE challenge → the quiet footer, no capacity card.
    kt.getToday.mockResolvedValue(todayOf(
      active('enroll-focus', 'chal:focus', [action('a', 'One'), action('b', 'Two')]),
    ));
    mount();
    expect(await screen.findByText(en.snoozeFraming)).toBeTruthy();
    expect(screen.queryByText(en.capacityTitle)).toBeNull();
  });

  it('keeps a paused plan visible and resumable instead of claiming the day is complete', async () => {
    kt.getToday.mockResolvedValue(todayOf(
      { enrollmentId: 'enroll-focus', challengeId: 'chal:focus', challengeVersion: 1, state: 'snoozed', actions: [] },
    ));

    mount();

    expect(await screen.findByText(en.allPausedTitle)).toBeTruthy();
    expect(screen.queryByText(en.allCaughtUpTitle)).toBeNull();
    expect(screen.queryByText(en.summaryAllDone)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `${en.resume}: Focus gently` }));
    await waitFor(() => expect(kt.setSnooze).toHaveBeenCalledWith('enroll-focus', false));
  });
});
