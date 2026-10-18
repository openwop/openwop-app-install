/**
 * ADR 0775 P4 follow-up (`ARWF-11`, workforce PATCH) — the SPA side.
 *
 * A stale cut-over refusal (409 + `details.reason: 'stale_write'`) reads as "someone
 * changed this workforce", and the page re-reads AND SHOWS the other editor's status, so
 * the retry is decided against it. Any other 409 is not a stale write: no stale copy, no
 * re-read (`isStaleWrite` keys on the reason, not the status).
 *
 * Sabotage that turns it red: drop `ifMatch: wf?.etag`; swap the stale copy; skip the
 * re-read; re-read without `setWf`; key `isStaleWrite` on the status alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as WfClient from '../../client/workforcesClient.js';
import type { Workforce, WorkforceGovernance, WorkforceMetrics } from '../../client/workforcesClient.js';

const { getWorkforce, getWorkforceMetrics, getWorkforceGovernance, updateStatusMock } = vi.hoisted(() => ({
  getWorkforce: vi.fn<typeof WfClient.getWorkforce>(),
  getWorkforceMetrics: vi.fn<typeof WfClient.getWorkforceMetrics>(),
  getWorkforceGovernance: vi.fn<typeof WfClient.getWorkforceGovernance>(),
  updateStatusMock: vi.fn<typeof WfClient.updateWorkforceStatus>(),
}));
vi.mock('../../client/workforcesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/workforcesClient.js')>()),
  getWorkforce, getWorkforceMetrics, getWorkforceGovernance, updateWorkforceStatus: updateStatusMock,
}));

import { ApiError } from '../../client/errorEnvelope.js';
import { WorkforceOverviewPage } from '../WorkforceOverviewPage.js';

const WF: Workforce = {
  workforceId: 'w1', name: 'Support pod', businessFunction: 'support', status: 'shadow',
  purpose: { statement: 'Answer tickets', policyTags: [], refusalBoundaries: [] },
  autonomyLevel: 'review', dataManifestId: 'dm1',
  successMetrics: [], workflowCatalog: [], agents: [], decisionBoundaries: { auto: [], review: [] }, etag: 'v1',
};
const METRICS: WorkforceMetrics = {
  workforceId: 'w1', source: 'tenant', totalRuns: 0, terminalRuns: 0, openApprovals: 0, cycleTimeP50Ms: null,
  costPerClearedUsd: null, escalationRate: 0, overrideRate: 0, falsePositiveRate: 0, recoveryRate: 0,
  policyViolations: 0, weekly: [],
};
const GOV: WorkforceGovernance = {
  source: 'tenant',
  autonomy: { workforceId: 'w1', currentTier: 'review', milestones: [], nextTier: null, nextThreshold: null, recentOverrideIncidence: 0, eligibleForNext: false },
  posture: { workforceId: 'w1', totalRuns: 0, overrides: 0, escalations: 0, falsePositives: 0, recoveries: 0, policyViolations: 0, recentEvents: [] },
};
const STALE_COPY = 'Someone changed this workforce after you opened it';

async function mountAndAdvance(refusal: ApiError): Promise<number> {
  getWorkforce.mockResolvedValue(WF);
  getWorkforceMetrics.mockResolvedValue(METRICS);
  getWorkforceGovernance.mockResolvedValue(GOV);
  updateStatusMock.mockRejectedValue(refusal);
  render(
    <MemoryRouter initialEntries={['/workforces/w1']}>
      <Routes><Route path="/workforces/:workforceId" element={<WorkforceOverviewPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  // The other editor moved it shadow → piloting.
  getWorkforce.mockResolvedValue({ ...WF, status: 'piloting', etag: 'v2' });
  const reads = getWorkforce.mock.calls.length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Advance to Assisting/ })); });
  return reads;
}

afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); });

describe('overview cut-over', () => {
  it('sends the loaded version, explains a stale refusal, and re-reads AND shows the workforce', async () => {
    const reads = await mountAndAdvance(new ApiError('changed', 409, 'changed', 'stale_write'));

    expect(updateStatusMock).toHaveBeenCalledWith('w1', 'piloting', { ifMatch: 'v1' });
    expect(document.body.textContent).toContain(STALE_COPY);
    expect(getWorkforce.mock.calls.length).toBe(reads + 1);
    // The re-read is SHOWN: the page is now at piloting, so the forward action moved on
    // and a roll-back to shadow ("Watching") is offered.
    expect(screen.getByRole('button', { name: 'Roll back to Watching' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Advance to Assisting/ })).toBeNull();
  });

  it('a 409 WITHOUT the stale_write reason is not a stale write — no stale copy, no re-read', async () => {
    const reads = await mountAndAdvance(new ApiError('conflict', 409, 'conflict'));

    expect(updateStatusMock).toHaveBeenCalledWith('w1', 'piloting', { ifMatch: 'v1' });
    expect(document.body.textContent).not.toContain(STALE_COPY);
    expect(screen.getByText('conflict')).toBeTruthy();
    expect(getWorkforce.mock.calls.length).toBe(reads);
  });
});
