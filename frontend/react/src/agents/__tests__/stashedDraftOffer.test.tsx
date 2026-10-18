/**
 * ADR 0514 OQ1 — the stashed-draft prefill offer on /agents/new.
 * Invariants:
 *   - a stash renders a DISMISSIBLE offer, never an auto-apply
 *   - Apply prefills the wizard (custom mode, persona name, autonomy,
 *     workflows) and CONSUMES the stash
 *   - Dismiss consumes without touching the form
 *   - toggle OFF: no fetch, no offer (polarity)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
import { makeFeatureAccess } from '../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));
vi.mock('../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: () => <div data-testid="embedded-chat" />,
}));
type DraftClient = typeof import('../agentAuthorDraftClient.js');
const draftClient = vi.hoisted(() => ({
  getStashedAgentDraft: vi.fn<DraftClient['getStashedAgentDraft']>(),
  dismissStashedAgentDraft: vi.fn<DraftClient['dismissStashedAgentDraft']>(),
}));
vi.mock('../agentAuthorDraftClient.js', () => draftClient);

import { AgentCreateWizard } from '../AgentCreateWizard.js';

beforeEach(() => {
  vi.resetAllMocks();
  draftClient.dismissStashedAgentDraft.mockResolvedValue(undefined);
});
afterEach(cleanup);

// Asymmetric against the wizard defaults: autonomy 'review' (default 'auto'),
// one workflow (default none), a role title (default empty).
const STASH: Awaited<ReturnType<DraftClient['getStashedAgentDraft']>> = {
  draft: { persona: 'Nova Prefill', agentId: 'test.backing', roleKey: 'researcher', autonomyLevel: 'review', workflows: ['wf.alpha'] },
  stashedAt: '2026-08-02T00:00:00Z',
};

function view(): void {
  render(<MemoryRouter><AgentCreateWizard /></MemoryRouter>);
}

describe('ADR 0514 OQ1 — stashed draft offer', () => {
  it('offers the draft and Apply prefills + consumes', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
    draftClient.getStashedAgentDraft.mockResolvedValue(STASH);
    view();
    const offer = await screen.findByText(/drafted .*Nova Prefill/);
    expect(offer).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to form' }));
    // Prefilled: custom mode, the persona name, the role title.
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Nova Prefill');
    expect(screen.getByRole('button', { name: /Custom role/ }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Role title') as HTMLInputElement).value).toBe('researcher');
    // Consumed: the stash was deleted and the offer is gone.
    expect(draftClient.dismissStashedAgentDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/drafted .*Nova Prefill/)).toBeNull();
    // Autonomy + workflows live on later steps: walk to the review step (5).
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: /^Supervised/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^Autonomous/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Workflows', { selector: 'dt' }).nextElementSibling?.textContent).toBe('wf.alpha');
  });

  it('Dismiss consumes WITHOUT touching the form', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
    draftClient.getStashedAgentDraft.mockResolvedValue(STASH);
    view();
    await screen.findByText(/drafted .*Nova Prefill/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(draftClient.dismissStashedAgentDraft).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe(''); // untouched
    expect(screen.queryByText(/drafted .*Nova Prefill/)).toBeNull();
  });

  it('toggle OFF: no fetch, no offer (polarity)', async () => {
    access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    draftClient.getStashedAgentDraft.mockResolvedValue(STASH);
    view();
    await waitFor(() => expect(draftClient.getStashedAgentDraft).not.toHaveBeenCalled());
    expect(screen.queryByText(/drafted/)).toBeNull();
  });
});
