/**
 * ADR 1014 P4b — the Deployments tab on a host that SERVES deployments.
 *
 * Born from a review finding: the probe re-ran on every render (the feature
 * registry builds a new tab object per call), each answer reset the tab to
 * hidden, and the page re-fetched in a loop — the tab could not stay open.
 *
 * Red when: the probe runs more than once per agent, the tab does not stay, or the
 * tab is offered where the list answers 404 (this host does not serve deployments).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type ProfilesClient = typeof import('../../features/profiles/profilesClient.js');
type RosterClient = typeof import('../rosterClient.js');
const { getMyProfile, setAgentPinned, setChatAgentPinned, loadAgentView, getAgentProfile } = vi.hoisted(() => ({
  getMyProfile: vi.fn<ProfilesClient['getMyProfile']>(),
  setAgentPinned: vi.fn<ProfilesClient['setAgentPinned']>(),
  setChatAgentPinned: vi.fn<ProfilesClient['setChatAgentPinned']>(),
  loadAgentView: vi.fn<typeof import('../agentViewModel.js')['loadAgentView']>(),
  getAgentProfile: vi.fn<RosterClient['getAgentProfile']>(),
}));
// Spread the real module so `ProfilesApiError` / `pinLimitOf` stay the shipped ones —
// the test exercises the page's use of the contract, not a copy of it.
vi.mock('../../features/profiles/profilesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../features/profiles/profilesClient.js')>()),
  getMyProfile, setAgentPinned, setChatAgentPinned,
}));
vi.mock('../agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../agentViewModel.js')>()),
  loadAgentView,
}));
vi.mock('../rosterClient.js', async (orig) => ({
  ...(await orig<typeof import('../rosterClient.js')>()),
  getAgentProfile, checkAgent: vi.fn(), deleteRosterEntry: vi.fn(), updateRosterEntry: vi.fn(),
}));
// Self-fetching panels the overview composes — stubbed so this test asserts the
// PIN lane, not their internals (each has its own coverage).
vi.mock('../RecurringTasksPanel.js', () => ({ RecurringTasksPanel: () => null }));
vi.mock('../AgentHealthPanel.js', () => ({ AgentHealthPanel: () => null }));
// ADR 1014 P4b — the workspace probes whether this host serves deployments; each case sets the answer.
const listDeployments = vi.hoisted(() => vi.fn(async (): Promise<unknown[] | null> => []));
vi.mock('../../client/agentDeploymentsClient.js', () => ({ listDeployments }));

import { AgentWorkspacePage } from '../AgentWorkspacePage.js';
import type { Profile } from '../../features/profiles/profilesClient.js';
import { GlobalLiveRegion } from '../../ui/announce.js';
import type { AgentView } from '../agentViewModel.js';
import type { AgentProfile } from '../rosterClient.js';

// A COMPLETE view fixture — an incomplete one throws inside render and fails
// every assertion for a reason unrelated to the defect.
const VIEW: AgentView = {
  entry: {
    rosterId: 'r1', persona: 'Ada', label: 'Engineer', roleKey: 'engineer',
    autonomyLevel: 'review', agentRef: { agentId: 'a1' },
    workflows: [], tenantId: 't1', enabled: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  board: null, cards: [], laneCounts: { todo: 0, working: 0, waiting: 0, done: 0 },
  status: 'active', jobs: [], nextSchedule: null, failureCheckUnavailable: false,
};
const AGENT_PROFILE: AgentProfile = {
  profileId: 'p1', tenantId: 't1', roleKey: 'engineer', capabilities: [], metrics: [],
  autonomy: { level: 'review', specLevel: 'draft-only' },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const PROFILE: Profile = {
  userId: 'u1', tenantId: 't1', skills: [], equipment: [], interests: [], workflows: [],
  portfolioAssetTokens: [], pinnedAgentIds: [], pinnedChatAgentIds: [], completeness: 0,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/agents/r1']}>
      <GlobalLiveRegion />
      <Routes><Route path="/agents/:agentId" element={<AgentWorkspacePage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  loadAgentView.mockResolvedValue(VIEW);
  getMyProfile.mockResolvedValue(PROFILE);
  getAgentProfile.mockResolvedValue(AGENT_PROFILE);
  listDeployments.mockResolvedValue([]);
});

describe('the Deployments tab where the host serves deployments', () => {
  it('appears, stays, and probes once', async () => {
    await mount();
    expect(await screen.findByRole('tab', { name: 'Deployments' })).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByRole('tab', { name: 'Deployments' })).toBeTruthy();
    expect(listDeployments).toHaveBeenCalledTimes(1);
  });

  it('is not offered where the list answers 404', async () => {
    listDeployments.mockResolvedValue(null);
    await mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(listDeployments).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('tab', { name: 'Deployments' })).toBeNull();
  });
});
