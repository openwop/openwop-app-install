/**
 * CFP A13 port pin — the mission-contract modal no longer hides a managed-LLM call
 * behind a "Draft from conversation" button. The bespoke `draftLedgerFromConversation`
 * REST path is gone; model-authored drafting rides the ONE chat: the launcher stages a
 * composer seed and deep-links the chat scoped to the governance agent (whose
 * `intent-ledger.draft-contract` tool authors the draft for the owner to Approve here).
 *
 * A resurrected conversation-scrape button (or a re-added client call) fails this suite.
 *
 * ADR 0856 D2 — in a project's conversation a new mission starts from the team ledger
 * (goal pre-filled, inherited scope + kept restrictions shown); outside one nothing is
 * inherited, which must stay distinguishable from a FAILED pre-fill read (the server
 * still applies the restrictions then, so the modal says so).
 * What turns it red (sabotage-probed, /grade-tests w29): a "Draft from conversation"
 * action, not staging the seed / not deep-linking the governance agent / not closing,
 * dropping the goal pre-fill or any inherited list, rendering the region for a null
 * pre-fill, or a failed pre-fill read rendered as "nothing inherited".
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
type Client = typeof import('../intentLedgerClient.js');
const api = vi.hoisted(() => ({
  getLedger: vi.fn<Client['getLedger']>(),
  getPrefill: vi.fn<Client['getPrefill']>(),
  draftLedger: vi.fn<Client['draftLedger']>(),
  decideLedger: vi.fn<Client['decideLedger']>(),
  getReckoning: vi.fn<Client['getReckoning']>(),
}));
vi.mock('../intentLedgerClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../intentLedgerClient.js')>();
  return { ...orig, getLedger: api.getLedger, getPrefill: api.getPrefill, draftLedger: api.draftLedger, decideLedger: api.decideLedger, getReckoning: api.getReckoning };
});

import IntentLedgerModal from '../IntentLedgerModal.js';
import { LedgerChangedError, MissionNotFoundError, type IntentLedger } from '../intentLedgerClient.js';

beforeEach(() => {
  navSpy.mockReset();
  stageSpy.mockReset();
  api.getLedger.mockReset().mockResolvedValue({ ledger: null, viewer: { mayEdit: true, mayDecide: true } });
  api.decideLedger.mockReset();
  api.getReckoning.mockReset().mockResolvedValue(null);
  api.getPrefill.mockReset().mockResolvedValue(null);
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
    // IL2UX-2 — the link names THIS conversation, so the draft lands on it (not a new tab).
    expect(navSpy).toHaveBeenCalledWith('/chat?conversation=s1&agent=vendor.openwop-app.assistant.agents.chief-of-staff');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ADR 0856 D2 — a mission drafted in a project's conversation starts from the team ledger.
describe('IntentLedgerModal — the team-ledger pre-fill (ADR 0856 D2)', () => {
  it("pre-fills the goal and shows the team ledger's scope and the restrictions the mission keeps", async () => {
    api.getPrefill.mockResolvedValue({
      goal: 'Ship the EU launch',
      forbidden: ['openwop:email.send'],
      requireApproval: ['openwop:web.search'],
      sources: [{ kind: 'project', id: 'p1', name: 'Launch', inScope: ['EU markets'], outOfScope: ['US markets'] }],
    });
    renderModal();
    await waitFor(() => expect((screen.getByLabelText(/^goal/i) as HTMLInputElement).value).toBe('Ship the EU launch'));
    const region = screen.getByRole('region', { name: /from the team ledger/i });
    expect(region.textContent).toContain('Launch');
    expect(region.textContent).toContain('EU markets');
    expect(region.textContent).toContain('US markets');
    expect(region.textContent).toContain('openwop:email.send');
    expect(region.textContent).toContain('openwop:web.search');
  });

  it('shows nothing inherited outside a project conversation', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText(/create draft/i)).toBeTruthy());
    expect(api.getPrefill).toHaveBeenCalledWith('s1');
    expect(screen.queryByRole('region', { name: /from the team ledger/i })).toBeNull();
    expect((screen.getByLabelText(/^goal/i) as HTMLInputElement).value).toBe('');
    // "nothing inherited" is NOT a failed read: no could-not-load warning.
    expect(screen.queryByText(/could not load the team ledger/i)).toBeNull();
  });

  it('a FAILED pre-fill read says so instead of looking like "nothing inherited"', async () => {
    api.getPrefill.mockRejectedValue(new Error('network down'));
    renderModal();
    await waitFor(() => expect(screen.getAllByText(/could not load the team ledger/i).length).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: /from the team ledger/i })).toBeNull();
  });
});

// ADR 0896 D8 — approve what you saw, and only offer what the server will honour.
describe('IntentLedgerModal — the decision names the version shown (ADR 0896)', () => {
  const draft: IntentLedger = {
    ledgerId: 'il-1', tenantId: 't', conversationId: 's1', goal: 'Summarise the thread', allowed: [], forbidden: ['openwop:email.send'],
    requireApproval: [], successCriteria: [], expiresAtRelMs: 7_200_000, status: 'draft', proposedBy: 'extractor', revision: 4, digest: 'sha256:shown', createdAt: 'x',
  };

  it('Approve sends the ledger id, revision and contract digest it rendered', async () => {
    api.getLedger.mockResolvedValue({ ledger: draft, viewer: { mayEdit: true, mayDecide: true } });
    api.decideLedger.mockResolvedValue({ ...draft, status: 'approved', revision: 5 });
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(api.decideLedger).toHaveBeenCalledWith('s1', 'approve', expect.objectContaining({ ledgerId: 'il-1', revision: 4, digest: 'sha256:shown' })));
  });

  it('a mission that changed since it was shown: reload and say so, never a silent approve', async () => {
    api.getLedger
      .mockResolvedValueOnce({ ledger: draft, viewer: { mayEdit: true, mayDecide: true } })
      .mockResolvedValue({ ledger: { ...draft, forbidden: [], revision: 5 }, viewer: { mayEdit: true, mayDecide: true } });
    api.decideLedger.mockRejectedValue(new LedgerChangedError('changed'));
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(screen.getAllByText(/changed since you opened it/i).length).toBeGreaterThan(0));
    expect(api.getLedger).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('openwop:email.send')).toBeNull(); // the NEW version is what is shown
  });

  it('a viewer who cannot decide sees no Approve/Reject, and is told who decides', async () => {
    api.getLedger.mockResolvedValue({ ledger: draft, viewer: { mayEdit: false, mayDecide: false } });
    renderModal();
    await screen.findByText(/only the conversation’s owner/i);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reject/i })).toBeNull();
  });

  it('states what approving means: no allowed tools ⇒ talk only, and the time limit', async () => {
    api.getLedger.mockResolvedValue({ ledger: draft, viewer: { mayEdit: true, mayDecide: true } });
    renderModal();
    await screen.findByText(/can talk but not act/i);
    expect(screen.getByText(/2 hours/i)).toBeTruthy();
  });
});

describe('IntentLedgerModal — states (IL2UX-1)', () => {
  it('a conversation the server does not know yet: a translated, announced state and NO form claiming you are not the owner', async () => {
    api.getLedger.mockRejectedValue(new MissionNotFoundError('conversation "s1" not found.'));
    renderModal();
    await waitFor(() => expect(screen.getAllByText(/send a message first/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/conversation "s1" not found/)).toBeNull();
    expect(screen.queryByText(/only the conversation’s owner/i)).toBeNull();
    expect(screen.queryByText(/create draft/i)).toBeNull();
  });

  it('an empty goal is an inline, labelled field error — not a toast', async () => {
    renderModal();
    fireEvent.click(await screen.findByText(/create draft/i));
    const goal = screen.getByLabelText(/^goal/i);
    expect(goal.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/enter a goal/i);
    expect(api.draftLedger).not.toHaveBeenCalled();
  });
});
