/**
 * ADR 0775 D1 (architect M1) — a refused auto-seed must not fail the agents page.
 *
 * The demo deployment auto-seeds the example roster when the caller's roster is
 * empty. ADR 0775 gates that seed on edit access, so a VIEWER of an empty
 * shared workspace is refused (403). The roster read already answered "no
 * agents yet", which is still true, so the page shows the empty state with its
 * explicit actions — not an error banner carrying `seedExampleAgents returned 403`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { seedExampleAgents, loadAgentViews, getCapabilities, listApprovals, access } = vi.hoisted(() => ({
  seedExampleAgents: vi.fn(), loadAgentViews: vi.fn(), getCapabilities: vi.fn(), listApprovals: vi.fn(),
  access: { current: { access: { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }, resolved: true } as { access: { roles: string[]; scopes: string[]; basis: string }; resolved: boolean } },
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState: () => access.current,
}));
vi.mock('../../client/useDemoMode.js', () => ({ useDemoMode: () => true }));
vi.mock('../rosterClient.js', async (orig) => ({ ...(await orig<typeof import('../rosterClient.js')>()), seedExampleAgents }));
vi.mock('../agentViewModel.js', async (orig) => ({ ...(await orig<typeof import('../agentViewModel.js')>()), loadAgentViews }));
vi.mock('../../client/runsClient.js', async (orig) => ({ ...(await orig<typeof import('../../client/runsClient.js')>()), getCapabilities }));
vi.mock('../approvalsClient.js', async (orig) => ({ ...(await orig<typeof import('../approvalsClient.js')>()), listApprovals }));

import { AgentDashboardPage } from '../AgentDashboardPage.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const VIEWER = { access: { roles: ['viewer'], scopes: ['workspace:read'], basis: 'member' }, resolved: true };
const EDITOR = { access: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' }, resolved: true };

describe('ADR 0775 D1 — a viewer’s refused auto-seed', () => {
  it('renders the VIEWER empty state — no error, and no write button the server would refuse', async () => {
    access.current = VIEWER;
    loadAgentViews.mockResolvedValue([]);
    getCapabilities.mockResolvedValue({ demoMode: true });
    seedExampleAgents.mockRejectedValue(new Error('seedExampleAgents returned 403'));
    listApprovals.mockResolvedValue([]);
    render(<MemoryRouter><AgentDashboardPage /></MemoryRouter>);
    await waitFor(() => expect(seedExampleAgents).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Agents are named digital coworkers/i)).toBeTruthy();
    expect(screen.queryByText(/returned 403/)).toBeNull();
    // Grade-ux ARUX-4 — every button on that empty state was a write.
    expect(screen.getByText(/adding one needs edit access/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Hire an agent/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Load example agents/i })).toBeNull();
  });

  it('a non-refusal failure of the auto-seed still surfaces (grade-code ARCD-7)', async () => {
    access.current = EDITOR;
    loadAgentViews.mockResolvedValue([]);
    getCapabilities.mockResolvedValue({ demoMode: true });
    seedExampleAgents.mockRejectedValue(new Error('seedExampleAgents returned 500'));
    listApprovals.mockResolvedValue([]);
    render(<MemoryRouter><AgentDashboardPage /></MemoryRouter>);
    expect(await screen.findByText(/returned 500/)).toBeTruthy();
  });

  it('an editor keeps the write controls', async () => {
    access.current = EDITOR;
    loadAgentViews.mockResolvedValue([]);
    getCapabilities.mockResolvedValue({ demoMode: false });
    listApprovals.mockResolvedValue([]);
    render(<MemoryRouter><AgentDashboardPage /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /Hire an agent/i })).toBeTruthy();
  });

  it('a successful auto-seed still re-reads the roster', async () => {
    access.current = EDITOR;
    loadAgentViews.mockResolvedValue([]);
    getCapabilities.mockResolvedValue({ demoMode: true });
    seedExampleAgents.mockResolvedValue({ seeded: true, agents: 10 });
    listApprovals.mockResolvedValue([]);
    render(<MemoryRouter><AgentDashboardPage /></MemoryRouter>);
    await waitFor(() => expect(loadAgentViews).toHaveBeenCalledTimes(2));
  });
});
