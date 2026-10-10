/**
 * ADR 0846 grade-ux — the agenda merges two sources and tolerates ONE failing (a
 * toggled-off feature). Both failing used to render "Nothing coming up", a failed
 * read presented as an empty agenda.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listScheduledChats = vi.fn();
vi.mock('../../../client/scheduledChatsClient.js', () => ({ listScheduledChats: (...a: unknown[]) => listScheduledChats(...a) }));
const listAssignedToMe = vi.fn();
vi.mock('../../../kanban/kanbanClient.js', () => ({ listAssignedToMe: () => listAssignedToMe() }));
vi.mock('../useDashboardOrg.js', () => ({ useDashboardOrg: () => ({ orgId: 'o1', loading: false, error: false }) }));

import UpcomingAgendaTile from '../tiles/UpcomingAgendaTile.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = () => render(<MemoryRouter><UpcomingAgendaTile compact={false} /></MemoryRouter>);

describe('upcoming agenda — failed reads', () => {
  it('both sources failing is the error state, not "nothing coming up"', async () => {
    listScheduledChats.mockRejectedValue(new Error('boom'));
    listAssignedToMe.mockRejectedValue(new Error('boom'));
    mount();
    await screen.findByText(/could not load/i);
    expect(screen.queryByText(/nothing coming up/i)).toBeNull();
  });

  it('CONTROL: one source failing still shows the other', async () => {
    listScheduledChats.mockRejectedValue(new Error('toggle off'));
    listAssignedToMe.mockResolvedValue([{ id: 'c1', title: 'Ship it', dueAt: '2026-10-08T09:00:00.000Z', terminal: false, boardName: 'B' }]);
    mount();
    await screen.findByText('Ship it');
  });
});
