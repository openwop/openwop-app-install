/**
 * ADR 1005 P3c / ADR 1014 P4b — the deployment console.
 *
 * Red when: a promote is sent with the wrong target or channel; a transition an
 * approval gate holds (RFC 0254 `202`: the record unchanged except
 * `transitionRunId`) is reported as applied; a refused transition is reported as
 * applied; a viewer is offered transitions; a host that does not serve deployments
 * shows a table. (Whether the tab is offered: `agents/__tests__/workspaceDeploymentsTab`.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

type Client = typeof import('../../../client/agentDeploymentsClient.js');
const { listDeployments, getPolicy, putPolicy, transitionDeployment } = vi.hoisted(() => ({
  listDeployments: vi.fn<Client['listDeployments']>(),
  getPolicy: vi.fn<Client['getPolicy']>(),
  putPolicy: vi.fn<Client['putPolicy']>(),
  transitionDeployment: vi.fn<Client['transitionDeployment']>(),
}));
vi.mock('../../../client/agentDeploymentsClient.js', async (orig) => ({
  ...(await orig<Client>()),
  listDeployments, getPolicy, putPolicy, transitionDeployment,
}));

import { AgentDeploymentsPanel } from '../AgentDeploymentsPanel.js';
import { messages as en } from '../i18n/en.js';
import type { DeploymentRecord } from '../../../client/agentDeploymentsClient.js';

const AGENT = 'acme.agents.console.a';
const draft: DeploymentRecord = { agentId: AGENT, version: '1.1.0', state: 'staged' };
const active: DeploymentRecord = { agentId: AGENT, version: '1.0.0', state: 'active', channels: ['stable'] };

beforeEach(() => {
  listDeployments.mockResolvedValue([active, draft]);
  getPolicy.mockResolvedValue({ agentId: AGENT, fixed: false, revision: 1, policy: { approval: { onActivate: true } } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const mount = async (canWrite = true): Promise<void> => {
  await act(async () => { render(<AgentDeploymentsPanel agentId={AGENT} persona="P" canWrite={canWrite} />); });
};

describe('the deployment console', () => {
  it('promotes a staged version to active on stable', async () => {
    transitionDeployment.mockResolvedValue({ record: { ...draft, state: 'active', channels: ['stable'] }, pending: false });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote to Active' })); });
    expect(transitionDeployment).toHaveBeenCalledWith(AGENT, draft, { transition: 'promote', toState: 'active', channel: 'stable' });
    expect(screen.getByText('1.1.0 is now Active.')).toBeTruthy();
  });

  it('a gated promote says it waits for someone else, never that it applied', async () => {
    transitionDeployment.mockResolvedValue({ record: { ...draft, transitionRunId: 'run-1' }, pending: true });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote to Active' })); });
    expect(screen.getByText(en.deployPending.replace('{{version}}', '1.1.0'))).toBeTruthy();
    expect(screen.queryByText('1.1.0 is now Active.')).toBeNull();
  });

  it('a refused transition is shown as refused', async () => {
    transitionDeployment.mockRejectedValue(new Error('A staged version cannot be sent `pause`.'));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote to Active' })); });
    expect(screen.getByText('A staged version cannot be sent `pause`.')).toBeTruthy();
  });

  it('a viewer sees versions and policy but no transitions and no save', async () => {
    await mount(false);
    expect(screen.getByText('1.0.0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Promote to Active' })).toBeNull();
    expect(screen.queryByRole('button', { name: en.deployPolicySave })).toBeNull();
  });

  it('a host that does not serve deployments says so', async () => {
    listDeployments.mockResolvedValue(null);
    await mount();
    expect(screen.getByText(en.deployNotServed)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
