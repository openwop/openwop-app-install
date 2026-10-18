/**
 * ADR 0123 Phase 4b — LeaderboardPage component coverage. Renders the per-model
 * ranking (Elo-desc order, Elo + win-rate cells, for the selected org), an empty state,
 * and gates on the toggle (disabled card, no fetch when off). The client +
 * feature-access are mocked → pure component test.
 *
 * Witnessed (wave 25 probes): an ascending initial sort, a zeroed Elo cell, fetching a
 * different org, the wrong empty-state title, and an org read that ignores the toggle
 * each red a case. HONEST CEILING: "no leaderboard fetch when off" is double-guarded —
 * with the org read gated, `orgId` stays '' — so dropping `access.enabled` from the
 * load effect alone cannot red it (probe `lp-toggle-lb` vacuous by design); the case
 * pins the outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom'; // LeaderboardPage now carries the arena <Link> (ADR 0123 P4c)

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../client/evalsClient.js', () => ({ listOrgs: vi.fn(), fetchLeaderboard: vi.fn() }));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }),
}));

import { listOrgs, fetchLeaderboard, type LeaderboardRow } from '../../../client/evalsClient.js';
import { LeaderboardPage } from '../LeaderboardPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockLb = vi.mocked(fetchLeaderboard);

const row = (model: string, over: Partial<LeaderboardRow> = {}): LeaderboardRow =>
  ({ model, up: 3, down: 1, neutral: 0, total: 4, winRate: 0.75, elo: 1532, ...over });

beforeEach(() => { enabled = true; mockOrgs.mockReset(); mockLb.mockReset(); mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]); });
afterEach(cleanup);

describe('LeaderboardPage (ADR 0123 Phase 4b)', () => {
  it('renders the per-model ranking rows', async () => {
    // Fed in ASCENDING Elo, so the Elo-desc ranking is the page's doing, not the fixture's.
    mockLb.mockResolvedValue([row('gpt', { elo: 1400, winRate: 0.5 }), row('opus', { elo: 1600 })]);
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('opus')).toBeTruthy();
    expect(mockLb).toHaveBeenCalledWith('o1');
    const bodyRows = screen.getAllByRole('row').filter((r) => within(r).queryAllByRole('cell').length > 0);
    expect(bodyRows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['opus', 'gpt']);
    const opusCells = within(bodyRows[0]!).getAllByRole('cell').map((c) => c.textContent);
    expect(opusCells).toContain('1,600');
    expect(opusCells).toContain('75%');
  });

  it('shows an empty state when there are no rated turns', async () => {
    mockLb.mockResolvedValue([]);
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('No rated turns yet.')).toBeTruthy();
  });

  it('does not fetch when the feature is off', async () => {
    // evals re-graduated to toggle-gated (PR #895): the page reads
    // useFeatureAccess('evals') and must skip the network when disabled.
    enabled = false;
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('The eval leaderboard is off for this workspace.')).toBeTruthy();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // let any async load land
    expect(mockOrgs).not.toHaveBeenCalled();
    expect(mockLb).not.toHaveBeenCalled();
  });
});
