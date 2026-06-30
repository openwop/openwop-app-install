/**
 * ADR 0118 Phase 3b — UsageDashboardPage component coverage. The admin dashboard
 * loads the per-model token rollup into a table, shows an empty state, and gates on
 * the feature toggle. The client + feature-access are mocked → pure component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../../client/usageAnalyticsClient.js', () => ({ listOrgs: vi.fn(), fetchUsageRollup: vi.fn() }));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled, status: enabled ? 'on' : 'off', isBeta: false, variant: null }),
}));

import { listOrgs, fetchUsageRollup, type UsageRollupRow } from '../../../client/usageAnalyticsClient.js';
import { UsageDashboardPage } from '../UsageDashboardPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockRollup = vi.mocked(fetchUsageRollup);

const row = (provider: string, model: string, over: Partial<UsageRollupRow> = {}): UsageRollupRow =>
  ({ provider, model, inputTokens: 100, outputTokens: 50, calls: 2, updatedAt: 'x', ...over });

beforeEach(() => { enabled = true; mockOrgs.mockReset(); mockRollup.mockReset(); mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]); });
afterEach(cleanup);

describe('UsageDashboardPage (ADR 0118 Phase 3b)', () => {
  it('renders the per-model rollup rows', async () => {
    mockRollup.mockResolvedValue([row('anthropic', 'opus', { inputTokens: 1200 }), row('openai', 'gpt')]);
    render(<UsageDashboardPage />);
    expect(await screen.findByText('opus')).toBeTruthy();
    expect(screen.getByText('gpt')).toBeTruthy();
    expect(screen.getByText('anthropic')).toBeTruthy();
  });

  it('shows an empty state when there is no usage', async () => {
    mockRollup.mockResolvedValue([]);
    render(<UsageDashboardPage />);
    expect(await screen.findByText('No usage recorded yet.')).toBeTruthy();
  });

  it('shows the disabled state when the toggle is off (no fetch)', async () => {
    enabled = false;
    render(<UsageDashboardPage />);
    expect(await screen.findByText('Usage analytics is off for this workspace.')).toBeTruthy();
    expect(mockRollup).not.toHaveBeenCalled();
  });
});
