/**
 * TWIN-UX-1, the FAILED-READ leg (MEDIUM-3 of the review fold-in).
 *
 * A failed assignments fetch used to settle `enabled:false` — indistinguishable
 * from a resolved OFF — so `?tab=twin` silently bounced to the profile tab: the
 * consent dashboard vanished with no word, on the surface whose entire job is
 * telling a person who can read their memory. The context now exposes
 * `resolutionFailed`; the tab STAYS, and its body is an announced "could not
 * check" state with a retry through the context's one reload path.
 *
 * Three arms, because the tri-state is the fix: failed ≠ loading ≠ enabled.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess, type FeatureAccessResult } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const { getMyProfile, reload } = vi.hoisted(() => ({ getMyProfile: vi.fn(), reload: vi.fn() }));
let twinAccess: FeatureAccessResult;
vi.mock('../profilesClient.js', async (orig) => ({
  ...(await orig<typeof import('../profilesClient.js')>()),
  getMyProfile,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => twinAccess,
  useAllFeatureAccess: () => ({ byId: {}, allowedFeatures: '*' as const, loading: false, resolutionFailed: true, reload }),
}));
// Composed tabs are other features' surfaces — stubbed, same as profilePageStates.
vi.mock('../../connections/ConnectionsManager.js', () => ({ ConnectionsManager: () => null }));
vi.mock('../../connections/useOAuthCallback.js', () => ({ useOAuthCallbackToast: () => undefined }));
vi.mock('../../../agents/AgentBoardPanel.js', () => ({ AgentBoardPanel: () => null }));
vi.mock('../../../notifications/ApprovalsInbox.js', () => ({ ApprovalsInbox: () => null }));
vi.mock('../../profile-memory/ProfileMemoryTab.js', () => ({ ProfileMemoryTab: () => null }));
vi.mock('../../profile-memory/ProfileKnowledgeTab.js', () => ({ ProfileKnowledgeTab: () => null }));
vi.mock('../../twin/ProfileTwinGrantsTab.js', () => ({ ProfileTwinGrantsTab: () => <div>THE-GRANTS-DASHBOARD</div> }));
vi.mock('../ProfileWorkflowsTab.js', () => ({ ProfileWorkflowsTab: () => null }));
vi.mock('../ProfileSchedulesTab.js', () => ({ ProfileSchedulesTab: () => null }));
vi.mock('../ProfileActivityTab.js', () => ({ ProfileActivityTab: () => null }));
vi.mock('../../../kanban/kanbanClient.js', () => ({ getPersonalBoard: vi.fn() }));
vi.mock('../../users/usersClient.js', () => ({ updateMyDisplayName: vi.fn() }));

import { ProfilePage } from '../ProfilePage.js';

const PROFILE = {
  userId: 'u1', tenantId: 't1', displayName: 'Ada Lovelace',
  skills: [], equipment: [], interests: [], workflows: [],
  portfolioAssetTokens: [], pinnedAgentIds: [],
  completeness: 40, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/profile?tab=twin']}><ProfilePage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getMyProfile.mockResolvedValue(PROFILE);
  twinAccess = makeFeatureAccess({ enabled: false, resolutionFailed: true });
});

describe('?tab=twin after a FAILED assignments read', () => {
  it('keeps the tab and renders the "could not check" state, never a silent bounce', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: /who can recall my memory/i })).toBeTruthy();
    expect(document.body.textContent).toContain('Could not check whether twin recall is enabled here');
    // Not the loading fiction, and not the dashboard (which would imply an answer).
    expect(document.body.textContent).not.toContain('THE-GRANTS-DASHBOARD');
  });

  it('the retry re-resolves through the context reload path', async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a merely LOADING toggle still renders the loading state, not the failure', async () => {
    twinAccess = makeFeatureAccess({ enabled: false, loading: true });
    await mount();
    expect(document.body.textContent).not.toContain('Could not check');
    expect(document.body.textContent).toContain('Loading');
  });

  it('an ENABLED toggle renders the dashboard (the failure branch did not eat it)', async () => {
    twinAccess = makeFeatureAccess({ enabled: true });
    await mount();
    expect(document.body.textContent).toContain('THE-GRANTS-DASHBOARD');
  });
});
