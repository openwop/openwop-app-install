/**
 * ADR 1138 D1/D2 — a card links back to where its work happens, and the mirror
 * knows where Done sends it.
 *
 * Red if a `sourceRef` that leaves the app (a scheme, `//host`, a backslash) is
 * accepted on create or patch, a valid one is dropped, `null` fails to clear it,
 * or the mirror's `doneColumnId` goes missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBoard, createCard, getBoard, getCard, listCardsAssignedToUser, moveCard, refreshCardFacts, updateCardFields } from '../src/host/kanbanService.js';

let store: Storage;
beforeAll(async () => {
  store = await openStorage('memory://');
  initHostExtPersistence(store);
});
afterAll(async () => {
  __resetHostExtPersistence();
  await store.close();
});

describe('ADR 1138 D1 — sourceRef stays inside the app', () => {
  it('keeps a valid app path, clears on null, and refuses anything that leaves the app', async () => {
    const board = await createBoard({ tenantId: 't-ref', name: 'Refs' });
    const card = await createCard({
      boardId: board.id, columnId: 'todo', title: 'Pick tile',
      sourceRef: { label: 'Selections', path: '/projects/p1?tab=selections' },
    });
    expect((await getCard(card.id))?.sourceRef).toEqual({ label: 'Selections', path: '/projects/p1?tab=selections' });

    for (const path of ['https://evil.test/x', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', 'projects/p1', '/a b']) {
      await expect(createCard({ boardId: board.id, columnId: 'todo', title: 'x', sourceRef: { label: 'L', path } }))
        .rejects.toThrow(/source link/);
      await expect(updateCardFields(card.id, { sourceRef: { label: 'L', path } })).rejects.toThrow(/source link/);
    }
    await expect(updateCardFields(card.id, { sourceRef: { label: '', path: '/ok' } })).rejects.toThrow(/source link/);

    await updateCardFields(card.id, { sourceRef: null });
    expect((await getCard(card.id))?.sourceRef).toBeUndefined();
  });
});

describe('ADR 1138 D2 — the mirror carries the completion lane', () => {
  it('names the board completion lane', async () => {
    const board = await createBoard({ tenantId: 't-ref', name: 'Default lanes' });
    await createCard({ boardId: board.id, columnId: 'todo', title: 'Mine', assigneeId: 'user:me' });
    const [mine] = (await listCardsAssignedToUser('t-ref', 'user:me')).filter((c) => c.boardId === board.id);
    expect(mine?.doneColumnId).toBe('done');
  });
});

describe('ADR 1137 D3 — refreshCardFacts, the shared rule for plain cards', () => {
  it('updates source-owned facts only, skips a finished card, and writes nothing when unchanged', async () => {
    const board = (await getBoard((await createBoard({ tenantId: 't-ref', name: 'Facts' })).id))!;
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Old', dueAt: '2026-12-01', assigneeId: 'user:me', labels: ['mine'] });
    await moveCard(card.id, 'doing');
    const fresh = (await getCard(card.id))!;
    const r = await refreshCardFacts(board, fresh, { title: 'New', dueAt: '2026-12-09', sourceLabel: 'Selections' });
    expect(r.refreshed).toBe(true);
    expect(r.card).toMatchObject({ title: 'New', dueAt: '2026-12-09', sourceLabel: 'Selections', columnId: 'doing', assigneeId: 'user:me', labels: ['mine'] });
    expect((await refreshCardFacts(board, r.card, { title: 'New', dueAt: '2026-12-09', sourceLabel: 'Selections' })).refreshed).toBe(false);
    await moveCard(card.id, 'done');
    const finished = (await getCard(card.id))!;
    expect((await refreshCardFacts(board, finished, { title: 'Renamed' })).refreshed).toBe(false);
    expect((await getCard(card.id))?.title).toBe('New');
  });
});
