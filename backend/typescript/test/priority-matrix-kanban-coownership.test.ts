/**
 * ADR 0667 D5 (PMXWF-10) — kanban's own delete doors are CO-OWNERS of priority-matrix
 * state, because an idea IS a card (ADR 0058, "no parallel board").
 *
 * Born red: deleting a card through `deleteCard` left every PM overlay behind and left
 * the deleted idea's KB doc serving; `boardDeleteClaim` did not exist.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { deleteCard, deleteBoard, boardDeleteClaim, getCard } from '../src/host/kanbanService.js';
import {
  createList, submitIdea, setIdeaScore, deleteIdea, listRankedIdeas,
  registerPriorityMatrixKanbanHooks, getList,
} from '../src/features/priority-matrix/priorityMatrixService.js';

const T = 'tCoOwn';
interface ScoreRow { listId: string; cardId: string }
const scoreRows = new DurableCollection<ScoreRow>('priority-matrix:score', (s) => `${s.listId}::${s.cardId}`);

let listId = '';
let boardId = '';
let cardId = '';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerPriorityMatrixKanbanHooks();
  const list = await createList(T, 'org-1', 'u1', { name: 'Bets', presetId: 'weighted' });
  listId = list.id;
  boardId = list.boardId;
  const idea = await submitIdea(T, listId, 'u1', { title: 'An idea' });
  cardId = idea.id;
  await setIdeaScore(T, listId, cardId, 'u1', { 'strategic-alignment': 8, roi: 7, urgency: 6, 'compliance-risk': 5, cost: 4 });
});

describe('ADR 0667 D5(a) — a kanban-side card delete runs PM\'s cascade', () => {
  it('leg 1: the score overlay is gone after deleting through KANBAN\'s door', async () => {
    expect(await scoreRows.get(`${listId}::${cardId}`), 'precondition: the overlay exists').toBeTruthy();
    await deleteCard(cardId);
    expect(await getCard(cardId), 'the card itself is gone').toBeFalsy();
    expect(await scoreRows.get(`${listId}::${cardId}`), 'and so is the overlay it stranded before').toBeFalsy();
  });

  it('leg 2: the hook is IDEMPOTENT and does not recurse — PM\'s own deleteIdea still works', async () => {
    // deleteIdea calls deleteCard, which now runs the hook, which must NOT call
    // deleteIdea back (three of deleteCard's five callers are PM's own).
    const ok = await deleteIdea(T, listId, cardId, 'u1');
    expect(ok).toBe(true);
    expect(await scoreRows.get(`${listId}::${cardId}`)).toBeFalsy();
    // Running the door again is harmless.
    await deleteCard(cardId);
    expect(await listRankedIdeas(T, listId)).toEqual([]);
  });

  it('leg 3: a card on a board NO priority list owns is a clean no-op', async () => {
    const { createBoard, createCard } = await import('../src/host/kanbanService.js');
    const foreign = await createBoard({ tenantId: T, name: 'Plain board', createdBy: 'u1' } as never);
    const c = await createCard({ boardId: (foreign as { id: string }).id, title: 'Not an idea', createdBy: 'u1' } as never);
    await expect(deleteCard((c as { id: string }).id)).resolves.toBe(true);
  });
});

describe('ADR 0667 D5(b) — the board claim protects the list, without bricking teardown', () => {
  it('leg 4: a board backing a priority list is CLAIMED (the route refuses on this)', async () => {
    const claim = await boardDeleteClaim(boardId);
    expect(claim?.feature).toBe('priority-matrix');
    expect(claim?.ownerLabel).toBe('Bets');
  });

  it('leg 5: the SERVICE-level deleteBoard is NOT refusable — teardown and PM\'s own list delete depend on it', async () => {
    // The guard lives at the route only. If it were inside `deleteBoard`, tenant
    // teardown (purgeTenantKanban), the roster cascade, projects and PM's own
    // `deleteList` would all be unable to complete — a gate with no exit.
    await expect(deleteBoard(boardId)).resolves.toBe(true);
  });

  it('leg 6: a board nothing claims is not falsely claimed', async () => {
    const { createBoard } = await import('../src/host/kanbanService.js');
    const foreign = await createBoard({ tenantId: T, name: 'Plain board', createdBy: 'u1' } as never);
    expect(await boardDeleteClaim((foreign as { id: string }).id)).toBeNull();
  });

  it('leg 7: PM\'s own list delete still works end to end (the claim never blocks the owner)', async () => {
    const { deleteList } = await import('../src/features/priority-matrix/priorityMatrixService.js');
    await expect(deleteList(T, listId, 'u1')).resolves.not.toThrow();
    expect(await getList(T, listId)).toBeNull();
  });
});
