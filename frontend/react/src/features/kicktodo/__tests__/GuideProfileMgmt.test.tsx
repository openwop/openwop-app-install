/**
 * §5.8 in-surface profile management (SCREEN_POLISH Guide residue) — the
 * memories review/delete section and rename-without-losing-continuity, both
 * riding the EXISTING lanes (agent-knowledge curated notes + roster label
 * patch; reuse-never-recreate). Pins: notes render verbatim with a CONFIRMED
 * per-row delete (a cancelled confirm deletes nothing); rename patches ONLY the
 * label; an unavailable notes lane hides the section instead of fabricating an
 * empty state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RosterEntry } from '../../../agents/rosterClient.js';
import type { TodayView } from '../../../client/kicktodoClient.js';
import type { MemoryNote } from '../../agent-knowledge/agentKnowledgeClient.js';

const fx = vi.hoisted(() => {
  const roster = (label: string): RosterEntry => ({
    rosterId: 'host:kickbot', persona: 'KickBot', label, agentRef: { agentId: 'kickbot' },
    workflows: [], tenantId: 't1', enabled: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  });
  const note: MemoryNote = { id: 'n1', content: 'Prefers morning reading blocks', contentTrust: 'trusted', createdAt: '2026-07-20T08:00:00Z' };
  const today: TodayView = { dateLocal: '2026-09-20', enrollments: [] };
  return { roster, note, today };
});

vi.mock('../../../auth/useAuth.js', () => ({
  useAuth: () => ({ user: { uid: 'u1' }, isConfigured: true, loading: false }),
}));
vi.mock('../../../client/kicktodoClient.js', () => ({
  getToday: vi.fn(() => Promise.resolve(fx.today)),
  listEnrollments: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../client/kicktodoCirclesClient.js', () => ({
  listProposals: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../../agents/rosterClient.js', () => ({
  getRosterEntry: vi.fn(() => Promise.resolve(fx.roster('Ember'))),
  updateRosterEntry: vi.fn(() => Promise.resolve(fx.roster('North'))),
}));
vi.mock('../../agent-knowledge/agentKnowledgeClient.js', () => ({
  listNotes: vi.fn(() => Promise.resolve([fx.note])),
  deleteNote: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../chat/EmbeddedChatPanel.js', () => ({
  EmbeddedChatPanel: () => <div data-testid="embedded-chat" />,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(() => Promise.resolve(true)) }));

import { GuidePage } from '../GuidePage.js';
import { listNotes, deleteNote } from '../../agent-knowledge/agentKnowledgeClient.js';
import { updateRosterEntry } from '../../../agents/rosterClient.js';
import { confirm } from '../../../ui/confirm.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const renderPage = () => render(<MemoryRouter><GuidePage /></MemoryRouter>);
const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('GuidePage §5.8 profile management', () => {
  it('renders the guide’s memories verbatim and deletes one after confirm', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Prefers morning reading blocks'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(vi.mocked(deleteNote)).toHaveBeenCalledWith('host:kickbot', 'n1'));
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    await waitFor(() => expect(screen.queryByText('Prefers morning reading blocks')).toBeNull());
  });

  it('a cancelled confirm deletes nothing and keeps the memory', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    renderPage();
    await waitFor(() => screen.getByText('Prefers morning reading blocks'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1));
    await drain();
    expect(vi.mocked(deleteNote)).not.toHaveBeenCalled();
    expect(screen.getByText('Prefers morning reading blocks')).toBeTruthy();
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
    // `notes` starts as null — the same value as "failed" — so wait for the
    // rejection to be delivered before asserting the absence.
    await waitFor(() => expect(vi.mocked(listNotes)).toHaveBeenCalledWith('host:kickbot'));
    await drain();
    expect(screen.queryByText('What your guide remembers')).toBeNull();
  });
});
