/**
 * LeaderboardPage (ADR 0123 Phase 4b, ADR 0986 D7) — the two server rankings for the
 * selected org: chat ratings by confidence score (with raters + managed/simulated
 * chips) and arena standings (rating + W–L–T), the unattributed notice, the designed
 * empty states, and the toggle gate (no fetch when off). The client + feature access
 * are mocked → pure component test.
 *
 * Witnessed: an ascending initial sort, rendering the raw win rate as the score, a
 * dropped managed chip, a missing unattributed notice, fetching a different org, and
 * an org read that ignores the toggle each red a case. HONEST CEILING: "no fetch when
 * off" is double-guarded (the org read is gated too), so dropping `access.enabled`
 * from the load effect alone cannot red it; the case pins the outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../client/evalsClient.js', () => ({ listOrgs: vi.fn(), fetchEvalsBoard: vi.fn() }));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }),
}));

import { listOrgs, fetchEvalsBoard, type LeaderboardRow, type EvalsBoard } from '../../../client/evalsClient.js';
import { LeaderboardPage } from '../LeaderboardPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockBoard = vi.mocked(fetchEvalsBoard);

const row = (model: string, over: Partial<LeaderboardRow> = {}): LeaderboardRow =>
  ({ key: `openai/${model}`, provider: 'openai', model, up: 3, down: 1, neutral: 0, total: 4, raters: 2, winRate: 0.75, score: 0.3, ...over });
const board = (over: Partial<EvalsBoard> = {}): EvalsBoard => ({ leaderboard: [], arena: [], coverage: { attributed: 0, unattributed: 0 }, ...over });

const bodyRows = (tableName: string): HTMLElement[] =>
  within(screen.getByRole('table', { name: tableName })).getAllByRole('row').filter((r) => within(r).queryAllByRole('cell').length > 0);

beforeEach(() => { enabled = true; mockOrgs.mockReset(); mockBoard.mockReset(); mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]); });
afterEach(cleanup);

describe('LeaderboardPage', () => {
  it('ranks chat ratings by the confidence score, highest first, with raters and the managed chip', async () => {
    // Fed in ASCENDING score, so the order is the page's doing, not the fixture's.
    mockBoard.mockResolvedValue(board({ leaderboard: [row('gpt', { score: 0.1, winRate: 0.9 }), row('free', { provider: 'openwop-free', key: 'openwop-free/free', managed: true, score: 0.62 })] }));
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('free')).toBeTruthy();
    expect(mockBoard).toHaveBeenCalledWith('o1');
    const rows = bodyRows('From chat ratings');
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([expect.stringContaining('free'), expect.stringContaining('gpt')]);
    expect(within(rows[0]!).getByText('Managed')).toBeTruthy();
    const cells = within(rows[0]!).getAllByRole('cell').map((c) => c.textContent);
    // Stacked rows (phone reflow) label each cell with its column header.
    expect(cells).toContain('Confidence62%');
    expect(cells).toContain('Raters2');
  });

  it('shows arena standings with rating and W–L–T', async () => {
    mockBoard.mockResolvedValue(board({ arena: [{ key: 'openai/gpt', provider: 'openai', model: 'gpt', rating: 1561.4, wins: 4, losses: 1, ties: 2, matches: 7 }] }));
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('1,561')).toBeTruthy();
    expect(screen.getByText('4–1–2')).toBeTruthy();
  });

  it('says how many ratings could not be attributed instead of reading as empty', async () => {
    mockBoard.mockResolvedValue(board({ coverage: { attributed: 0, unattributed: 3 } }));
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText(/3 ratings couldn’t be matched/)).toBeTruthy();
    expect(screen.getByText('No rated turns yet.')).toBeTruthy();
    expect(screen.getByText('No arena matches yet.')).toBeTruthy();
  });

  it('does not fetch when the feature is off', async () => {
    enabled = false;
    render(<MemoryRouter><LeaderboardPage /></MemoryRouter>);
    expect(await screen.findByText('The eval leaderboard is off for this workspace.')).toBeTruthy();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(mockOrgs).not.toHaveBeenCalled();
    expect(mockBoard).not.toHaveBeenCalled();
  });
});
