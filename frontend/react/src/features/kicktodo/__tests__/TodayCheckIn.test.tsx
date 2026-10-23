/**
 * KTP-4 round trip + KTP-2 refusal copy — checking in from Today.
 *
 * MOCKED: the kicktodo client's READS and the `checkIn` write are vi.fn()s
 * (component-level round trip — no HTTP, no backend). The refusal mapping is
 * exercised one level down too: the real `checkIn` against a stubbed `fetch`
 * returning the statuses `kicktodo-core/routes.ts` POST /check-ins actually
 * sends (422 EvidenceRequiredError, 409 superseded, 404 not found — the
 * `CheckInDeniedError` / `EvidenceRequiredError` mapping in that handler).
 *
 * Breaks if: the page stops re-reading Today after a successful check-in (the
 * Done state never appears); a 422 and a 409 collapse back into the one generic
 * "didn't save" (KTP-2); a superseded or gone (404) refusal stops refreshing
 * Today or loses its own copy; the
 * client stops mapping status → refusal. (KTP-3's unmount guard has no test:
 * React 18 silently drops a state update on an unmounted component, so no
 * assertion can tell the guarded and unguarded versions apart.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { checkIn, getToday, listChallenges, listEnrollments, TodayAction, TodayView } from '../../../client/kicktodoClient.js';

vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: null, resolved: true }) }));

const kt = vi.hoisted(() => ({
  getToday: vi.fn<typeof getToday>(),
  listEnrollments: vi.fn<typeof listEnrollments>(),
  listChallenges: vi.fn<typeof listChallenges>(),
  checkIn: vi.fn<typeof checkIn>(),
}));
vi.mock('../../../client/kicktodoClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../client/kicktodoClient.js')>()),
  ...kt,
}));

import { TodayPage } from '../TodayPage.js';
import { CheckInRefusedError } from '../../../client/kicktodoClient.js';
import { messages as en } from '../i18n/en.js';

const action = (completed: boolean, evidencePolicy: TodayAction['occurrence']['evidencePolicy'] = 'attestation'): TodayAction => ({
  occurrence: { cardId: 'card-a', stableActivityId: 'a', occurrenceDateLocal: '2026-09-20', evidencePolicy },
  alternatives: [],
  card: { id: 'card-a', title: 'Protect a focus block', columnId: completed ? 'done' : 'todo', completed },
  checkIn: completed ? { createdAt: '2026-09-20T09:00:00Z' } : null,
});
const todayWith = (a: TodayAction): TodayView => ({
  dateLocal: '2026-09-20',
  enrollments: [{ enrollmentId: 'enroll-focus', challengeId: 'chal:focus', challengeVersion: 1, state: 'active', actions: [a] }],
});
const DONE_BUTTON = `${en.markDone}: Protect a focus block`;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks();
  kt.listEnrollments.mockResolvedValue([]);
  kt.listChallenges.mockResolvedValue([]);
});

describe('KTP-4 — check in from Today, see the state update', () => {
  it('a successful check-in re-reads Today and the action shows as done', async () => {
    kt.getToday.mockResolvedValueOnce(todayWith(action(false))).mockResolvedValue(todayWith(action(true)));
    kt.checkIn.mockResolvedValue(undefined);
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: DONE_BUTTON }));
    await waitFor(() => expect(kt.checkIn).toHaveBeenCalledWith('card-a', undefined));
    expect(await screen.findByText(en.allCaughtUpTitle)).toBeTruthy();
    expect(screen.getByText(en.doneBadge)).toBeTruthy();
    expect(screen.queryByRole('button', { name: DONE_BUTTON })).toBeNull();
    expect(kt.getToday).toHaveBeenCalledTimes(2);
  });
});

describe('KTP-2 — a refused check-in says why', () => {
  it('422 evidence-required asks for the evidence, not a blind retry', async () => {
    kt.getToday.mockResolvedValue(todayWith(action(false)));
    kt.checkIn.mockRejectedValue(new CheckInRefusedError('evidence-required', 422));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: DONE_BUTTON }));
    expect(await screen.findByText(en.todayCheckInEvidenceRequired)).toBeTruthy();
    expect(screen.queryByText(en.todayActionError)).toBeNull();
    expect(screen.queryByText(en.todayCheckInSuperseded)).toBeNull();
  });

  it('409 superseded says the plan changed AND refreshes Today', async () => {
    kt.getToday.mockResolvedValue(todayWith(action(false)));
    kt.checkIn.mockRejectedValue(new CheckInRefusedError('superseded', 409));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: DONE_BUTTON }));
    expect(await screen.findByText(en.todayCheckInSuperseded)).toBeTruthy();
    expect(screen.queryByText(en.todayCheckInEvidenceRequired)).toBeNull();
    await waitFor(() => expect(kt.getToday).toHaveBeenCalledTimes(2));
  });

  it('404 gone says the action left the plan AND refreshes Today', async () => {
    kt.getToday.mockResolvedValue(todayWith(action(false)));
    kt.checkIn.mockRejectedValue(new CheckInRefusedError('not-found', 404));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: DONE_BUTTON }));
    expect(await screen.findByText(en.todayCheckInGone)).toBeTruthy();
    expect(screen.queryByText(en.todayActionError)).toBeNull();
    await waitFor(() => expect(kt.getToday).toHaveBeenCalledTimes(2));
  });

  it('an unclassified failure keeps the generic retry copy', async () => {
    kt.getToday.mockResolvedValue(todayWith(action(false)));
    kt.checkIn.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<MemoryRouter><TodayPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: DONE_BUTTON }));
    expect(await screen.findByText(en.todayActionError)).toBeTruthy();
    expect(screen.queryByText(en.todayCheckInEvidenceRequired)).toBeNull();
    expect(screen.queryByText(en.todayCheckInSuperseded)).toBeNull();
    expect(screen.queryByText(en.todayCheckInGone)).toBeNull();
  });
});

describe('KTP-2 — the client maps the route’s real statuses', () => {
  // The REAL checkIn (the module mock replaces it for the page cases above).
  const realCheckIn = async (cardId: string): Promise<void> => {
    const real = await vi.importActual<typeof import('../../../client/kicktodoClient.js')>('../../../client/kicktodoClient.js');
    return real.checkIn(cardId);
  };
  for (const [status, refusal] of [[422, 'evidence-required'], [409, 'superseded'], [404, 'not-found'], [500, 'failed']] as const) {
    it(`${status} → ${refusal}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x', message: 'raw server text' }), { status })));
      const err = await realCheckIn('card-a').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CheckInRefusedError);
      expect(err instanceof CheckInRefusedError ? err.refusal : undefined).toBe(refusal);
    });
  }
});
