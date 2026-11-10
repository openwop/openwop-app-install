/** ADR 1065: actual gallery/preflight must not turn missing literal refs into
 * account-readiness guarantees. Connections are mocked metadata, never contacted.
 * Breaks if: `runsWithZeroConnections` or the preflight `zeroConfig` accepts anything
 * but explicit `connectionUsage: 'none'`; the uses/unknown Notice copy swaps or
 * disappears; a gallery card chips a non-none template. (The explicit-none preflight
 * control lives in TemplatePreflightModal.pinMismatch.test.tsx, grade-tests w93.) */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChainTemplate } from '../persistence/backendStore.js';
const listTemplates = vi.fn();
vi.mock('../persistence/backendStore.js', async (orig) => ({
  ...await orig<Record<string, unknown>>(),
  listChainTemplates: () => listTemplates(),
  listWorkflows: vi.fn(async () => []), migrateLocalToBackend: vi.fn(async () => {}),
}));
vi.mock('../../platform/useStorageSubject.js', () => ({ useStorageSubject: () => ({ status: 'user', subject: 'unit-test' }) }));
vi.mock('../../workflows/fleetInsightsClient.js', () => ({ fetchFleetStats: vi.fn(async () => ({ rowsConsidered: 0, workflows: [] })) }));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({ useAllFeatureAccess: () => ({ byId: {} }) }));
vi.mock('../../features/connections/connectionsClient.js', () => ({ listConnections: vi.fn(async () => []), listProviders: vi.fn(async () => []) }));
import { TemplatePreflightModal } from '../TemplatePreflightModal.js';
import { WorkflowsDashboard } from '../WorkflowsDashboard.js';
import { runsWithZeroConnections } from '../persistence/backendStore.js';
function chain(label: string, usage?: 'uses' | 'none' | 'unknown'): ChainTemplate {
  return { chainId: label, packName: 'unit-test', label, description: 'Controlled metadata fixture', parameters: { type: 'object', properties: {} },
    requirements: { missingNodeTypeIds: [], connections: [], pinMismatches: [], ...(usage ? { connectionUsage: usage } : {}) } };
}
beforeEach(() => { listTemplates.mockReset().mockResolvedValue([]); });
afterEach(cleanup);
it('requires explicit no-account metadata; older/unknown declarations are not positive controls', () => {
  expect(runsWithZeroConnections(chain('Known none', 'none'))).toBe(true);
  expect(runsWithZeroConnections(chain('Indirect account', 'uses'))).toBe(false);
  expect(runsWithZeroConnections(chain('Uncertain', 'unknown'))).toBe(false);
  expect(runsWithZeroConnections(chain('Old server'))).toBe(false);
});
it('actual gallery only gives the no-account chip to the explicit none template', async () => {
  listTemplates.mockResolvedValue([chain('Metrics sync', 'uses'), chain('Review workflow', 'unknown'), chain('Format values', 'none')]);
  render(<MemoryRouter><WorkflowsDashboard /></MemoryRouter>);
  for (const [name, eligible] of [['Metrics sync', false], ['Review workflow', false], ['Format values', true]] as const) {
    const heading = await screen.findByRole('heading', { name });
    const card = heading.closest('.workflow-template-card');
    if (!(card instanceof HTMLElement)) throw new Error('Actual gallery card did not render');
    expect(within(card).queryByText('No connected accounts needed') !== null).toBe(eligible);
    expect(within(card).getByRole('button', { name: `Use template: ${name}` })).toBeTruthy();
  }
});
it.each(['uses', 'unknown', undefined] as const)('actual preflight gives honest setup guidance for %s and remains copyable', async (usage) => {
  const onConfirm = vi.fn();
  render(<MemoryRouter><TemplatePreflightModal chain={chain('Metrics sync', usage)} busy={false} error={null} onConfirm={onConfirm} onClose={() => {}} /></MemoryRouter>);
  expect(await screen.findByText(usage === 'uses' ? /This workflow uses connected accounts/ : /Account setup may be needed/)).toBeTruthy();
  expect(screen.queryByText('No connected accounts needed')).toBeNull();
  expect(screen.getByRole('button', { name: 'Review connections' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add to my workflows' }));
  expect(onConfirm).toHaveBeenCalledWith({});
});
