/**
 * M3 — the chair picker silently DELETED an out-of-cohort chair on any unrelated
 * edit.
 *
 * A board with `moderatorRosterId ∉ advisors` is a fully legal, server-supported
 * shape: `assertCohortSeats` explicitly budgets a seat for "a chair who is not
 * one of them", and ADR 0588 D5b's own 9-seat test arm depends on it. But the
 * option list was `roster.filter(m => picked.includes(m.rosterId))`, so such a
 * chair had no `<option>` and the select displayed "No chair" — a
 * MISREPRESENTATION of saved state — and every save then sent
 * `moderatorRosterId: null`, which `updateBoard` turns into
 * `delete next.moderatorRosterId`. Renaming the board destroyed its chair.
 *
 * Three arms: the option is offered and selected; an unrelated edit does not send
 * the field at all; and a deliberate change still does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listBoards = vi.fn();
const listOrgs = vi.fn();
const listRoster = vi.fn();
const updateBoard = vi.fn();

const { FeatureDisabledError } = vi.hoisted(() => {
  class FeatureDisabledError extends Error {}
  return { FeatureDisabledError };
});

vi.mock('../../strategy/strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  FeatureDisabledError,
  listStrategies: async () => { throw new FeatureDisabledError('off'); },
}));
vi.mock('../../projects/projectsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listProjects: async () => { throw new FeatureDisabledError('off'); },
}));
vi.mock('../advisoryBoardClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listBoards: () => listBoards(),
  listOrgs: () => listOrgs(),
  listRoster: () => listRoster(),
  getSharedKnowledge: vi.fn(async () => []),
  createBoard: vi.fn(async () => ({})),
  updateBoard: (id: string, patch: unknown) => updateBoard(id, patch),
  deleteBoard: vi.fn(async () => {}),
  ensureBoardChat: vi.fn(async () => ({ sessionId: 's' })),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { AdvisoryBoardPage } from '../AdvisoryBoardPage.js';

/** A board whose chair is NOT one of its advisors — the legal shape the picker
 *  could not represent. */
const BOARD = {
  boardId: 'b1', tenantId: 't', orgId: 'org-1', name: 'Founders', handle: 'founders',
  advisors: ['r-advisor'], moderatorRosterId: 'r-chair',
  visibility: 'private' as const, personaKind: 'historical' as const,
  createdBy: 'user:me', createdAt: '', updatedAt: '',
};

beforeEach(() => {
  for (const m of [listBoards, listOrgs, listRoster, updateBoard]) m.mockReset();
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listBoards.mockResolvedValue([BOARD]);
  listRoster.mockResolvedValue([
    { rosterId: 'r-advisor', persona: 'The Economist', agentId: 'a1' },
    { rosterId: 'r-chair', persona: 'The Registrar', agentId: 'a2' },
  ]);
  updateBoard.mockResolvedValue({});
});
afterEach(cleanup);

/** Open the EDIT dialog for the seeded board. */
async function openEdit(): Promise<HTMLSelectElement> {
  render(<MemoryRouter><AdvisoryBoardPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.click((await screen.findAllByRole('button', { name: /^edit$/i }))[0]!);
  await screen.findByRole('dialog');
  await act(async () => {});
  return screen.getByLabelText(/chair/i) as HTMLSelectElement;
}

const save = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(updateBoard).toHaveBeenCalled());
};

describe('M3 — an out-of-cohort chair survives an unrelated edit', () => {
  it('offers the current chair as an option and shows it as SELECTED', async () => {
    const select = await openEdit();
    // The misrepresentation half: this used to read '' → "No chair".
    expect(select.value, 'the picker must show the chair the board actually has').toBe('r-chair');
    // …and it is labelled as being outside the cohort, so the state is visible
    // rather than merely preserved.
    expect(screen.getByRole('option', { name: /not in this cohort/i })).toBeTruthy();
  });

  it('a RENAME does not send moderatorRosterId at all', async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText(/board name/i), { target: { value: 'War Council' } });
    await save();
    const patch = updateBoard.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch.name).toBe('War Council');
    // An OMITTED key is `updateBoard`'s "leave unchanged". Sending `null` here is
    // what deleted the chair; sending `'r-chair'` would work today but would also
    // re-assert a value the author never touched.
    expect('moderatorRosterId' in patch, 'an untouched chair must not be written at all').toBe(false);
  });

  it('but a deliberate change IS sent (the fix is not "never send it")', async () => {
    // Anti-rot. Without this arm, deleting the field unconditionally would pass
    // the arm above while removing the chair picker's entire purpose.
    const select = await openEdit();
    fireEvent.change(select, { target: { value: 'r-advisor' } });
    await save();
    expect((updateBoard.mock.calls[0]![1] as Record<string, unknown>).moderatorRosterId).toBe('r-advisor');
  });

  it('and clearing it deliberately still clears it', async () => {
    const select = await openEdit();
    fireEvent.change(select, { target: { value: '' } });
    await save();
    expect((updateBoard.mock.calls[0]![1] as Record<string, unknown>).moderatorRosterId).toBeNull();
  });
});
