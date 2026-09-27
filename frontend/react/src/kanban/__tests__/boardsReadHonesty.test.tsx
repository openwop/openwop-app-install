/**
 * UX_UPGRADE-boards P1 — a failed boards read must not invite a duplicate.
 *
 * UX-BRD-1: `refreshBoards()` set a real `error` (good), but left `boards` at
 * `[]` and `boardsLoading` false — so the render ALSO fell through to
 * "No boards yet" / "Create a board to start tracking work…" with a **New board**
 * CTA. A user who owns boards was told they own none and invited to make a
 * duplicate. An error notice beside a false claim is still a false claim.
 *
 * It also breaks the page header's own promise — "the bare `/boards` redirects
 * below so the page never greets with an empty shell" — precisely here, because
 * the redirect cannot fire without a board to redirect to.
 *
 * Both arms asserted: a failed read offers a retry, and a genuinely empty account
 * still gets the real create-your-first-board invitation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listBoardsWithCards: vi.fn(), getPersonalBoard: vi.fn(), listAssignedToMe: vi.fn(),
  subscribeBoardEvents: vi.fn(), getBoard: vi.fn(),
}));
vi.mock('../kanbanClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

const roster = vi.hoisted(() => ({ listRoster: vi.fn() }));
vi.mock('../../agents/rosterClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listRoster: roster.listRoster };
});

const workflows = vi.hoisted(() => ({ listWorkflowSummaries: vi.fn() }));
vi.mock('../../workflows/workflowsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, listWorkflowSummaries: workflows.listWorkflowSummaries };
});

import { KanbanPage } from '../KanbanPage.js';

function view(): void {
  render(<MemoryRouter initialEntries={['/boards']}><KanbanPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listBoardsWithCards.mockResolvedValue([]);
  api.getPersonalBoard.mockResolvedValue(null);
  api.listAssignedToMe.mockResolvedValue([]);
  api.subscribeBoardEvents.mockReturnValue(() => {});
  roster.listRoster.mockResolvedValue([]);
  workflows.listWorkflowSummaries.mockResolvedValue([]);
});
afterEach(cleanup);

describe('UX-BRD-1 — a failed boards read never says "No boards yet"', () => {
  it('FAILURE: offers a retry and does NOT invite creating a first board', async () => {
    api.listBoardsWithCards.mockRejectedValue(new Error('boards_500'));
    view();
    expect(await screen.findByText(/Couldn't load your boards/i)).toBeTruthy();
    // The claim that would make a user create a duplicate of a board they own.
    expect(screen.queryByText(/No boards yet/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('EMPTY: a genuinely empty account still gets the create invitation', async () => {
    // The other arm — without it, "always say unavailable" would pass the test
    // above while destroying real first-run onboarding.
    api.listBoardsWithCards.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No boards yet/i)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your boards/i)).toBeNull();
  });
});
