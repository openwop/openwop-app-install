/**
 * UX_UPGRADE-workforces WF-G2 — the overview's "Needs you" all-clear had the
 * same one-failed zero-fill the gallery's WF-G1 fixed (#2568), missed on this
 * screen: with governance (or metrics) unreadable, the surviving side's clean
 * numbers fell through `?? 0` / `?? false` into `clear`, rendering "All clear —
 * nothing needs your attention right now." from numbers never read. The
 * all-clear now requires BOTH reads; a partial (or total) signal failure says
 * "could not be fully checked" instead.
 *
 * Sabotage that turns it red: `partial = !metrics` (or `!governance`); drop `!partial`
 * from `clear`; drop the warning Notice; hide the needs-you chips on a partial read.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type * as WfClient from '../../client/workforcesClient.js';
import type { Workforce, WorkforceGovernance, WorkforceMetrics } from '../../client/workforcesClient.js';

const { getWorkforce, getWorkforceMetrics, getWorkforceGovernance } = vi.hoisted(() => ({
  getWorkforce: vi.fn<typeof WfClient.getWorkforce>(),
  getWorkforceMetrics: vi.fn<typeof WfClient.getWorkforceMetrics>(),
  getWorkforceGovernance: vi.fn<typeof WfClient.getWorkforceGovernance>(),
}));
vi.mock('../../client/workforcesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/workforcesClient.js')>()),
  getWorkforce, getWorkforceMetrics, getWorkforceGovernance,
}));

import { WorkforceOverviewPage } from '../WorkforceOverviewPage.js';

const WF: Workforce = {
  workforceId: 'w1', name: 'Support pod', businessFunction: 'support', status: 'piloting',
  purpose: { statement: 'Answer tickets', policyTags: [], refusalBoundaries: [] },
  autonomyLevel: 'guided', dataManifestId: 'dm1',
  successMetrics: [], workflowCatalog: [], agents: [], decisionBoundaries: { auto: [], review: [] },
};
const CLEAN_METRICS: WorkforceMetrics = {
  workforceId: 'w1', source: 'tenant', totalRuns: 10, terminalRuns: 10, openApprovals: 0, cycleTimeP50Ms: null,
  costPerClearedUsd: null, escalationRate: 0, overrideRate: 0, falsePositiveRate: 0, recoveryRate: 0,
  policyViolations: 0, weekly: [],
};
const CLEAN_GOV: WorkforceGovernance = {
  source: 'tenant',
  autonomy: { workforceId: 'w1', currentTier: 'guided', milestones: [], nextTier: 'auto', nextThreshold: null, recentOverrideIncidence: 0, eligibleForNext: false },
  posture: { workforceId: 'w1', totalRuns: 10, overrides: 0, escalations: 0, falsePositives: 0, recoveries: 0, policyViolations: 0, recentEvents: [] },
};

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
  vi.resetAllMocks();
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
    // The CHIP, exactly: the telemetry label "Runs · 3 awaiting approval" also renders
    // whenever metrics has runs, so a loose /awaiting approval/ was satisfied without it.
    expect(screen.getByText('3 awaiting approval')).toBeTruthy();
  });
});
