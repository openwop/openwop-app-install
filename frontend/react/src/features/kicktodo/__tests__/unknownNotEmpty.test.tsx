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
import type {
  enroll, Enrollment, getChallengeForLocale, getChallengePrice, getReferralCode, getToday, listEnrollments,
  mintInvite, NegotiatedChallenge, TodayView,
} from '../../../client/kicktodoClient.js';
import type { getRosterEntry, RosterEntry } from '../../../agents/rosterClient.js';
import type { listProposals, PlanChangeProposal } from '../../../client/kicktodoCirclesClient.js';
import type { listNotes } from '../../agent-knowledge/agentKnowledgeClient.js';

const kt = vi.hoisted(() => ({
  listEnrollments: vi.fn<typeof listEnrollments>(), getChallengeForLocale: vi.fn<typeof getChallengeForLocale>(),
  getChallengePrice: vi.fn<typeof getChallengePrice>(), getReferralCode: vi.fn<typeof getReferralCode>(),
  mintInvite: vi.fn<typeof mintInvite>(), enroll: vi.fn<typeof enroll>(), getToday: vi.fn<typeof getToday>(),
}));
// The guide's OTHER reads come from their own modules — mock those modules, not
// kicktodoClient (an earlier version put these on kicktodoClient, so GuidePage ran
// the real clients: a live fetch, and a "pending count" case that passed while
// the decisions card was still loading).
const guide = vi.hoisted(() => ({
  getRosterEntry: vi.fn<typeof getRosterEntry>(),
  listProposals: vi.fn<typeof listProposals>(),
  listNotes: vi.fn<typeof listNotes>(),
}));
vi.mock('../../../client/kicktodoClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/kicktodoClient.js')>()),
  ...kt,
}));
vi.mock('../../../agents/rosterClient.js', () => ({ getRosterEntry: guide.getRosterEntry, updateRosterEntry: vi.fn() }));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({ listProposals: guide.listProposals }));
vi.mock('../../agent-knowledge/agentKnowledgeClient.js', () => ({ listNotes: guide.listNotes, deleteNote: vi.fn() }));

import { ChallengeDetailPage } from '../ChallengeDetailPage.js';
import { messages as en } from '../i18n/en.js';

const CHALLENGE: NegotiatedChallenge = {
  challenge: {
    id: 'ch1', version: 1, status: 'published', title: 'Run 5k', summary: 'Get moving', outcome: 'Run 5k without stopping.',
    durationDays: 30, depthLevel: 'beginner',
    activities: [{ stableActivityId: 'walk-1', day: 1, title: 'Walk', instructions: 'Walk briskly.', estimatedMinutes: 10, evidencePolicy: 'note' }],
  },
  servedLocale: 'en',
  exactLocale: true,
};
const enrollmentRow = (id: string, challengeId: string): Enrollment => ({
  id, challengeId, challengeVersion: 1, state: 'active', goalId: `goal-${id}`, planRevision: 1, timezone: 'UTC', startDateLocal: '2026-09-01',
});
const ENROL_CTA = `${en.previewAndStart}: Run 5k`;

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
  kt.enroll.mockResolvedValue(enrollmentRow('enrollment-new', 'ch1'));
});

describe('KT-G1 — a failed enrolment read never offers to enrol', () => {
  it('withholds the enrol CTA and says why', async () => {
    kt.listEnrollments.mockRejectedValue(new Error('503'));
    await mountDetail();
    expect(screen.getByText(en.enrollmentUnknown)).toBeTruthy();
    // The duplicate-enrolment invitation is the bug — it must be gone.
    expect(screen.queryByRole('button', { name: /^Enrol|^Enroll|Start/i })).toBeNull();
    // …but a returning participant still has a route onward.
    expect(screen.getByRole('link', { name: /Today/i })).toBeTruthy();
  });

  it('a successful read showing NOT enrolled still offers to enrol', async () => {
    // The failure mode of this fix is withholding the CTA from everyone.
    await mountDetail();
    expect(document.body.textContent).toContain('Run 5k');
    expect(screen.queryByText(en.enrollmentUnknown)).toBeNull();
    expect(screen.getByRole('button', { name: ENROL_CTA })).toBeTruthy();
  });

  it('a successful read showing ALREADY enrolled is unchanged', async () => {
    kt.listEnrollments.mockResolvedValue([enrollmentRow('e1', 'ch1')]);
    await mountDetail();
    expect(screen.getByText(en.enrolledBadge)).toBeTruthy();
    expect(screen.queryByText(en.enrollmentUnknown)).toBeNull();
    expect(screen.getByRole('link', { name: /Today/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: ENROL_CTA })).toBeNull();
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
    const today: TodayView = { dateLocal: '2026-09-20', enrollments: [] };
    const roster: RosterEntry = {
      rosterId: 'host:kickbot', persona: 'KickBot', label: 'Kick', agentRef: { agentId: 'kickbot' },
      workflows: [], tenantId: 't1', enabled: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    };
    kt.getToday.mockResolvedValue(today);
    guide.getRosterEntry.mockResolvedValue(roster);
    guide.listNotes.mockResolvedValue([]);
    guide.listProposals.mockResolvedValue([]);
  });

  it('says it could not check when the enrolment list fails', async () => {
    kt.listEnrollments.mockRejectedValue(new Error('500'));
    await mountGuide();
    expect(await screen.findByRole('heading', { name: en.guideWaitingUnknown })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: en.guideDecisionsNoneTitle })).toBeNull();
  });

  it('says nothing when the read succeeds and nothing is pending', async () => {
    // 0 must keep meaning zero — the banner stays hidden, silently, as before.
    kt.listEnrollments.mockResolvedValue([]);
    await mountGuide();
    // Positive control first: the decisions read has SETTLED as "none".
    expect(await screen.findByRole('heading', { name: en.guideDecisionsNoneTitle })).toBeTruthy();
    expect(screen.queryByText(en.guideWaitingUnknown)).toBeNull();
    expect(screen.queryByText(en.guideExProposalTitle)).toBeNull();
  });

  it('still surfaces a real pending count', async () => {
    kt.listEnrollments.mockResolvedValue([enrollmentRow('e1', 'ch1')]);
    const pending: PlanChangeProposal = {
      id: 'p1', circleId: 'c1', enrollmentId: 'e1', coachSubject: 'coach:1',
      note: 'Move the reading block to tomorrow.', state: 'proposed', createdAt: '2026-09-20T12:00:00Z',
    };
    guide.listProposals.mockResolvedValue([pending]);
    await mountGuide();
    expect(await screen.findByText('1 plan change is waiting on your decision.')).toBeTruthy();
    // The welcome's proposal seed (GuideWelcome `pendingProposals > 0`).
    expect(screen.getByText(en.guideExProposalTitle)).toBeTruthy();
    expect(screen.queryByText(en.guideWaitingUnknown)).toBeNull();
  });
});
