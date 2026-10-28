/**
 * ARWF-15 — the Migration wizard's target picker offers only workflows the
 * server says resolve for this tenant, flags a saved target that no longer
 * exists, and shows a typed refusal as readable copy.
 *
 * Before: the picker listed `workforce.workflowCatalog` verbatim (15 ids that
 * resolved nowhere after ADR 0775 P2d), and a saved dead id rendered as valid.
 *
 * Sabotage that turns it red: render `wf.workflowCatalog` again; drop the
 * `savedTargetMissing` notice; drop the `isUnresolvedTarget` branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as WfClient from '../../client/workforcesClient.js';
import type { MigrationJourney, Workforce } from '../../client/workforcesClient.js';

const { getWorkforce, getMigrationJourney, getMigrationTargets, patchMigrationJourney, getWorkforceGovernance, getWorkforceShadow } = vi.hoisted(() => ({
  getWorkforceGovernance: vi.fn<typeof WfClient.getWorkforceGovernance>(),
  getWorkforceShadow: vi.fn<typeof WfClient.getWorkforceShadow>(),
  getWorkforce: vi.fn<typeof WfClient.getWorkforce>(),
  getMigrationJourney: vi.fn<typeof WfClient.getMigrationJourney>(),
  getMigrationTargets: vi.fn<typeof WfClient.getMigrationTargets>(),
  patchMigrationJourney: vi.fn<typeof WfClient.patchMigrationJourney>(),
}));
vi.mock('../../client/workforcesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/workforcesClient.js')>()),
  getWorkforce,
  getMigrationJourney,
  getMigrationTargets,
  patchMigrationJourney,
  getWorkforceGovernance,
  getWorkforceShadow,
}));
vi.mock('../../agents/agentWriteAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentWriteAccess.js')>()),
  useAgentWriteAccess: () => true,
}));

import { ApiError } from '../../client/errorEnvelope.js';
import { MigrationWizardPage } from '../MigrationWizardPage.js';

const DEAD = 'openwop-app.agents.invoice-post';
const WF: Workforce = {
  workforceId: 'w1', name: 'Invoices', businessFunction: 'finance', status: 'shadow',
  purpose: { statement: 'Clear invoices', policyTags: [], refusalBoundaries: [] },
  autonomyLevel: 'review', dataManifestId: 'dm1', successMetrics: [],
  workflowCatalog: [DEAD], agents: [], decisionBoundaries: { auto: [], review: [] },
};
const JOURNEY = (target: MigrationJourney['target']): MigrationJourney => ({
  workforceId: 'w1', target, dataManifest: null, boundaries: null, updatedAt: '2026-10-19T00:00:00Z', etag: 'v1',
  stageStatus: { target: 'pending', assess: 'pending', 'map-data': 'pending', 'map-boundaries': 'pending', 'shadow-prove': 'pending', 'cut-over': 'pending' },
});

async function mount(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/workforces/w1/migrate']}>
      <Routes><Route path="/workforces/:workforceId/migrate" element={<MigrationWizardPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  getWorkforce.mockResolvedValue(WF);
  getWorkforceGovernance.mockRejectedValue(new Error('n/a'));
  getWorkforceShadow.mockRejectedValue(new Error('n/a'));
  getMigrationTargets.mockResolvedValue([
    { workflowId: 'wf.seed.service-desk-sla-escalation', name: 'SLA Breach Escalation', source: 'workforce' },
    { workflowId: 'wf-mine', name: 'My flow', source: 'owned' },
  ]);
});

describe('migration target picker', () => {
  it('offers the resolvable targets, never the raw workforce catalog', async () => {
    getMigrationJourney.mockResolvedValue(JOURNEY(null));
    await mount();
    const values = Array.from(screen.getByRole('combobox').querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(['', 'wf.seed.service-desk-sla-escalation', 'wf-mine']);
    expect(values).not.toContain(DEAD);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('wf.seed.service-desk-sla-escalation');
  });

  it('flags a saved target that no longer resolves and will not re-save it', async () => {
    getMigrationJourney.mockResolvedValue(JOURNEY({ workflowId: DEAD, targetOutcome: 'x' }));
    await mount();
    expect(document.body.textContent).toContain(`The saved target workflow \`${DEAD}\` no longer exists`);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Save & continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the typed refusal as readable copy', async () => {
    getMigrationJourney.mockResolvedValue(JOURNEY(null));
    patchMigrationJourney.mockRejectedValue(new ApiError('raw', 400, 'raw server text', 'target_workflow_unresolved'));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save & continue' })); });
    expect(patchMigrationJourney).toHaveBeenCalled();
    expect(document.body.textContent).toContain('That workflow does not exist in this workspace.');
    expect(document.body.textContent).not.toContain('raw server text');
  });
});
