/**
 * UX_UPGRADE-priority-matrix ROUND 3 — the List column's `0` read as "scored worst".
 * The Matrix tray already said "unscored"; the List column printed a bold `0` beside
 * real scores. Both polarities in one render: the unscored row shows the Unscored
 * label, the scored row keeps its formatted number.
 *
 * **CORRECTED 2026-09-13 (ADR 0667 D1c).** This docblock used to assert that
 * `computedPriority` 0 is an unambiguous sentinel because "a scored idea can never
 * produce exactly 0 — scores clamp to 1..10". **That is FALSE**, and was measured
 * false: in `ratio` mode a WSJF idea scored 10/10/10 with a BLANK job-size returns
 * exactly 0, byte-identical to a never-touched idea. It was true when written and
 * stopped being true when `PM2-B1` added the cost-side incompleteness guard — the
 * guard created a second way to reach the sentinel, and nothing updated the claim
 * that depended on there being only one.
 *
 * The distinction now rides `RankedIdea.completeness`, so `scored === 0` (not the
 * priority number) selects the Unscored label, and a partially-scored idea shows its
 * number plus "n of m scored". The original text is preserved above rather than
 * rewritten, because the way this claim decayed IS the lesson.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { PriorityList, RankedIdea } from '../priorityMatrixClient.js';

const LIST: PriorityList = {
  id: 'l1', tenantId: 'user:t1', orgId: 'org-1', name: 'Bets', boardId: 'b1',
  criteriaSet: { aggregation: 'weighted-sum', criteria: [{ id: 'impact', name: 'Impact', weight: 5, direction: 'benefit' }] },
  votingMode: 'single', voteAggregation: 'mean',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
} as PriorityList;

const IDEAS: RankedIdea[] = [
  // ADR 0667 D1c — `completeness` is what selects the label now, not the number.
  // The fixture carries it because every production response does (both ranking
  // sites in `listRankedIdeas` emit it).
  { card: { id: 'c-scored', title: 'Scored idea', columnId: 'new' }, status: { columnId: 'new', columnName: 'New', terminal: false }, scores: { impact: 6 }, computedPriority: 6, rank: 1, completeness: { declared: 1, scored: 1, missing: [], complete: true } },
  { card: { id: 'c-blank', title: 'Blank idea', columnId: 'new' }, status: { columnId: 'new', columnName: 'New', terminal: false }, scores: {}, computedPriority: 0, rank: 2, completeness: { declared: 1, scored: 0, missing: ['impact'], complete: false } },
  // ADR 0667 D1c — the THIRD state the app could not previously express: scored, but
  // not on every criterion. Before this fix it rendered as a bare authoritative number.
  { card: { id: 'c-partial', title: 'Partial idea', columnId: 'new' }, status: { columnId: 'new', columnName: 'New', terminal: false }, scores: { impact: 7 }, computedPriority: 7, rank: 3, completeness: { declared: 4, scored: 3, missing: ['risk'], complete: false } },
];

// PMX-11 (ADR 0590) — this fixture used to mock a rollup shape
// (`{ ahead, behind, unplanned }`) that `ScheduleRollup` has NEVER had, so the
// page's `onTrack + atRisk + …` sum was NaN and the rollup chip silently never
// rendered in the test — a fixture that would have MASKED a real rollup
// regression (the tests-that-pin-defects family). Production shape + an
// asserted chip below.
vi.mock('../priorityMatrixClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLists: vi.fn(async () => [LIST]),
  listIdeas: vi.fn(async () => IDEAS),
  listSessions: vi.fn(async () => []),
  getScheduleStatus: vi.fn(async () => ({
    ideas: [{ cardId: 'c-scored', title: 'Scored idea', status: 'New', state: 'on-track', targetDate: '2027-01-31', dueInDays: 30 }],
    rollup: { behind: 0, atRisk: 0, onTrack: 1, doneLate: 0, doneEarly: 0, unscheduled: 1, total: 2, health: 'on-track' },
  })),
  getVoteBreakdown: vi.fn(async () => []),
}));
vi.mock('../../../client/accessClient.js', () => ({ listMembers: vi.fn(async () => []) }));
vi.mock('../../strategy/strategyClient.js', () => ({
  getStrategyContext: vi.fn(async () => []),
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PriorityListPage } from '../PriorityListPage.js';

afterEach(cleanup);

describe('R3 — priority 0 renders as Unscored, never as a score', () => {
  it('the unscored row says Unscored; the scored row keeps its number', async () => {
    render(
      <MemoryRouter initialEntries={['/priority-matrix/l1']}>
        <Routes><Route path="/priority-matrix/:listId" element={<PriorityListPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Blank idea');
    expect(screen.getAllByText('Unscored').length).toBeGreaterThan(0);
    expect(screen.getAllByText('6').length).toBeGreaterThan(0);
    // The sentinel is never rendered as the number it is not.
    const zeros = screen.queryAllByText(/^0$/);
    expect(zeros.filter((el) => el.tagName === 'STRONG')).toHaveLength(0);
  });

  it('PMX-11 — the schedule rollup chip renders from the production-shaped rollup', async () => {
    render(
      <MemoryRouter initialEntries={['/priority-matrix/l1']}>
        <Routes><Route path="/priority-matrix/:listId" element={<PriorityListPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Blank idea');
    // `scheduleRollupSummary` = "{{onTrack}} on track · {{atRisk}} at risk · {{behind}} behind"
    expect(await screen.findByText(/on track.*at risk.*behind/)).toBeTruthy();
  });

  it('ADR 0667 D1c — a partially-scored idea shows its number AND "3 of 4 scored", never a bare number', async () => {
    render(
      <MemoryRouter initialEntries={['/priority-matrix/l1']}>
        <Routes><Route path="/priority-matrix/:listId" element={<PriorityListPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Partial idea');
    // The count is the disclosure; the number is kept because suppressing it would
    // re-create the one-label-for-two-states defect this fix removes.
    expect(screen.getAllByText('3 of 4 scored').length).toBeGreaterThan(0);
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    // And the fully-scored idea must NOT be labelled partial.
    expect(screen.queryAllByText('1 of 1 scored')).toHaveLength(0);
  });
});
