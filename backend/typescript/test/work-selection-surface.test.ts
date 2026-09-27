/**
 * ADR 0534 P4 — the read surface + agent tool, and the isolation they share.
 *
 * The surface op and the agent tool both go through ONE predicate
 * (`readBoardRanking`), so this suite is deliberately written against that
 * helper plus the surface: if they ever stopped sharing it, the tenant-isolation
 * assertions below would have to be duplicated to stay true, which is the drift
 * ADR 0308 forbids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBoard, createCard, type KanbanBoard } from '../src/host/kanbanService.js';
import { readBoardRanking } from '../src/features/work-selection/agentTools.js';
import { buildWorkSelectionSurface } from '../src/features/work-selection/surface.js';

const OWNER = 'ws-surface-owner';
const OTHER = 'ws-surface-other';
const NOW = Date.parse('2026-08-09T12:00:00.000Z');

let board: KanbanBoard;

async function makeBoard(tenantId: string): Promise<KanbanBoard> {
  return createBoard({
    tenantId,
    name: 'Agent board',
    ownerSubject: { kind: 'agent', id: `roster-${tenantId}` },
    columns: [
      { id: 'todo', name: 'To Do' },
      { id: 'working', name: 'Working' },
      { id: 'done', name: 'Done', terminal: true },
    ],
  });
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  board = await makeBoard(OWNER);
  await createCard({ boardId: board.id, columnId: 'todo', title: 'low', priority: 'low' });
  await createCard({ boardId: board.id, columnId: 'todo', title: 'high', priority: 'high' });
  await createCard({ boardId: board.id, columnId: 'working', title: 'in flight' });
});
afterEach(() => __resetHostExtPersistence());

describe('ADR 0534 P4 — preview ranks the To Do lane', () => {
  it('ranks candidates and explains each score', async () => {
    const ranked = await readBoardRanking(OWNER, board.id, NOW, undefined);

    expect(ranked.map((r) => r.title)).toEqual(['high', 'low']);
    expect(ranked[0]!.rank).toBe(1);
    // "Why" must be renderable without re-deriving the vocabulary from ids.
    expect(ranked[0]!.why.map((w) => w.criterion)).toContain('Stated priority');
  });

  it('ranks ONLY the To Do lane — in-flight work is not a candidate', async () => {
    const ranked = await readBoardRanking(OWNER, board.id, NOW, undefined);
    expect(ranked.map((r) => r.title)).not.toContain('in flight');
  });
});

describe('ADR 0534 P4 — isolation (one predicate, both callers)', () => {
  it('a cross-tenant board reads EMPTY, not an error', async () => {
    // Empty rather than throwing: a caller probing board ids must not be able to
    // distinguish "does not exist" from "not yours".
    expect(await readBoardRanking(OTHER, board.id, NOW, undefined)).toEqual([]);
  });

  it('an unknown board id reads EMPTY — indistinguishable from cross-tenant', async () => {
    expect(await readBoardRanking(OWNER, 'no-such-board', NOW, undefined)).toEqual([]);
  });

  it('no tenant ⇒ EMPTY, never an ambient fallback', async () => {
    // ADR 0308: fail empty without authority rather than reading some other
    // caller's board.
    expect(await readBoardRanking(undefined, board.id, NOW, undefined)).toEqual([]);
  });

  it('the surface enforces the same isolation as the tool', async () => {
    const mine = buildWorkSelectionSurface({ tenantId: OWNER } as never);
    const theirs = buildWorkSelectionSurface({ tenantId: OTHER } as never);

    const ok = await mine.preview!({ boardId: board.id });
    const denied = await theirs.preview!({ boardId: board.id });

    expect((ok as { ranked: unknown[] }).ranked).toHaveLength(2);
    expect((denied as { ranked: unknown[] }).ranked).toEqual([]);
  });

  it('a missing boardId reads EMPTY rather than ranking something arbitrary', async () => {
    const surface = buildWorkSelectionSurface({ tenantId: OWNER } as never);
    expect((await surface.preview!({}) as { ranked: unknown[] }).ranked).toEqual([]);
  });
});
