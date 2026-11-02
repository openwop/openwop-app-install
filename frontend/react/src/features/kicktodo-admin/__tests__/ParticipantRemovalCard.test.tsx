/**
 * ADR 0910 D12 — "Remove from KickTodo" in the live Operator access panel.
 *
 * Pins: nothing is sent until a name and a 10-character trimmed reason are
 * given; the first call is a DRY RUN; the confirm dialog names the dry run's
 * match; the removal then targets the dry run's MEMBER ID, never the typed
 * text again; cancelling the dialog removes nobody; each host refusal has its
 * own copy and an unknown one falls back to the generic message.
 *
 * Sabotage (witnessed, recorded in the PR): skipping the dry run, removing by
 * the typed text instead of the member id, removing after a cancelled confirm,
 * an untrimmed reason check, and collapsing refusals into the generic message
 * each turn a case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../../client/requestJson.js';
import type { removeParticipant } from '../../../client/participantRemovalClient.js';

const state = {
  remove: vi.fn<typeof removeParticipant>(),
  confirm: vi.fn<(o: { title: string }) => Promise<boolean>>(),
};
vi.mock('../../../client/participantRemovalClient.js', () => ({
  removeParticipant: (ws: string, b: { member: string; reason: string; dryRun?: boolean }) => state.remove(ws, b),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: { title: string }) => state.confirm(o) }));

import { ParticipantRemovalCard } from '../ParticipantRemovalCard.js';

const REASON = '  Spam in three circles  ';
function fill(member = 'Pat Person', reason = REASON): void {
  fireEvent.change(screen.getByLabelText(/Who to remove/), { target: { value: member } });
  fireEvent.change(screen.getByLabelText(/Why are you removing them/), { target: { value: reason } });
}
const submit = () => screen.getByRole('button', { name: 'Remove from KickTodo' });
const refusal = (code: string, status = 403) =>
  new ApiError({ status, statusText: '', url: '', body: { error: 'forbidden', message: 'x', details: { code } }, message: 'x' });

beforeEach(() => {
  state.remove.mockImplementation(async (_ws, b) => ({ memberId: 'mbr-1', displayName: 'Pat Person', removed: b.dryRun !== true }));
  state.confirm.mockImplementation(async () => true);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ParticipantRemovalCard (ADR 0910 D12)', () => {
  it('needs a name and a trimmed reason of at least 10 characters', () => {
    render(<ParticipantRemovalCard workspaceId="host-kicktodo" />);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fill('Pat Person', '   short     ');
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fill();
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it('dry-runs, confirms by name, then removes by the dry run member id with the trimmed reason', async () => {
    render(<ParticipantRemovalCard workspaceId="host-kicktodo" />);
    fill();
    fireEvent.click(submit());
    await screen.findByText('Removed Pat Person from KickTodo.');
    expect(state.remove.mock.calls).toEqual([
      ['host-kicktodo', { member: 'Pat Person', reason: 'Spam in three circles', dryRun: true }],
      ['host-kicktodo', { member: 'mbr-1', reason: 'Spam in three circles' }],
    ]);
    expect(state.confirm.mock.calls[0]![0].title).toBe('Remove “Pat Person” from KickTodo?');
  });

  it('a cancelled confirm removes nobody', async () => {
    state.confirm.mockImplementation(async () => false);
    render(<ParticipantRemovalCard workspaceId="host-kicktodo" />);
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(state.confirm).toHaveBeenCalled());
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
    expect(state.remove).toHaveBeenCalledTimes(1);
    expect(state.remove.mock.calls[0]![1].dryRun).toBe(true);
  });

  it.each([
    ['cannot_remove_superadmin', 'Another operator of this site can\'t be removed here.'],
    ['not_a_participant', 'That person has more than participant access. Manage them under Access.'],
    ['ambiguous', 'More than one person matches. Use their member id instead.'],
    ['operator_activation_required', 'Removing someone needs live operator access, and yours isn\'t active.'],
    ['something_new', 'The participant could not be removed. Try again.'],
  ])('refusal %s has its own copy', async (code, copy) => {
    state.remove.mockImplementation(async () => { throw refusal(code); });
    render(<ParticipantRemovalCard workspaceId="host-kicktodo" />);
    fill();
    fireEvent.click(submit());
    expect((await screen.findAllByText(copy)).length).toBeGreaterThan(0);
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it('a 404 says nobody matches', async () => {
    state.remove.mockImplementation(async () => { throw refusal('', 404); });
    render(<ParticipantRemovalCard workspaceId="host-kicktodo" />);
    fill();
    fireEvent.click(submit());
    expect((await screen.findAllByText('Nobody in KickTodo matches that.')).length).toBeGreaterThan(0);
  });
});
