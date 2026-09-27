/**
 * UX_UPGRADE-workforces WF-G1 — a governance console may say "we could not
 * check". It may not say "zero".
 *
 * The gallery reads metrics AND governance per workforce, each with its own
 * `.catch(() => null)`. When only ONE failed, the row still built `signals` and
 * the missing side's numbers fell back to **0** — so a failed governance read
 * rendered "0 policy violations", a failed metrics read rendered "0 open
 * approvals", and those fabricated zeroes then fed `nothingNeedsYou`, which
 * tells an admin the whole fleet is clear.
 *
 * This is the sharpest form of the failed-read class found in this programme:
 * the surface exists to show what needs a human, and it was manufacturing an
 * all-clear out of a read it never completed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listWorkforces, getWorkforceMetrics, getWorkforceGovernance } = vi.hoisted(() => ({
  listWorkforces: vi.fn(), getWorkforceMetrics: vi.fn(), getWorkforceGovernance: vi.fn(),
}));
vi.mock('../../client/workforcesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/workforcesClient.js')>()),
  listWorkforces, getWorkforceMetrics, getWorkforceGovernance,
}));

import { WorkforcesGalleryPage } from '../WorkforcesGalleryPage.js';

// The real Workforce shape — an incomplete fixture throws in WorkforceCard and
// every assertion below then fails for the wrong reason.
const wf = (workforceId: string, name: string) => ({
  workforceId, name, businessFunction: 'support', status: 'active' as const,
  purpose: { statement: 'Answer tickets', policyTags: [], refusalBoundaries: [] },
  autonomyLevel: 'assisted' as const, dataManifestId: 'dm1',
  successMetrics: [], workflowCatalog: [], agents: [],
});
const WF = wf('w1', 'Support pod');
const CLEAN_METRICS = { openApprovals: 0, policyViolations: 0, totalRuns: 10, escalationRate: 0, source: 'live' };
const CLEAN_GOV = { autonomy: { eligibleForNext: false }, posture: { policyViolations: 0 }, source: 'live' };

const mount = async (): Promise<void> => {
  render(<MemoryRouter><WorkforcesGalleryPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listWorkforces.mockResolvedValue([WF]);
  getWorkforceMetrics.mockResolvedValue(CLEAN_METRICS);
  getWorkforceGovernance.mockResolvedValue(CLEAN_GOV);
});

describe('WF-G1 — a partially-read workforce cannot support an all-clear', () => {
  it('does not claim nothing needs you when GOVERNANCE could not be read', async () => {
    getWorkforceGovernance.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('could not be fully checked');
    // The all-clear is the specific claim this fix removes.
    expect(document.body.textContent).not.toContain('nothing needs your attention');
  });

  it('does not claim nothing needs you when METRICS could not be read', async () => {
    getWorkforceMetrics.mockRejectedValue(new Error('500'));
    await mount();
    expect(document.body.textContent).toContain('could not be fully checked');
  });

  it('DOES give the all-clear when both reads succeed and everything is clean', async () => {
    // The failure mode of this fix is never showing the all-clear again — which
    // would make the console useless in the case it exists for.
    await mount();
    expect(document.body.textContent).not.toContain('could not be fully checked');
    expect(document.body.textContent).toContain('nothing needs your attention');
  });

  it('a real violation still surfaces, and no unreadable warning appears', async () => {
    getWorkforceGovernance.mockResolvedValue({ ...CLEAN_GOV, posture: { policyViolations: 2 } });
    getWorkforceMetrics.mockResolvedValue({ ...CLEAN_METRICS, policyViolations: 2 });
    await mount();
    expect(document.body.textContent).not.toContain('could not be fully checked');
    expect(document.body.textContent).not.toContain('nothing needs your attention');
  });

  it('counts every partially-read workforce, not just the first', async () => {
    listWorkforces.mockResolvedValue([WF, wf('w2', 'Ops pod')]);
    getWorkforceGovernance.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.getByText(/2 workforce\(s\) could not be fully checked/)).toBeTruthy();
  });
});
