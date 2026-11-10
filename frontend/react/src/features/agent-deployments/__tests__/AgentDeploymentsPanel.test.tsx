/**
 * ADR 1005 P3c / ADR 1014 P4b — the deployment console.
 *
 * Red when: a promote is sent with the wrong target or channel; a transition an
 * approval gate holds (RFC 0254 `202`: the record unchanged except
 * `transitionRunId`) is reported as applied; a refused transition is reported as
 * applied; a viewer is offered transitions or a save, or is not shown the policy;
 * a host that does not serve deployments shows a table. (Whether the tab is offered:
 * `agents/__tests__/workspaceDeploymentsTab`.)
 *
 * Sabotage-witnessed (w83): send channel `canary` on promote; drop the `pending`
 * branch; show a refusal as applied; offer the transition or save column to a
 * viewer; hide the policy section; show the empty copy for a 404 list. Each
 * turns its case red.
 *
 * The refusal fixture is the production `ApiError` that `requestJson` throws. Its
 * message carries the `POST <path> → 409:` prefix and the console shows it (grade-code
 * TST-FJ-GC-1), so the case matches the server's sentence, not the whole notice.
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
import { ApiError } from '../../../client/requestJson.js';

const AGENT = 'acme.agents.console.a';
const draft: DeploymentRecord = { agentId: AGENT, version: '1.1.0', state: 'staged' };
const active: DeploymentRecord = { agentId: AGENT, version: '1.0.0', state: 'active', channels: ['stable'] };

beforeEach(() => {
  listDeployments.mockResolvedValue([active, draft]);
  getPolicy.mockResolvedValue({ agentId: AGENT, fixed: false, revision: 1, policy: { approval: { onActivate: true } } });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const mount = async (canWrite = true): Promise<void> => {
  await act(async () => { render(<AgentDeploymentsPanel agentId={AGENT} persona="P" canWrite={canWrite} />); });
};

describe('the deployment console', () => {
  it('promotes a staged version to active on stable', async () => {
    transitionDeployment.mockResolvedValue({ record: { ...draft, state: 'active', channels: ['stable'] }, pending: false });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote to Active' })); });
    expect(transitionDeployment).toHaveBeenCalledTimes(1);
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
    const url = `/agents/${AGENT}/deployments`;
    transitionDeployment.mockRejectedValue(new ApiError({
      status: 409, statusText: 'Conflict', url, body: { error: 'conflict', message: 'A staged version cannot be sent `pause`.' },
      message: `POST ${url} → 409: A staged version cannot be sent \`pause\`.`,
    }));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Promote to Active' })); });
    expect(screen.getByText(/A staged version cannot be sent `pause`\./)).toBeTruthy();
    expect(screen.queryByText('1.1.0 is now Active.')).toBeNull();
  });

  it('a viewer sees versions and policy but no transitions and no save', async () => {
    await mount(false);
    expect(screen.getByText('1.0.0')).toBeTruthy();
    // The policy is shown read-only: approval on (the fixture), eval off.
    const approval = screen.getByRole('checkbox', { name: en.deployPolicyApproval }) as HTMLInputElement;
    expect(approval.disabled).toBe(true);
    expect(approval.checked).toBe(true);
    const evalBox = screen.getByRole('checkbox', { name: en.deployPolicyEval }) as HTMLInputElement;
    expect(evalBox.disabled).toBe(true);
    expect(evalBox.checked).toBe(false);
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
