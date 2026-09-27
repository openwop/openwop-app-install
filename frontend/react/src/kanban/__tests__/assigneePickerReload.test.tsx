/**
 * CLNP-2(d) / grade-ux F1+F4 — the assignee picker re-reads members on every open,
 * so a failed RE-read must not wipe a list that loaded fine (the card would fall
 * back to the raw subject id and never recover), must SAY it failed rather than look
 * like an empty workspace, and the select is disabled while a read is in flight.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const loadOrgMembers = vi.hoisted(() => vi.fn());
vi.mock('../../orgs/orgMembers.js', () => ({ loadOrgMembers }));
vi.mock('../kanbanClient.js', () => ({ assignCard: vi.fn() }));

import { AssigneeControl } from '../AssigneeControl.js';

const ADA = { memberId: 'm1', subject: 'user:ada', displayName: 'Ada Lovelace', roles: [] };
afterEach(() => { cleanup(); loadOrgMembers.mockReset(); });

describe('assignee picker — reopen failure', () => {
  it('keeps the previous list, keeps the NAME on the card, and states the failure', async () => {
    loadOrgMembers.mockResolvedValue([ADA]);
    render(<AssigneeControl cardId="c1" assigneeId="user:ada" />);
    await screen.findByRole('button', { name: /Ada Lovelace/ });

    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /close assignee picker/i }));

    loadOrgMembers.mockRejectedValue(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
    await screen.findByRole('option', { name: /couldn't load members/i });
    expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toBeTruthy(); // not wiped
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /close assignee picker/i }));
    expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toBeTruthy(); // never the raw id
  });

  it('the select is disabled while a read is in flight', async () => {
    loadOrgMembers.mockReturnValue(new Promise(() => { /* never settles */ }));
    render(<AssigneeControl cardId="c1" assigneeId={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  });
});
