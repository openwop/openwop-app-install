/**
 * ADR 0852 D4 — a strategy's roll-up of its linked projects' team ledgers.
 *   - lists each readable project's ledger (version, open questions, waiting
 *     changes, goal) and links to its Ledger tab; a project with no ledger says so;
 *   - asks once for the de-duplicated ids (strategy links + initiatives), capped;
 *   - nothing when no project is linked; a failed read is said.
 *
 * There is no toggle path: the team ledger is always on since 836a81994, and the
 * `useFeatureAccess` mock this file used to carry mocked a hook the component no
 * longer calls (no case ever set it off).
 *
 * Sabotage-witnessed (grade-tests w19, probes w19g5-ru-*): dropping the Set
 * de-dupe, raising the cap to 25, removing the empty-ids early return, mapping a
 * failed read to `ready []`, and dropping the no-ledger line each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { getLedgerSummaries } from '../../projects/teamLedgerClient.js';

const h = vi.hoisted(() => ({ getLedgerSummaries: vi.fn<typeof getLedgerSummaries>() }));
vi.mock('../../projects/teamLedgerClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getLedgerSummaries: h.getLedgerSummaries }));

import { StrategyLedgerRollup } from '../StrategyLedgerRollup.js';

const at = (ids: string[]) => render(<MemoryRouter><StrategyLedgerRollup projectIds={ids} /></MemoryRouter>);

beforeEach(() => { h.getLedgerSummaries.mockReset(); });
afterEach(cleanup);

describe('StrategyLedgerRollup', () => {
  it("lists each readable project's ledger and links to it; asks once for de-duplicated ids", async () => {
    h.getLedgerSummaries.mockResolvedValue([
      { projectId: 'p1', name: 'Launch', hasLedger: true, version: 3, goal: 'Ship EU', openQuestionCount: 2, pending: 1 },
      { projectId: 'p2', name: 'Docs', hasLedger: false },
    ]);
    at(['p1', 'p2', 'p1']);
    expect((await screen.findByRole('link', { name: 'Launch' })).getAttribute('href')).toBe('/projects/p1?tab=ledger');
    expect(screen.getByText(/version 3 · 2 open questions · 1 change waiting/)).toBeTruthy();
    expect(screen.getByText('Ship EU')).toBeTruthy();
    expect(screen.getByText(/no team ledger yet/)).toBeTruthy();
    expect(h.getLedgerSummaries).toHaveBeenCalledTimes(1);
    expect(h.getLedgerSummaries).toHaveBeenCalledWith(['p1', 'p2']);
  });

  it('caps the request at the route limit of 20', async () => {
    h.getLedgerSummaries.mockResolvedValue([]);
    at(Array.from({ length: 25 }, (_, i) => `p${i}`));
    await waitFor(() => expect(h.getLedgerSummaries).toHaveBeenCalled());
    expect((h.getLedgerSummaries.mock.calls[0]![0] as string[]).length).toBe(20);
    expect(await screen.findByText('None of the linked projects is visible to you.')).toBeTruthy();
  });

  it('nothing when no project is linked', () => {
    expect(at([]).container.textContent).toBe('');
    expect(h.getLedgerSummaries).not.toHaveBeenCalled();
  });

  it('a failed read is said', async () => {
    h.getLedgerSummaries.mockRejectedValue(new Error('503'));
    at(['p1']);
    expect((await screen.findAllByText('The team ledgers could not be loaded.')).length).toBeGreaterThan(0);
  });
});
