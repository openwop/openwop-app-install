/**
 * UX_UPGRADE-workforces WF-G2 — the overview's "Needs you" all-clear had the
 * same one-failed zero-fill the gallery's WF-G1 fixed (#2568), missed on this
 * screen: with governance (or metrics) unreadable, the surviving side's clean
 * numbers fell through `?? 0` / `?? false` into `clear`, rendering "All clear —
 * nothing needs your attention right now." from numbers never read. The
 * all-clear now requires BOTH reads; a partial (or total) signal failure says
 * "could not be fully checked" instead.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getWorkforce, getWorkforceMetrics, getWorkforceGovernance } = vi.hoisted(() => ({
  getWorkforce: vi.fn(), getWorkforceMetrics: vi.fn(), getWorkforceGovernance: vi.fn(),
}));
vi.mock('../../client/workforcesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/workforcesClient.js')>()),
  getWorkforce, getWorkforceMetrics, getWorkforceGovernance,
}));

import { WorkforceOverviewPage } from '../WorkforceOverviewPage.js';

const WF = {
  workforceId: 'w1', name: 'Support pod', businessFunction: 'support', status: 'active' as const,
  purpose: { statement: 'Answer tickets', policyTags: [], refusalBoundaries: [] },
  autonomyLevel: 'assisted' as const, dataManifestId: 'dm1',
  successMetrics: [], workflowCatalog: [], agents: [],
};
const CLEAN_METRICS = { openApprovals: 0, policyViolations: 0, totalRuns: 10, escalationRate: 0, overrideRate: 0, weekly: [], source: 'live' };
const CLEAN_GOV = { autonomy: { eligibleForNext: false, milestones: [] }, posture: { policyViolations: 0 }, source: 'live' };

const mount = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/workforces/w1']}>
      <Routes><Route path="/workforces/:workforceId" element={<WorkforceOverviewPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getWorkforce.mockResolvedValue(WF);
  getWorkforceMetrics.mockResolvedValue(CLEAN_METRICS);
  getWorkforceGovernance.mockResolvedValue(CLEAN_GOV);
});

describe('WF-G2 — the overview all-clear requires both reads', () => {
  it('does not say "All clear" when GOVERNANCE could not be read', async () => {
    getWorkforceGovernance.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('could not be fully checked');
    expect(document.body.textContent).not.toContain('All clear');
  });

  it('does not say "All clear" when METRICS could not be read', async () => {
    getWorkforceMetrics.mockRejectedValue(new Error('500'));
    await mount();
    expect(document.body.textContent).toContain('could not be fully checked');
    expect(document.body.textContent).not.toContain('All clear');
  });

  it('says "could not be fully checked" when BOTH failed (section no longer vanishes)', async () => {
    getWorkforceMetrics.mockRejectedValue(new Error('500'));
    getWorkforceGovernance.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('could not be fully checked');
  });

  it('DOES give the all-clear when both reads succeed and everything is clean', async () => {
    await mount();
    expect(document.body.textContent).toContain('All clear');
    expect(document.body.textContent).not.toContain('could not be fully checked');
  });

  it('a real signal still surfaces beside the warning on a partial read', async () => {
    getWorkforceMetrics.mockResolvedValue({ ...CLEAN_METRICS, openApprovals: 3 });
    getWorkforceGovernance.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('could not be fully checked');
    expect(screen.getAllByText(/awaiting approval/i).length).toBeGreaterThan(0);
  });
});
