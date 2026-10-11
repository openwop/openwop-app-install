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
 *
 * Tracked as M3 in ADR 0588 (board-of-advisors assessment remediation).
 * Sabotage-witnessed (/grade-tests w12): dropping the out-of-cohort option or its label
 * reds arm 1; sending the field unconditionally reds the rename arm; `chairChanged = false`
 * reds the change + clear arms; `chair || undefined` reds the clear arm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { AdvisoryBoard, OrgRef, RosterMember } from '../advisoryBoardClient.js';

const listBoards = vi.fn<() => Promise<AdvisoryBoard[]>>();
const listOrgs = vi.fn<() => Promise<OrgRef[]>>();
const listRoster = vi.fn<() => Promise<RosterMember[]>>();
const updateBoard = vi.fn<(id: string, patch: Record<string, unknown>) => Promise<Partial<AdvisoryBoard>>>();

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
  updateBoard: (id: string, patch: Record<string, unknown>) => updateBoard(id, patch),
  deleteBoard: vi.fn(async () => {}),
  ensureBoardChat: vi.fn(async () => ({ sessionId: 's' })),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { AdvisoryBoardPage } from '../AdvisoryBoardPage.js';

/** A board whose chair is NOT one of its advisors — the legal shape the picker
 *  could not represent. */
const BOARD: AdvisoryBoard = {
  boardId: 'b1', tenantId: 't', orgId: 'org-1', name: 'Founders', handle: 'founders',
  advisors: ['r-advisor'], moderatorRosterId: 'r-chair',
  visibility: 'private', personaKind: 'historical',
  turnPolicy: { rounds: 1, order: 'declared', synthesize: true },
  createdBy: 'user:me', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', disclaimer: null,
};

beforeEach(() => {
  for (const m of [listBoards, listOrgs, listRoster, updateBoard]) m.mockReset();
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listBoards.mockResolvedValue([BOARD]);
  listRoster.mockResolvedValue([
    { rosterId: 'r-advisor', persona: 'The Economist' },
    { rosterId: 'r-chair', persona: 'The Registrar' },
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
    const patch = updateBoard.mock.calls[0]![1];
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
    expect(updateBoard.mock.calls[0]![1].moderatorRosterId).toBe('r-advisor');
  });

  it('and clearing it deliberately still clears it', async () => {
    const select = await openEdit();
    fireEvent.change(select, { target: { value: '' } });
    await save();
    expect(updateBoard.mock.calls[0]![1].moderatorRosterId).toBeNull();
  });
});
