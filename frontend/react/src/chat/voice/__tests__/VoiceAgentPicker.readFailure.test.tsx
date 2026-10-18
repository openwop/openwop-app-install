/**
 * EMPTY-ON-FAIL-3 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed roster read is NOT
 * "No agents yet".
 *
 * The roster catch set the list to [], so with no boards (the common case) the
 * picker said "No agents yet — Create an agent to give voice conversations a role…"
 * from a read that never came back, inviting the user to create an agent they may
 * already have. The failure is now its own state, with a Retry; the workspace
 * assistant stays available beside it.
 *
 * Break it by dropping the `rosterError !== null ? null :` guard in front of the
 * "No agents yet" card in VoiceAgentPicker (or by removing `setRosterError` from the
 * roster catch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RosterEntry } from '../../../agents/rosterClient.js';
import type { AdvisoryBoard } from '../../../features/advisory-board/advisoryBoardClient.js';

const listRoster = vi.fn<() => Promise<RosterEntry[]>>();
const listBoards = vi.fn<() => Promise<AdvisoryBoard[]>>();
vi.mock('../../../agents/rosterClient.js', () => ({ listRoster: () => listRoster() }));
vi.mock('../../../features/advisory-board/advisoryBoardClient.js', () => ({ listBoards: () => listBoards() }));

const { VoiceAgentPicker } = await import('../VoiceAgentPicker.js');

const FAILED = 'Couldn’t load agents: roster_500.';
const EMPTY_TITLE = 'No agents yet';
const EMPTY_BODY = 'Create an agent to give voice conversations a role, memories, and tools — or continue with the workspace assistant.';

function view(): void {
  render(<VoiceAgentPicker onPick={() => undefined} onClose={() => undefined} />);
}

beforeEach(() => {
  listRoster.mockReset();
  listBoards.mockReset();
  listBoards.mockResolvedValue([]);
});
afterEach(cleanup);

describe('EMPTY-ON-FAIL-3 — a failed roster read is not "No agents yet"', () => {
  it('a rejected roster read shows the failure, and NOT "No agents yet"', async () => {
    listRoster.mockRejectedValue(new Error('roster_500'));
    view();
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(EMPTY_BODY)).toBeNull();
    // The generic assistant is still offered — the failure does not strand the user.
    expect(screen.getByRole('button', { name: 'Use the workspace assistant' })).toBeTruthy();
  });

  it('Retry re-reads, and a successful empty roster then says "No agents yet"', async () => {
    listRoster.mockRejectedValueOnce(new Error('roster_500')).mockResolvedValue([]);
    view();
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it('a successful empty roster still says "No agents yet" (positive control)', async () => {
    listRoster.mockResolvedValue([]);
    view();
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText(EMPTY_BODY)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});
