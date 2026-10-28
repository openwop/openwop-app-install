/**
 * ADR 0944 P4 — the Client memory panel.
 *
 *   - notes, suggestions waiting for review (marked unverified) and the agents'
 *     summaries are listed; "Ask the team" opens the chat bound to this client;
 *   - approving a suggestion calls the decide route for THIS client;
 *   - a failed read is said, with a retry, never shown as an empty memory;
 *   - only an agency admin is offered the erase, which needs the client's name.
 *
 * Break it by rendering the failed state as the empty lists (third case), or by
 * showing the erase button without `agencyAdmin` (fourth case).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';

const h = vi.hoisted(() => ({
  listClientNotes: vi.fn(), listClientNoteProposals: vi.fn(), listClientRecall: vi.fn(), getClientMemorySources: vi.fn(),
  addClientNote: vi.fn(), removeClientNote: vi.fn(), decideClientNoteProposal: vi.fn(), setClientMemorySources: vi.fn(), purgeClientMemory: vi.fn(),
}));
vi.mock('../campaignOpsClient.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), ...h }));

import { ClientMemoryPanel } from '../ClientMemoryPanel.js';

const renderPanel = (agencyAdmin = false) => render(
  <MemoryRouter><ClientMemoryPanel orgId="o1" clientName="Acme" agencyAdmin={agencyAdmin} onStatus={() => {}} /></MemoryRouter>,
);

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.listClientNotes.mockResolvedValue([{ id: 'n1', content: 'Never mention Rival', contentTrust: 'trusted', createdAt: '' }]);
  h.listClientNoteProposals.mockResolvedValue([{ proposalId: 'p1', content: 'Launches on Tuesdays', rationale: 'Seen in three briefs', status: 'pending', createdAt: '' }]);
  h.listClientRecall.mockResolvedValue([{ id: 'm1', content: 'Drafted the hero line', contentTrust: 'untrusted', createdAt: '', expiresAt: '2027-04-18T00:00:00.000Z' }]);
  h.getClientMemorySources.mockResolvedValue({ collectionIds: [], available: [{ collectionId: 'k1', name: 'Brand book' }] });
  h.decideClientNoteProposal.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ClientMemoryPanel', () => {
  it('switching clients clears the draft and ignores the previous client’s late success', async () => {
    let finish!: () => void;
    const status = vi.fn();
    h.addClientNote.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    h.listClientNotes.mockImplementation(async (orgId: string) => [{ id: orgId, content: orgId === 'o1' ? 'Client A private note' : 'Client B note', contentTrust: 'trusted', createdAt: '' }]);
    const page = render(<MemoryRouter><ClientMemoryPanel orgId="o1" clientName="Acme" agencyAdmin={false} onStatus={status} /></MemoryRouter>);
    const draft = await screen.findByLabelText(t('campaign-ops:memoryAddLabel'));
    fireEvent.change(draft, { target: { value: 'Private draft for A' } });
    fireEvent.click(screen.getByRole('button', { name: t('campaign-ops:memoryAdd') }));
    page.rerender(<MemoryRouter><ClientMemoryPanel orgId="o2" clientName="Beta" agencyAdmin={false} onStatus={status} /></MemoryRouter>);
    expect(await screen.findByText('Client B note')).toBeTruthy();
    expect((screen.getByLabelText(t('campaign-ops:memoryAddLabel')) as HTMLTextAreaElement).value).toBe('');
    await act(async () => { finish(); });
    expect(status).not.toHaveBeenCalled();
    expect(screen.queryByText('Client A private note')).toBeNull();
    expect(h.addClientNote).toHaveBeenCalledWith('o1', 'Private draft for A');
  });

  it('a partial purge refreshes the confirmed rows while keeping its failure visible', async () => {
    h.listClientNotes.mockResolvedValueOnce([{ id: 'n1', content: 'Purged note', contentTrust: 'trusted', createdAt: '' }]).mockResolvedValue([]);
    h.purgeClientMemory.mockResolvedValue({ complete: false });
    const status = vi.fn();
    render(<MemoryRouter><ClientMemoryPanel orgId="o1" clientName="Acme" agencyAdmin onStatus={status} /></MemoryRouter>);
    await screen.findByText('Purged note');
    fireEvent.click(screen.getByRole('button', { name: t('campaign-ops:memoryErase') }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Acme' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('campaign-ops:memoryErase') }));
    await screen.findAllByText(t('campaign-ops:memoryErasePartial'));
    await waitFor(() => expect(screen.queryByText('Purged note')).toBeNull());
    expect(status).not.toHaveBeenCalled();
    expect(h.purgeClientMemory).toHaveBeenCalledWith('o1');
  });
  it('lists notes, suggestions and summaries, and links to the chat for this client', async () => {
    renderPanel();
    expect(await screen.findByText('Never mention Rival')).toBeTruthy();
    expect(screen.getByText('Launches on Tuesdays')).toBeTruthy();
    expect(screen.getByText('Drafted the hero line')).toBeTruthy();
    expect(screen.getAllByText('Unverified').length).toBe(2);
    expect(screen.getByRole('link', { name: 'Ask the team' }).getAttribute('href')).toBe('/chat?client=o1');
    expect(screen.getByLabelText('Brand book')).toBeTruthy();
  });

  it('approving a suggestion decides it for this client', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve suggestion: Launches on Tuesdays' }));
    await waitFor(() => expect(h.decideClientNoteProposal).toHaveBeenCalledWith('o1', 'p1', 'approve'));
  });

  it('a failed read is a failure with a retry, not an empty memory', async () => {
    h.listClientNotes.mockRejectedValue(new Error('boom'));
    renderPanel();
    expect(await screen.findByText('Couldn’t load the client memory')).toBeTruthy();
    expect(screen.queryByText(/No notes yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('only an agency admin is offered the erase', async () => {
    renderPanel(false);
    await screen.findByText('Never mention Rival');
    expect(screen.queryByRole('button', { name: 'Erase client memory' })).toBeNull();
    cleanup();
    renderPanel(true);
    expect(await screen.findByRole('button', { name: 'Erase client memory' })).toBeTruthy();
  });
});
