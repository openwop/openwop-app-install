/** ADR 1132 D1 — the template dialog's optional "For a client" choice.
 * Breaks if: a failed org read hides the choice silently (it must say so and
 * retry through `useOrgSelection`); the root org is offered as a client; or a
 * chosen client does not reach `onConfirm` while no choice keeps `onConfirm(params)`. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChainTemplate } from '../persistence/backendStore.js';
const listOrgs = vi.fn();
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({ useAllFeatureAccess: () => ({ byId: {} }) }));
vi.mock('../../features/connections/connectionsClient.js', () => ({ listConnections: vi.fn(async () => []), listProviders: vi.fn(async () => []) }));
vi.mock('../../client/accessClient.js', async (orig) => ({ ...await orig<Record<string, unknown>>(), listOrgs: () => listOrgs() }));
const { TemplatePreflightModal } = await import('../TemplatePreflightModal.js');

const chain: ChainTemplate = { chainId: 'c', packName: 'p', label: 'Digest', description: 'd', parameters: { type: 'object', properties: {} },
  requirements: { missingNodeTypeIds: [], connections: [], pinMismatches: [], connectionUsage: 'none' } };
const org = (orgId: string, name: string) => ({ orgId, tenantId: 'ws-1', name, slug: orgId, createdBy: 'u', createdAt: 'x', updatedAt: 'x' });
const open = (onConfirm = vi.fn()) => {
  render(<MemoryRouter><TemplatePreflightModal chain={chain} busy={false} error={null} onConfirm={onConfirm} onClose={() => {}} /></MemoryRouter>);
  return onConfirm;
};
beforeEach(() => { listOrgs.mockReset(); });
afterEach(cleanup);

it('lists client orgs only (not the root) and passes the chosen client to onConfirm', async () => {
  listOrgs.mockResolvedValue([org('ws-1', 'Agency'), org('org-b', 'Client B')]);
  const onConfirm = open();
  const select = await screen.findByLabelText('For a client');
  expect(screen.queryByRole('option', { name: 'Agency' })).toBeNull();
  fireEvent.change(select, { target: { value: 'org-b' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add to my workflows' }));
  expect(onConfirm).toHaveBeenCalledWith({}, 'org-b');
});

it('a failed org read says so and retries; it is not shown as "no clients"', async () => {
  listOrgs.mockRejectedValueOnce(new Error('down')).mockResolvedValue([org('org-b', 'Client B')]);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  expect(await screen.findByLabelText('For a client')).toBeTruthy();
  expect(listOrgs).toHaveBeenCalledTimes(2);
});
