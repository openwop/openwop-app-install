/**
 * ADR 0667 D5 (PMXWF-10) — kanban's own delete doors are CO-OWNERS of priority-matrix
 * state, because an idea IS a card (ADR 0058, "no parallel board").
 *
 * Born red: deleting a card through `deleteCard` left every PM overlay behind and left
 * the deleted idea's KB doc serving; `boardDeleteClaim` did not exist.
 *
 * What turns it red (w15 probes): unregistering the PM card-delete hook or dropping its
 * score sweep (leg 1); `deleteIdea` skipping `deleteCard` (leg 2); the board claim
 * returning null (leg 4) or claiming every board (leg 6); `deleteBoard` refusing a
 * claimed board (legs 5 and 7).
 *
 * (A former "leg 3 — a card on an unowned board is a clean no-op" was cut in /grade-tests
 * w15: `deleteCard` swallows every hook error, so even a PM hook that THROWS on a foreign
 * board leaves it green — probe w15g2-kc-leg3-throw. Nothing PM-side could fail it; leg 6
 * carries the "an unowned board is not claimed" half.)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { deleteCard, deleteBoard, boardDeleteClaim, getCard, getBoard, createBoard } from '../src/host/kanbanService.js';
import {
  createList, submitIdea, setIdeaScore, deleteIdea, deleteList, listRankedIdeas,
  registerPriorityMatrixKanbanHooks, getList, __pmStoresForErasure,
} from '../src/features/priority-matrix/priorityMatrixService.js';

const T = 'tCoOwn';
const scoreRow = (listId: string, cardId: string) => __pmStoresForErasure().scores.get(`${listId}::${cardId}`);

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
    expect(await scoreRow(listId, cardId), 'precondition: the overlay exists').toBeTruthy();
    await deleteCard(cardId);
    expect(await getCard(cardId), 'the card itself is gone').toBeFalsy();
    expect(await scoreRow(listId, cardId), 'and so is the overlay it stranded before').toBeFalsy();
  });

  it('leg 2: the hook is IDEMPOTENT and does not recurse — PM\'s own deleteIdea still works', async () => {
    // deleteIdea calls deleteCard, which now runs the hook, which must NOT call
    // deleteIdea back (three of deleteCard's five callers are PM's own).
    const ok = await deleteIdea(T, listId, cardId, 'u1');
    expect(ok).toBe(true);
    // Asserted BEFORE running the door again — a second deleteCard would otherwise
    // delete a card deleteIdea had left behind and hide it (w15 probe kc-leg2-delcard).
    expect(await getCard(cardId), 'deleteIdea removed the card').toBeFalsy();
    expect(await scoreRow(listId, cardId)).toBeFalsy();
    expect(await listRankedIdeas(T, listId)).toEqual([]);
    // Running the door again is harmless: nothing left to delete.
    await expect(deleteCard(cardId)).resolves.toBe(false);
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
    expect(await getBoard(boardId), 'the claimed board really is gone').toBeNull();
  });

  it('leg 6: a board nothing claims is not falsely claimed', async () => {
    const foreign = await createBoard({ tenantId: T, name: 'Plain board' });
    expect(await boardDeleteClaim(foreign.id)).toBeNull();
  });

  it('leg 7: PM\'s own list delete still works end to end (the claim never blocks the owner)', async () => {
    await expect(deleteList(T, listId, 'u1')).resolves.toBe(true);
    expect(await getList(T, listId)).toBeNull();
  });
});
