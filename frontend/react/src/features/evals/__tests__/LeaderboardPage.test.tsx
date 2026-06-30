/**
 * ADR 0123 Phase 4b — LeaderboardPage component coverage. Renders the per-model
 * ranking, an empty state, and gates on the toggle (no fetch when off). The client
 * + feature-access are mocked → pure component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../../client/evalsClient.js', () => ({ listOrgs: vi.fn(), fetchLeaderboard: vi.fn() }));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }),
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
    mockLb.mockResolvedValue([row('opus', { elo: 1600 }), row('gpt', { elo: 1400 })]);
    render(<LeaderboardPage />);
    expect(await screen.findByText('opus')).toBeTruthy();
    expect(screen.getByText('gpt')).toBeTruthy();
  });

  it('shows an empty state when there are no rated turns', async () => {
    mockLb.mockResolvedValue([]);
    render(<LeaderboardPage />);
    expect(await screen.findByText('No rated turns yet.')).toBeTruthy();
  });

  it('does not fetch when the feature is off', () => {
    // evals re-graduated to toggle-gated (PR #895): the page reads
    // useFeatureAccess('evals') and must skip the network when disabled.
    enabled = false;
    render(<LeaderboardPage />);
    expect(mockOrgs).not.toHaveBeenCalled();
    expect(mockLb).not.toHaveBeenCalled();
  });
});
