/**
 * ADR 0889 grade remediation (EVUX-5 / EVUX-20) — the agent workspace's tab
 * host. A feature tab reports unsaved edits through `onDirtyChange`; switching
 * tabs then asks first (the shared `useConfirmDiscardUnsaved` dialog), and a
 * "stay" keeps the tab. The strip's tabs control ONE tabpanel named after the
 * selected tab. The feature tab is a stub so this pins the HOST's contract,
 * not the Evals panel (which has its own coverage).
 *
 * Sabotage-witnessed: drop the `confirmLeaveTab()` await in `setTab` → case 1
 * red; never reset `tabDirty` after a switch → case 2 red; drop `aria-controls`
 * / the tabpanel → case 3 red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
import type { AgentView } from '../agentViewModel.js';
import type { Profile } from '../../features/profiles/profilesClient.js';

type ProfilesClient = typeof import('../../features/profiles/profilesClient.js');
type ViewModel = typeof import('../agentViewModel.js');
type RosterClient = typeof import('../rosterClient.js');
type ConfirmModule = typeof import('../../ui/confirm.js');
const { getMyProfile, loadAgentView, getAgentProfile, confirm } = vi.hoisted(() => ({
  getMyProfile: vi.fn<ProfilesClient['getMyProfile']>(),
  loadAgentView: vi.fn<ViewModel['loadAgentView']>(),
  getAgentProfile: vi.fn<RosterClient['getAgentProfile']>(),
  confirm: vi.fn<ConfirmModule['confirm']>(),
}));
vi.mock('../../features/profiles/profilesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../features/profiles/profilesClient.js')>()),
  getMyProfile, setAgentPinned: vi.fn(), setChatAgentPinned: vi.fn(),
}));
vi.mock('../agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../agentViewModel.js')>()),
  loadAgentView,
}));
vi.mock('../rosterClient.js', async (orig) => ({
  ...(await orig<typeof import('../rosterClient.js')>()),
  getAgentProfile, checkAgent: vi.fn(), deleteRosterEntry: vi.fn(), updateRosterEntry: vi.fn(),
}));
vi.mock('../RecurringTasksPanel.js', () => ({ RecurringTasksPanel: () => null }));
vi.mock('../AgentHealthPanel.js', () => ({ AgentHealthPanel: () => null }));
vi.mock('../../ui/confirm.js', () => ({ confirm }));
vi.mock('../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));
// A stub Evals tab that can mark itself dirty — the host contract under test.
vi.mock('../../features/registry.js', async (orig) => ({
  ...(await orig<typeof import('../../features/registry.js')>()),
  featureAgentWorkspaceTabs: () => [{
    featureId: 'evals', key: 'evals', labelKey: 'wsTabEvals',
    render: (p: { onDirtyChange?: (d: boolean) => void }) => (
      <button type="button" onClick={() => p.onDirtyChange?.(true)}>stub: make dirty</button>
    ),
  }],
}));

import { AgentWorkspacePage } from '../AgentWorkspacePage.js';

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
const PROFILE: Profile = {
  userId: 'u1', tenantId: 't1', skills: [], equipment: [], interests: [], workflows: [],
  portfolioAssetTokens: [], pinnedAgentIds: [], pinnedChatAgentIds: [], completeness: 0,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(
    <MemoryRouter initialEntries={['/agents/r1?tab=evals']}>
      <Routes><Route path="/agents/:agentId" element={<AgentWorkspacePage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
};
const selected = (): string | null => screen.getAllByRole('tab').find((el) => el.getAttribute('aria-selected') === 'true')?.textContent ?? null;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // mockReset, not clearAllMocks alone: a queued confirm.mockResolvedValueOnce from a
  // case that went red mid-way must not answer the next case.
  confirm.mockReset();
  loadAgentView.mockResolvedValue(VIEW);
  getMyProfile.mockResolvedValue(PROFILE);
  getAgentProfile.mockResolvedValue(null); // the Evals tab under test never reads it
});

describe('workspace tab host — unsaved edits (EVUX-5)', () => {
  it('asks before leaving a dirty tab, and "stay" keeps it', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'stub: make dirty' }));
    confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(selected()).toBe('Evals');
    expect(screen.getByRole('button', { name: 'stub: make dirty' })).toBeTruthy();

    confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(selected()).toBe('Overview'));
  });

  it('a clean tab switches without asking, and a discarded draft does not ask again', async () => {
    await mount();
    await screen.findByRole('button', { name: 'stub: make dirty' });
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(selected()).toBe('Overview'));
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Evals' }));
    fireEvent.click(await screen.findByRole('button', { name: 'stub: make dirty' }));
    confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(selected()).toBe('Overview'));
    fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
    await waitFor(() => expect(selected()).toBe('Board'));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('workspace tab host — tab semantics (EVUX-20)', () => {
  it('every tab controls the one tabpanel, which is labelled by the selected tab', async () => {
    await mount();
    await screen.findByRole('button', { name: 'stub: make dirty' });
    const panel = screen.getByRole('tabpanel');
    for (const tab of screen.getAllByRole('tab')) expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe('ws-tab-evals');
    expect(screen.getByRole('tabpanel', { name: 'Evals' })).toBe(panel);
  });
});
