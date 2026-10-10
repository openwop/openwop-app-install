/**
 * PM4UX-1 / PM4UX-2 (ADR 0842 D9) — a member the server answers `canWrite:false` for is
 * offered no control whose only outcome is a 403 (DESIGN.md "403 ⇒ hidden"), and a
 * Matrix placement made from a partial score says so, as the List does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { PriorityList, RankedIdea } from '../priorityMatrixClient.js';
import { PriorityQuadrant } from '../PriorityQuadrant.js';

let viewer: PriorityList['viewer'];
const LIST = (): PriorityList => ({
  id: 'l1', tenantId: 'user:t1', orgId: 'org-1', name: 'Bets', boardId: 'b1',
  criteriaSet: { aggregation: 'weighted-sum', criteria: [
    { id: 'impact', name: 'Impact', weight: 5, direction: 'benefit' },
    { id: 'reach', name: 'Reach', weight: 5, direction: 'benefit' },
    { id: 'effort', name: 'Effort', weight: 5, direction: 'cost' },
  ] },
  votingMode: 'single', voteAggregation: 'mean',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  ...(viewer ? { viewer } : {}),
} as PriorityList);

const IDEAS: RankedIdea[] = [
  { card: { id: 'c-full', title: 'Full idea', columnId: 'new' }, status: { columnId: 'new', columnName: 'New', terminal: false }, scores: { impact: 8, reach: 8, effort: 2 }, computedPriority: 8, rank: 1, completeness: { declared: 3, scored: 3, missing: [], complete: true } },
  { card: { id: 'c-part', title: 'Partial idea', columnId: 'new' }, status: { columnId: 'new', columnName: 'New', terminal: false }, scores: { impact: 9, effort: 2 }, computedPriority: 6, rank: 2, completeness: { declared: 3, scored: 2, missing: ['reach'], complete: false } },
];

vi.mock('../priorityMatrixClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLists: vi.fn(async () => [LIST()]),
  listIdeas: vi.fn(async () => IDEAS),
  listSessions: vi.fn(async () => []),
  getScheduleStatus: vi.fn(async () => ({ ideas: [], rollup: { behind: 0, atRisk: 0, onTrack: 0, doneLate: 0, doneEarly: 0, unscheduled: 2, total: 2, health: 'on-track' } })),
  getVoteBreakdown: vi.fn(async () => []),
}));
vi.mock('../../../client/accessClient.js', () => ({ listMembers: vi.fn(async () => []) }));
vi.mock('../../strategy/strategyClient.js', () => ({
  getStrategyContext: vi.fn(async () => []),
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PriorityListPage } from '../PriorityListPage.js';

afterEach(() => { cleanup(); viewer = undefined; });

const renderList = async (): Promise<void> => {
  try { window.localStorage.setItem('openwop:view:priority-matrix', 'list'); } catch { /* storage optional */ }
  render(
    <MemoryRouter initialEntries={['/priority-matrix/l1']}>
      <Routes><Route path="/priority-matrix/:listId" element={<PriorityListPage />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Full idea');
};

describe('PM4UX-1 — a reader is offered no write control', () => {
  it('canWrite:false — no score inputs, status selects, idea form, list actions or row menus; a read-only note instead', async () => {
    viewer = { canWrite: false, canConfigure: false };
    await renderList();
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryAllByLabelText(/— status$/)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /add idea/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete list/i })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /actions for/i })).toHaveLength(0);
    expect(screen.getByText(/view only/i)).toBeTruthy();
  });

  it('canWrite:true, canConfigure:false — writes offered, criteria + delete withheld', async () => {
    viewer = { canWrite: true, canConfigure: false };
    await renderList();
    expect(screen.queryAllByRole('spinbutton').length).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText(/— status$/).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: /actions for/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /criteria/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete list/i })).toBeNull();
  });

  it('an editor (no config authority) may rename, and is not offered the scoring mode that would 403 the save', async () => {
    viewer = { canWrite: true, canConfigure: false };
    await renderList();
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await screen.findByRole('dialog');
    expect(screen.getByLabelText(/list name/i)).toBeTruthy();
    expect(screen.queryByLabelText(/scoring mode/i)).toBeNull();
  });

  it('canConfigure:true — the scoring-model controls are offered', async () => {
    viewer = { canWrite: true, canConfigure: true };
    await renderList();
    expect(screen.getByRole('button', { name: /criteria/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /delete list/i })).toBeTruthy();
  });
});

describe('PM4UX-2 — a Matrix placement made from a partial score says so', () => {
  it('the partial idea carries "2 of 3 scored"; the complete one carries nothing', () => {
    render(<PriorityQuadrant ideas={IDEAS} criteriaSet={LIST().criteriaSet} />);
    expect(screen.getByText('2 of 3 scored')).toBeTruthy();
    expect(screen.queryByText('3 of 3 scored')).toBeNull();
  });
});
