/**
 * PMXU-4 / PMX-8a (ADR 0590, Blocker) — a FAILED schedule read must never
 * render the "No date" (`unscheduled`) chip: that is a positive factual claim
 * manufactured from a failed read, painted across rows that HAVE target dates.
 * The page now discriminates `'failed'` from "loaded empty" and states the
 * failure ("Schedule unavailable") per row + a retryable chip in the header.
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
  { card: { id: 'c1', title: 'Dated idea', columnId: 'new' }, status: { columnId: 'new', columnName: 'New', terminal: false }, scores: { impact: 6 }, computedPriority: 6, rank: 1 },
];

vi.mock('../priorityMatrixClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLists: vi.fn(async () => [LIST]),
  listIdeas: vi.fn(async () => IDEAS),
  listSessions: vi.fn(async () => []),
  getScheduleStatus: vi.fn(async () => { throw new Error('boom 500'); }),
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

describe('PMXU-4 — failed schedule read is stated, never claimed as "No date"', () => {
  it('renders "Schedule unavailable", and NO unscheduled ("No date") chip', async () => {
    render(
      <MemoryRouter initialEntries={['/priority-matrix/l1']}>
        <Routes><Route path="/priority-matrix/:listId" element={<PriorityListPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Dated idea');
    // The failure is stated (per-row cell + retryable header chip)…
    expect((await screen.findAllByText('Schedule unavailable')).length).toBeGreaterThan(0);
    // …and the false "No date" claim is NOWHERE (born red: pre-fix every row
    // chipped `scheduleUnscheduled` = "No date" on a failed read).
    expect(screen.queryByText('No date')).toBeNull();
  });
});
