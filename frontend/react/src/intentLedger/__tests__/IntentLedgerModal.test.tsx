/**
 * CFP A13 port pin — the mission-contract modal no longer hides a managed-LLM call
 * behind a "Draft from conversation" button. The bespoke `draftLedgerFromConversation`
 * REST path is gone; model-authored drafting rides the ONE chat: the launcher stages a
 * composer seed and deep-links the chat scoped to the governance agent (whose
 * `intent-ledger.draft-contract` tool authors the draft for the owner to Approve here).
 *
 * A resurrected conversation-scrape button (or a re-added client call) fails this suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navSpy = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const orig = await importOriginal<typeof import('react-router-dom')>();
  return { ...orig, useNavigate: () => navSpy };
});

const stageSpy = vi.fn();
vi.mock('../../chat/composerSeed.js', () => ({
  stageComposerDraft: (t: string) => stageSpy(t),
  takeStagedComposerDraft: () => null,
}));

// getLedger resolves null ⇒ the modal shows the "draft a mission" create form.
const api = vi.hoisted(() => ({ getLedger: vi.fn(), draftLedger: vi.fn(), decideLedger: vi.fn(), getReckoning: vi.fn() }));
vi.mock('../intentLedgerClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../intentLedgerClient.js')>();
  return { ...orig, getLedger: api.getLedger, draftLedger: api.draftLedger, decideLedger: api.decideLedger, getReckoning: api.getReckoning };
});

import IntentLedgerModal from '../IntentLedgerModal.js';

beforeEach(() => {
  navSpy.mockReset();
  stageSpy.mockReset();
  api.getLedger.mockReset().mockResolvedValue(null);
});

const renderModal = () =>
  render(
    <MemoryRouter>
      <IntentLedgerModal sessionId="s1" onClose={() => { /* noop */ }} lastUserMessage="Plan the launch and email the list" />
    </MemoryRouter>,
  );

describe('IntentLedgerModal — chat-first drafting (CFP A13)', () => {
  it('exposes NO conversation-scraping "Draft from conversation" action', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/create draft/i)).toBeTruthy());
    // The demolished autoDraft button read "Draft from conversation".
    expect(screen.queryByText(/from conversation/i)).toBeNull();
  });

  it('the launcher stages a composer seed + deep-links the chat scoped to the governance agent', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <IntentLedgerModal sessionId="s1" onClose={onClose} lastUserMessage="Plan the launch" />
      </MemoryRouter>,
    );
    const launcher = await screen.findByText(/draft with the assistant/i);
    fireEvent.click(launcher);
    expect(stageSpy).toHaveBeenCalledTimes(1);
    expect(stageSpy.mock.calls[0]![0]).toMatch(/mission contract/i);
    expect(navSpy).toHaveBeenCalledWith('/?agent=feature.assistant.agents.chief-of-staff');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
