/**
 * §5.8 in-surface profile management (SCREEN_POLISH Guide residue) — the
 * memories review/delete section and rename-without-losing-continuity, both
 * riding the EXISTING lanes (agent-knowledge curated notes + roster label
 * patch; reuse-never-recreate). Pins: notes render verbatim with confirmed
 * per-row delete; rename patches ONLY the label; an unavailable notes lane
 * hides the section instead of fabricating an empty state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, isConfigured: true, loading: false }),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  getToday: vi.fn(() => Promise.resolve({ enrollments: [] })),
  listEnrollments: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listProposals: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../agents/rosterClient.js', () => ({
  getRosterEntry: vi.fn(() => Promise.resolve({ label: 'Ember', persona: 'KickBot' })),
  updateRosterEntry: vi.fn(() => Promise.resolve({ label: 'North', persona: 'KickBot' })),
}));
vi.mock('../../agent-knowledge/agentKnowledgeClient.js', () => ({
  listNotes: vi.fn(() => Promise.resolve([
    { id: 'n1', content: 'Prefers morning reading blocks', contentTrust: 'trusted', createdAt: '2026-07-20T08:00:00Z' },
  ])),
  deleteNote: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: () => <div data-testid="embedded-chat" />,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

import { GuidePage } from '../GuidePage.js';
import { listNotes, deleteNote } from '../../agent-knowledge/agentKnowledgeClient.js';
import { updateRosterEntry } from '../../../agents/rosterClient.js';

afterEach(cleanup);

const renderPage = () => render(<MemoryRouter><GuidePage /></MemoryRouter>);

describe('GuidePage §5.8 profile management', () => {
  it('renders the guide’s memories verbatim and deletes one after confirm', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Prefers morning reading blocks'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(vi.mocked(deleteNote)).toHaveBeenCalledWith('host:kickbot', 'n1'));
    await waitFor(() => expect(screen.queryByText('Prefers morning reading blocks')).toBeNull());
  });

  it('rename patches ONLY the label and the serif name follows', async () => {
    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename your guide' }));
    const input = screen.getByLabelText(/New name/);
    fireEvent.change(input, { target: { value: 'North' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(vi.mocked(updateRosterEntry)).toHaveBeenCalledWith('host:kickbot', { label: 'North' }));
    await waitFor(() => screen.getByRole('heading', { name: 'North' }));
  });

  it('an unavailable notes lane hides the section — never a fabricated empty', async () => {
    vi.mocked(listNotes).mockRejectedValueOnce(new Error('403'));
    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Ember' }));
    expect(screen.queryByText('What your guide remembers')).toBeNull();
  });
});
