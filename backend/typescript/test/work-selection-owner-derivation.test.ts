/**
 * ADR 0716 — the ranking door must derive a board's owner the SAME way every other
 * door does (`boardSubject`), not by reading the raw `ownerSubject` field.
 *
 * Why this file has to register a resolver to mean anything: with the resolvers that
 * actually ship (`'project'` and `'board'` only), BOTH forms return `null` for a
 * legacy `ownerUserId` board, so the fix is behaviourally invisible and a test without
 * a `'user'` resolver would pass before AND after — pinning nothing. Leg 3 supplies the
 * resolver that makes the divergence observable; leg 1 pins that, absent one, today's
 * behaviour is unchanged.
 *
 * The resolver is registered ONCE and gated on a flag that returns `null` when
 * inactive — `null` is precisely what an unregistered kind produces
 * (`subjectAccess.ts:50-51`), so the "no resolver" legs are faithful and the file has
 * no order dependence (there is no unregister helper).
 *
 * Sabotage-witnessed (grade-tests wave 64): reading the raw `ownerSubject`
 * (8fw5g5-wsod-subject) reds leg 3; dropping the level check reds legs 3–5;
 * treating `null` as a refusal reds leg 1; dropping the tenant compare reds leg 2.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createBoard, createCard, type KanbanBoard } from '../src/host/kanbanService.js';
import { registerSubjectAccessResolver } from '../src/host/subjectAccess.js';
import { readBoardRanking } from '../src/features/work-selection/agentTools.js';

const T = 'ws-owner-derivation';
const OWNER = 'u-owner';
const OTHER = 'u-other';
const NOW = Date.parse('2026-09-17T12:00:00.000Z');

/** When false the resolver answers `null` — byte-equivalent to the kind being
 *  unregistered, which is the shipped state. */
let userResolverActive = false;
registerSubjectAccessResolver('user', async (_t, subject, caller) => {
  if (!userResolverActive) return null;
  return caller === subject.id ? 'write' : 'none';
});

/** A LEGACY board: ownership recorded in `ownerUserId`, with NO `ownerSubject`.
 *  `boardSubject` derives `{kind:'user'}` from it (ADR 0045); the raw field is
 *  `undefined`, which is exactly the blindness this ADR closes. */
async function legacyUserBoard(): Promise<KanbanBoard> {
  const board = await createBoard({ tenantId: T, name: 'Personal', ownerUserId: OWNER });
  const todo = board.columns.find((c) => c.id === 'todo')!;
  await createCard({ boardId: board.id, columnId: todo.id, title: 'Ship the thing' });
  return board;
}

beforeEach(async () => {
  userResolverActive = false;
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0716 D1 — the ranking door derives the owner canonically', () => {
  it('leg 1 (CONTROL): with no `user` resolver, a legacy board ranks tenant-wide — today\'s documented behaviour, UNCHANGED', async () => {
    // This is the ADR's central honesty claim: the fix changes no answer as shipped.
    // `authorizeBoard`'s null branch grants the same tenant-wide read for agent/personal
    // boards (routes/kanban.ts:143) — so this is agreement, not a leak.
    const board = await legacyUserBoard();
    expect((await readBoardRanking(T, board.id, NOW, OWNER)).ranked.length).toBe(1);
    expect((await readBoardRanking(T, board.id, NOW, OTHER)).ranked.length, 'legacy rule: tenant-wide').toBe(1);
  });

  it('leg 2: a cross-tenant board still reports EMPTY, with no existence leak', async () => {
    const board = await legacyUserBoard();
    expect(await readBoardRanking('some-other-tenant', board.id, NOW, OWNER)).toEqual({ ranked: [], held: [] });
  });

  it('leg 3: once a `user` resolver EXISTS, a non-owner is refused — this is what D1 buys', async () => {
    // BORN RED without D1: the raw `ownerSubject` field is undefined on a legacy board,
    // so the gate was skipped entirely and this returned the card (title included) to a
    // non-owner, while `routes/kanban.ts` — which already uses `boardSubject` — refused.
    const board = await legacyUserBoard();
    userResolverActive = true;
    expect((await readBoardRanking(T, board.id, NOW, OWNER)).ranked.length, 'the owner still reads').toBe(1);
    expect(await readBoardRanking(T, board.id, NOW, OTHER), 'a non-owner is refused, matching kanban').toEqual({ ranked: [], held: [] });
  });

  it('leg 4: refusal is EMPTY, not an error — the door keeps its no-existence-leak posture', async () => {
    const board = await legacyUserBoard();
    userResolverActive = true;
    const refused = await readBoardRanking(T, board.id, NOW, OTHER);
    const absent = await readBoardRanking(T, 'board-does-not-exist', NOW, OTHER);
    // Literal on both sides: comparing the two calls alone would pass if a
    // sabotage changed both the same way.
    // ADR 0963 D3 changed the door's return to `{ ranked, held }` (it was a bare
    // array); the literal moved with it. A bare `[]` here would now be red.
    expect(refused).toEqual({ ranked: [], held: [] });
    expect(absent).toEqual({ ranked: [], held: [] });
    expect(refused, 'refused and absent must be indistinguishable').toEqual(absent);
  });

  it('leg 5 (non-vacuity): an EXPLICIT ownerSubject board was already gated — so leg 3 is about the LEGACY shape', async () => {
    // Without this, leg 3 could be read as "the gate did not work at all", which is false:
    // an explicitly-owned board was gated before this ADR. The defect was narrower.
    const board = await createBoard({ tenantId: T, name: 'Explicit', ownerSubject: { kind: 'user', id: OWNER } });
    const todo = board.columns.find((c) => c.id === 'todo')!;
    await createCard({ boardId: board.id, columnId: todo.id, title: 'Explicitly owned' });
    userResolverActive = true;
    expect((await readBoardRanking(T, board.id, NOW, OWNER)).ranked.length).toBe(1);
    expect(await readBoardRanking(T, board.id, NOW, OTHER)).toEqual({ ranked: [], held: [] });
  });
});
