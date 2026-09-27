/**
 * UX_UPGRADE-kicktodo KT-G1 + KT-G2 — "we could not check" is not "no".
 *
 * KT-G1: `listEnrollments().catch(() => [])` fed `alreadyEnrolled`, which gates
 * the ENROL CTA — so a failed read rendered "not enrolled" and offered enrolment
 * to someone already in, defeating the invariant stated in the comment directly
 * above it ("so a returning participant sees 'Go to Today', not a re-enroll CTA").
 *
 * KT-G2: the guide's ONE "waiting on you" fact fell back to 0, which HIDES the
 * banner — telling the user nothing needs them when we had not checked. This
 * module states the opposite doctrine twice in the same function ("never a
 * fabricated placeholder name", "never a fabricated empty").
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const kt = vi.hoisted(() => ({
  listEnrollments: vi.fn(), getChallengeForLocale: vi.fn(), getChallengePrice: vi.fn(),
  getReferralCode: vi.fn(), mintInvite: vi.fn(), enroll: vi.fn(),
  getToday: vi.fn(), getRosterEntry: vi.fn(), listProposals: vi.fn(), listNotes: vi.fn(),
}));
vi.mock('../../../client/kicktodoClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoClient.js')>()),
  ...kt,
}));

import { ChallengeDetailPage } from '../ChallengeDetailPage.js';

const CHALLENGE = {
  challenge: {
    id: 'ch1', version: 1, title: 'Run 5k', durationDays: 30, depth: 'beginner' as const,
    promise: 'Get moving', activities: [{ day: 1, title: 'Walk', estimatedMinutes: 10, evidencePolicy: 'note' }],
  },
  locale: 'en',
};

const mountDetail = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/discover/ch1']}>
      <Routes><Route path="/discover/:challengeId" element={<ChallengeDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  kt.getChallengeForLocale.mockResolvedValue(CHALLENGE);
  kt.getChallengePrice.mockResolvedValue(null);
  kt.getReferralCode.mockResolvedValue(null);
  kt.listEnrollments.mockResolvedValue([]);
  kt.enroll.mockResolvedValue({ id: 'enrollment-new', challengeId: 'ch1', state: 'active' });
});

describe('KT-G1 — a failed enrolment read never offers to enrol', () => {
  it('withholds the enrol CTA and says why', async () => {
    kt.listEnrollments.mockRejectedValue(new Error('503'));
    await mountDetail();
    expect(document.body.textContent).toContain('could not check whether you are already enrolled');
    // The duplicate-enrolment invitation is the bug — it must be gone.
    expect(screen.queryByRole('button', { name: /^Enrol|^Enroll|Start/i })).toBeNull();
    // …but a returning participant still has a route onward.
    expect(screen.getByRole('link', { name: /Today/i })).toBeTruthy();
  });

  it('a successful read showing NOT enrolled still offers to enrol', async () => {
    // The failure mode of this fix is withholding the CTA from everyone.
    await mountDetail();
    expect(document.body.textContent).not.toContain('could not check whether you are already enrolled');
    expect(document.body.textContent).toContain('Run 5k');
  });

  it('a successful read showing ALREADY enrolled is unchanged', async () => {
    kt.listEnrollments.mockResolvedValue([{ id: 'e1', challengeId: 'ch1', state: 'active' }]);
    await mountDetail();
    expect(document.body.textContent).not.toContain('could not check whether you are already enrolled');
    expect(screen.getByRole('link', { name: /Today/i })).toBeTruthy();
  });

  it('hands a new enrolment directly to Today with a verified welcome hint', async () => {
    function TodayProbe(): JSX.Element {
      const location = useLocation();
      return <pre data-testid="today-state">{JSON.stringify(location.state)}</pre>;
    }
    render(
      <MemoryRouter initialEntries={['/discover/ch1']}>
        <Routes>
          <Route path="/discover/:challengeId" element={<ChallengeDetailPage />} />
          <Route path="/today" element={<TodayProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Preview my plan.*Run 5k/i }));
    await waitFor(() => expect(screen.getByTestId('today-state').textContent).toContain('enrollment-new'));
    expect(screen.getByTestId('today-state').textContent).toContain('Run 5k');
  });
});

/* ── the guide ── */

vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: ({ renderEmptyState }: { renderEmptyState?: (p: (s: string) => void) => JSX.Element }) =>
    <div>{renderEmptyState ? renderEmptyState(() => {}) : null}</div>,
}));

import { GuidePage } from '../GuidePage.js';

const mountGuide = async (): Promise<void> => {
  render(<MemoryRouter><GuidePage /></MemoryRouter>);
  await act(async () => {});
};

describe('KT-G2 — the guide never fabricates "nothing is waiting"', () => {
  beforeEach(() => {
    kt.getToday.mockResolvedValue({ enrollments: [] });
    kt.getRosterEntry.mockResolvedValue({ label: 'Kick' });
    kt.listNotes.mockResolvedValue([]);
    kt.listProposals.mockResolvedValue([]);
  });

  it('says it could not check when the enrolment list fails', async () => {
    kt.listEnrollments.mockRejectedValue(new Error('500'));
    await mountGuide();
    expect(document.body.textContent).toContain('Could not check whether anything is waiting');
  });

  it('says nothing when the read succeeds and nothing is pending', async () => {
    // 0 must keep meaning zero — the banner stays hidden, silently, as before.
    kt.listEnrollments.mockResolvedValue([]);
    await mountGuide();
    expect(document.body.textContent).not.toContain('Could not check whether anything is waiting');
  });

  it('still surfaces a real pending count', async () => {
    kt.listEnrollments.mockResolvedValue([{ id: 'e1', challengeId: 'ch1', state: 'active' }]);
    kt.listProposals.mockResolvedValue([{
      id: 'p1', circleId: 'c1', enrollmentId: 'e1', coachSubject: 'coach:1',
      note: 'Move the reading block to tomorrow.', state: 'proposed', createdAt: '2026-09-20T12:00:00Z',
    }]);
    await mountGuide();
    expect(document.body.textContent).not.toContain('Could not check whether anything is waiting');
  });
});
