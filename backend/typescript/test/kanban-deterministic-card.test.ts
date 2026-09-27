/**
 * ADR 0414 M3-1 (KickTodo B1) — pin the deterministic-`cardId` semantics the
 * KickTodo occurrence-materialization saga depends on (ADR 0311 create path +
 * grade-pass fix GC-0311-1, `kanbanService.ts` createCard):
 *
 *   1. same-board re-create with the same `cardId` is IDEMPOTENT — returns the
 *      existing card (fields untouched), never a duplicate;
 *   2. a `cardId` that exists on a DIFFERENT board FAILS CLOSED — never a
 *      silent overwrite of the other board's card.
 *
 * These existed un-pinned; a regression would let a re-fired materialization
 * duplicate daily actions or clobber a foreign board's card.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBoard, createCard, getCard } from '../src/host/kanbanService.js';

describe('deterministic cardId create (ADR 0311 / GC-0311-1)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => {
    initHostExtPersistence(storage);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });

  const DET_ID = 'kicktodo:enr-1:2026-07-18:act-1:rev1';

  it('same-board re-create with the same cardId returns the EXISTING card untouched', async () => {
    const board = await createBoard({ tenantId: 't-det', name: 'Participant actions' });
    const col = board.columns[0].id;
    const first = await createCard({ boardId: board.id, columnId: col, title: 'Day 1 action', cardId: DET_ID });
    expect(first.id).toBe(DET_ID);

    // Retried materialization (different title) → the prior card, not a dup,
    // and the original fields win (the retry must not rewrite human state).
    const retried = await createCard({ boardId: board.id, columnId: col, title: 'DIFFERENT title', cardId: DET_ID });
    expect(retried.id).toBe(DET_ID);
    expect(retried.title).toBe('Day 1 action');
    expect(retried.createdAt).toBe(first.createdAt);
  });

  it('a cardId existing on a DIFFERENT board fails closed (no silent overwrite)', async () => {
    const other = await createBoard({ tenantId: 't-det', name: 'Another board' });
    await expect(
      createCard({ boardId: other.id, columnId: other.columns[0].id, title: 'Hijack', cardId: DET_ID }),
    ).rejects.toThrow(/collision/);
    // The original card is intact on its original board.
    const intact = await getCard(DET_ID);
    expect(intact?.title).toBe('Day 1 action');
  });

  it('omitted cardId still mints random ids (normal path unaffected)', async () => {
    const board = await createBoard({ tenantId: 't-det', name: 'Random-id board' });
    const a = await createCard({ boardId: board.id, columnId: board.columns[0].id, title: 'A' });
    const b = await createCard({ boardId: board.id, columnId: board.columns[0].id, title: 'B' });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^card-/);
  });
});
