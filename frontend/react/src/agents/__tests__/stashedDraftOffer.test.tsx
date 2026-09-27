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
const draftClient = vi.hoisted(() => ({
  getStashedAgentDraft: vi.fn(),
  dismissStashedAgentDraft: vi.fn(async () => undefined),
}));
vi.mock('../agentAuthorDraftClient.js', () => draftClient);

import { AgentCreateWizard } from '../AgentCreateWizard.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const STASH = {
  draft: { persona: 'Nova Prefill', agentId: 'test.backing', roleKey: 'researcher', autonomyLevel: 'review' as const, workflows: ['wf.alpha'] },
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
    // Prefilled: the name field carries the persona.
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe('Nova Prefill');
    // Consumed: the stash was deleted and the offer is gone.
    expect(draftClient.dismissStashedAgentDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/drafted .*Nova Prefill/)).toBeNull();
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
