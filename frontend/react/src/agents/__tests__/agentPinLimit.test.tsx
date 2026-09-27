/**
 * ADR 0624 D6 / PROF-10 — the 13th pin is an honest `409 validation_error`
 * with `details.maxPinned`, and the agent workspace must SAY the cap in the
 * user's language through its announced error Notice — keyed on the contract
 * (`status` + `details.maxPinned` on the typed `ProfilesApiError`), never on
 * the backend's English prose. Two negative controls pin that the mapping is
 * specific: an ordinary failure keeps the server's own message, and a plain
 * Error whose TEXT looks like the cap does not trigger it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { getMyProfile, setAgentPinned, setChatAgentPinned, loadAgentView, getAgentProfile } = vi.hoisted(() => ({
  getMyProfile: vi.fn(), setAgentPinned: vi.fn(), setChatAgentPinned: vi.fn(), loadAgentView: vi.fn(), getAgentProfile: vi.fn(),
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

import { AgentWorkspacePage } from '../AgentWorkspacePage.js';
import { ProfilesApiError } from '../../features/profiles/profilesClient.js';
import { GlobalLiveRegion } from '../../ui/announce.js';

// A COMPLETE view fixture — an incomplete one throws inside render and fails
// every assertion for a reason unrelated to the defect.
const VIEW = {
  entry: {
    rosterId: 'r1', persona: 'Ada', label: 'Engineer', roleKey: 'engineer',
    autonomyLevel: 'review' as const, agentRef: { agentId: 'a1' },
    workflows: [], tenantId: 't1', enabled: true,
  },
  board: null, cards: [], laneCounts: { todo: 0, working: 0, waiting: 0, done: 0 },
  status: 'active' as const, jobs: [], nextSchedule: null, failureCheckUnavailable: false,
};
const PROFILE = {
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

/** The error Notice the page renders (`ui/Notice`, variant `error`) and the
 *  GLOBAL assertive live region it announces through (`GlobalLiveRegion`). The
 *  region is module-level state, so it is read only right after the action. */
const notice = (): Element | null => document.querySelector('.alert.error');
const spoken = (): string => document.querySelector('[data-owp-live="assertive"]')?.textContent ?? '';

const pinCap = (target: 'sidebar' | 'chat'): ProfilesApiError =>
  new ProfilesApiError('Pinned agents are full (max 12).', 409, {
    error: 'validation_error', message: 'Pinned agents are full (max 12).', details: { maxPinned: 12, target },
  });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  loadAgentView.mockResolvedValue(VIEW);
  getMyProfile.mockResolvedValue(PROFILE);
  getAgentProfile.mockResolvedValue({ roleKey: 'engineer', capabilities: [], metrics: [] });
});

describe('the pin cap (ADR 0624 D6 / PROF-10) reaches the user as a localized, announced line', () => {
  it('sidebar lane: 409 + details.maxPinned → the `wsPinLimit` copy, through the announced error Notice', async () => {
    setAgentPinned.mockRejectedValue(pinCap('sidebar'));
    await mount();
    const item = screen.getByRole('menuitemcheckbox', { name: 'Pin to sidebar' });
    await act(async () => { fireEvent.click(item); });
    const line = 'Pinned agents are full (max 12). Unpin one to pin this agent.';
    expect(notice()?.textContent).toBe(line);
    // …and SPOKEN (PROF-UX-15(b): the Notice carries `announce`), not merely inserted.
    expect(spoken()).toBe(line);
    // The pin did NOT flip (the write was refused) and the menu is usable again.
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect((item as HTMLButtonElement).disabled).toBe(false);
  });

  it('chat lane: the same contract, the same copy', async () => {
    setChatAgentPinned.mockRejectedValue(pinCap('chat'));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pin to AI chat' })); });
    expect(notice()?.textContent).toBe('Pinned agents are full (max 12). Unpin one to pin this agent.');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Pin to AI chat' }).getAttribute('aria-checked')).toBe('false');
  });

  it('negative control — an ordinary failure keeps the server\'s own message, not the cap line', async () => {
    setAgentPinned.mockRejectedValue(new ProfilesApiError('Agent not found.', 404, { error: 'not_found', message: 'Agent not found.', details: { rosterId: 'r1' } }));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pin to sidebar' })); });
    expect(notice()?.textContent).toBe('Agent not found.');
    expect(spoken()).toBe('Agent not found.');
  });

  it('negative control — cap-shaped PROSE on a plain Error is not the contract', async () => {
    setAgentPinned.mockRejectedValue(new Error('Pinned agents are full (max 12).'));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pin to sidebar' })); });
    expect(notice()?.textContent).toBe('Pinned agents are full (max 12).');
    expect(document.body.textContent).not.toContain('Unpin one');
  });

  it('the happy path still flips the pin and renders no error Notice', async () => {
    setAgentPinned.mockResolvedValue({ ...PROFILE, pinnedAgentIds: ['r1'] });
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pin to sidebar' })); });
    expect(screen.getByRole('menuitemcheckbox', { name: 'Pinned to sidebar' }).getAttribute('aria-checked')).toBe('true');
    expect(notice()).toBeNull();
  });
});
