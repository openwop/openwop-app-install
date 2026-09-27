/**
 * UX_UPGRADE-strategy ROUND 3 — two R2-named deferrals.
 *
 *  - R3-A: the objectives/initiatives save FILTERED OUT any row whose title was
 *    cleared — a blank field silently deleted the row on a 200. The save now
 *    blocks and says why (removal has its own button). Both polarities: the
 *    blocked save never calls the API; a fully-titled save sends EVERY row.
 *  - R3-B: AlignModal's failed read used to `setStrategies([])`, so the modal
 *    claimed "no strategies to align" after the toast faded. Failure is its own
 *    state with a retry. Both polarities: failure copy on a rejected read,
 *    designed-empty copy only on a genuine [].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Strategy } from '../strategyClient.js';

const getStrategy = vi.fn();
const listStrategies = vi.fn();
const listProjects = vi.fn();
const updateStrategy = vi.fn();

vi.mock('../strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategy: () => getStrategy(),
  listStrategies: (...a: unknown[]) => listStrategies(...a),
  listProjects: () => listProjects(),
  updateStrategy: (...a: unknown[]) => updateStrategy(...a),
  getStrategyDetailContext: vi.fn(async () => null),
  replaceLinks: vi.fn(async () => ({})),
  // ADR 0661 — unnamed by this factory, so the REAL one ran and fetched
  // `/check-ins` out of jsdom. No assertion here reads check-ins.
  listStrategyCheckIns: vi.fn(async () => []),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { StrategyDetailPage } from '../StrategyDetailPage.js';
import { StrategyAlignment } from '../StrategyAlignment.js';

const STRATEGY: Strategy = {
  id: 's1', tenantId: 'user:t1', orgId: 'org-1', scope: 'org',
  title: 'Win the mid-market', planningHorizon: 'annual',
  period: { label: '2026' }, status: 'active',
  objectives: [
    { id: 'o1', title: 'Grow pipeline', keyResults: [{ id: 'k1', title: 'MQLs 2x' }] },
    { id: 'o2', title: 'Retain the base', keyResults: [] },
  ],
  initiatives: [], links: [],
  createdBy: 'user:t1', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const ALIGNABLE: Strategy = { ...STRATEGY, id: 's9', title: 'Expand EMEA', links: [], objectives: [], updatedAt: '2026-07-02T00:00:00.000Z' };

const viewObjectives = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/strategy/s1?tab=objectives']}>
      <Routes><Route path="/strategy/:strategyId" element={<StrategyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(getStrategy).toHaveBeenCalled());
};

beforeEach(() => {
  getStrategy.mockReset(); listStrategies.mockReset(); listProjects.mockReset(); updateStrategy.mockReset();
  getStrategy.mockResolvedValue(structuredClone(STRATEGY));
  listStrategies.mockResolvedValue([]);
  listProjects.mockResolvedValue([]);
  updateStrategy.mockResolvedValue({});
});
afterEach(cleanup);

describe('R3-A: a cleared title blocks the save instead of silently deleting the row', () => {
  it('a blanked objective title blocks the save — the API is never called', async () => {
    await viewObjectives();
    const title = await screen.findByDisplayValue('Grow pipeline');
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    // SPU-9 — the copy is now PLURALIZED, so the one-blank case reads
    // "1 item has an empty title", not the "item(s) have" parenthetical hack.
    expect(await screen.findByText(/1 item has an empty title/i)).toBeTruthy();
    expect(updateStrategy).not.toHaveBeenCalled();
  });

  it('a fully-titled save sends EVERY row — nothing is filtered out', async () => {
    await viewObjectives();
    await screen.findByDisplayValue('Grow pipeline');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateStrategy).toHaveBeenCalled());
    const payload = updateStrategy.mock.calls[0]![1] as { objectives: { id: string; keyResults: unknown[] }[] };
    expect(payload.objectives.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(payload.objectives[0]!.keyResults).toHaveLength(1);
    expect(screen.queryByText(/an empty title/i)).toBeNull();
  });
});

describe('R3-B: AlignModal renders a failed read as FAILURE, not as "nothing to align"', () => {
  const openModal = async (): Promise<void> => {
    render(<StrategyAlignment listId="l1" cardId="c1" refs={[]} onChanged={() => {}} onError={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /align/i }));
    await act(async () => {});
  };

  it('a rejected read shows the unavailable copy — never the designed-empty claim', async () => {
    listStrategies.mockRejectedValue(new Error('strategies down'));
    await openModal();
    expect(await screen.findByText(/the list is unavailable, not empty/i)).toBeTruthy();
    expect(screen.queryByText(/no strategies available to align/i)).toBeNull();
  });

  it('retry re-runs the read and renders the list', async () => {
    listStrategies.mockRejectedValueOnce(new Error('strategies down'));
    listStrategies.mockResolvedValue([ALIGNABLE]);
    await openModal();
    await screen.findByText(/the list is unavailable, not empty/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await act(async () => {});
    expect(await screen.findByText('Expand EMEA')).toBeTruthy();
    expect(screen.queryByText(/the list is unavailable/i)).toBeNull();
  });

  it('a genuinely empty list still shows the designed-empty copy, not the failure copy', async () => {
    listStrategies.mockResolvedValue([]);
    await openModal();
    expect(await screen.findByText(/no strategies available to align/i)).toBeTruthy();
    expect(screen.queryByText(/the list is unavailable/i)).toBeNull();
  });
});
