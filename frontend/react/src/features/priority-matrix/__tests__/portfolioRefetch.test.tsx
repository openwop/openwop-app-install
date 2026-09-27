/**
 * PMX-7 (ADR 0590, Blocker) — `props` identity in `PortfolioSection.load`'s
 * useCallback deps meant EVERY parent render (each keystroke in the list
 * filter) minted a new loader and its effect fired a real `GET /portfolio` —
 * a 12-char search burned 12 of the 60 req/min per-IP budget (the documented
 * 429-wall class). The loader now depends only on the stable inputs
 * (topN / normalize / federated / the destructured onError), so typing in the
 * filter fires ZERO additional portfolio reads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PriorityList } from '../priorityMatrixClient.js';

const mkList = (n: number): PriorityList => ({
  id: `l${n}`, tenantId: 'user:t1', orgId: 'org-1', name: `List ${n}`, boardId: `b${n}`,
  criteriaSet: { aggregation: 'weighted-sum', criteria: [{ id: 'impact', name: 'Impact', weight: 5, direction: 'benefit' }] },
  votingMode: 'single', voteAggregation: 'mean',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
} as PriorityList);

const { listPortfolio } = vi.hoisted(() => ({
  listPortfolio: vi.fn(async () => ({ items: [], lists: [], normalize: 'none' as const })),
}));

vi.mock('../priorityMatrixClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // 4+ lists so the §4.5 name-search input renders (it appears at > 3).
  listLists: vi.fn(async () => [mkList(1), mkList(2), mkList(3), mkList(4)]),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listProjects: vi.fn(async () => []),
  listPresets: vi.fn(async () => []),
  listPortfolio,
  listFederatedPortfolio: vi.fn(async () => ({ items: [], peers: [] })),
  listPeers: vi.fn(async () => []),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { PriorityMatrixPage } from '../PriorityMatrixPage.js';

afterEach(() => { cleanup(); listPortfolio.mockClear(); });

describe('PMX-7 — typing in the list filter must not refire GET /portfolio', () => {
  it('one portfolio read on mount; ZERO more across six keystrokes', async () => {
    render(<MemoryRouter><PriorityMatrixPage /></MemoryRouter>);
    await screen.findByText('List 1');
    await waitFor(() => expect(listPortfolio).toHaveBeenCalledTimes(1));

    const search = await screen.findByRole('searchbox');
    for (const q of ['g', 'gr', 'gro', 'grow', 'growt', 'growth']) {
      fireEvent.change(search, { target: { value: q } });
    }
    // Let any (wrong) effect re-fires flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(listPortfolio, 'a keystroke in the filter must not cost a network read').toHaveBeenCalledTimes(1);
  });
});
