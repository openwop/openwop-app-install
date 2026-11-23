/**
 * ADR 1155 D4 / D5 (P4) — batch create and batch patch, as `applyBoardCommand` commands.
 *
 * Create: every item is validated before anything is written; card ids derive from
 * the source id, so a retried or resumed batch converges with no duplicates; each card
 * is its own atomic write, and a failed write is reported for that item alone.
 * Patch: each card is its own CAS, with `expectedVersion`; each item reports its own
 * outcome; only re-date and grouping fields can be batched.
 *
 * Red if: a bad item lets any card be written; a retry duplicates; a failed write
 * hides inside a success; a refresh touches an assignee or a terminal card; a conflict
 * is reported as updated; a no-op bumps the version; or a batch fires more than one
 * board event.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import {
  KANBAN_BATCH_CREATE_MAX, KANBAN_BATCH_PATCH_MAX, __resetKanbanStore, applyBoardCommand, batchCardIdOf, createBoard, createCard,
  getCard, listCards, moveCard, subscribeBoardChanges,
  type CreateKanbanCardsBatchCommand, type KanbanBatchCardInput, type KanbanBoard,
} from '../src/host/kanbanService.js';

const codeOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (err: { code?: unknown }) => err.code);
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };

let store: Storage;
let tenantId: string;
let board: KanbanBoard;
beforeEach(async () => {
  store = await openStorage('memory://');
  initHostExtPersistence(store);
  ensureNotificationEmitterInstalled(store);
  await __resetKanbanStore();
  tenantId = (await createWorkspace({ name: 'Batch', ownerSubject: 'user:owner' })).tenantId;
  await createMember({ tenantId, orgId: tenantId, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
  board = await createBoard({ tenantId, name: 'House' });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { __resetHostExtPersistence(); });

const item = (n: number, over: Partial<KanbanBatchCardInput> = {}): KanbanBatchCardInput => ({ sourceId: `sel-${n}`, title: `Selection ${n}`, columnId: 'todo', ...over });
const create = (items: KanbanBatchCardInput[], over: Partial<CreateKanbanCardsBatchCommand> = {}) =>
  applyBoardCommand({ type: 'cards.create-batch', tenantId, boardId: board.id, items, ...over });

describe('ADR 1155 D4 — cards.create-batch', () => {
  it('refuses the whole batch on one bad item, and writes nothing', async () => {
    expect(await codeOf(create([item(1), item(1)]))).toBe('kanban_card_invalid');
    expect(await codeOf(create([item(1), item(2, { columnId: 'nope' })]))).toBe('kanban_card_invalid');
    expect(await codeOf(create([item(1), item(2, { dueAt: 'soon' })]))).toBe('kanban_card_invalid');
    expect(await codeOf(create([item(1), item(2, { facets: { Room: 'x' } })]))).toBe('kanban_card_invalid');
    expect(await codeOf(create([item(1, { assigneeId: 'user:stranger' })]))).toBe('kanban_assignee_invalid');
    expect(await codeOf(create(Array.from({ length: KANBAN_BATCH_CREATE_MAX + 1 }, (_, i) => item(i))))).toBe('kanban_command_invalid');
    expect(await codeOf(create([]))).toBe('kanban_command_invalid');
    expect(await listCards(board.id)).toHaveLength(0);
  });

  it('creates with derived ids after the lane\'s last card; a retry and a resume converge', async () => {
    const existing = await createCard({ boardId: board.id, columnId: 'todo', title: 'Already here' });
    const first = await create([item(1), item(2)]);
    expect(first.items.map((r) => r.status)).toEqual(['created', 'created']);
    expect(first.items.map((r) => r.cardId)).toEqual([batchCardIdOf(tenantId, board.id, 'sel-1'), batchCardIdOf(tenantId, board.id, 'sel-2')]);

    const full = await create([item(1), item(2), item(3), item(4, { columnId: 'doing' })]);
    expect(full.items.map((r) => r.status)).toEqual(['existing', 'existing', 'created', 'created']);
    expect((await create([item(1), item(2), item(3), item(4, { columnId: 'doing' })])).items.every((r) => r.status === 'existing')).toBe(true);

    const cards = await listCards(board.id);
    expect(cards).toHaveLength(5);
    const todo = cards.filter((c) => c.columnId === 'todo').sort((a, b) => a.order - b.order).map((c) => c.title);
    expect(todo).toEqual(['Already here', 'Selection 1', 'Selection 2', 'Selection 3']);
    expect((await getCard(existing.id))?.order).toBeLessThan((await getCard(batchCardIdOf(tenantId, board.id, 'sel-1')))!.order);
  });

  it('refresh updates only source-owned facts, and never a card in a terminal lane', async () => {
    await create([item(1, { assigneeId: 'user:alice', dueAt: '2026-12-01T00:00:00.000Z' }), item(2)]);
    const done = batchCardIdOf(tenantId, board.id, 'sel-2');
    await moveCard(done, 'done');
    const r = await create(
      [item(1, { title: 'Pick tile', dueAt: '2026-12-15T00:00:00.000Z' }), item(2, { title: 'Too late' })],
      { onExisting: 'refresh' },
    );
    expect(r.items.map((x) => x.status)).toEqual(['refreshed', 'existing']);
    const one = await getCard(batchCardIdOf(tenantId, board.id, 'sel-1'));
    expect(one).toMatchObject({ title: 'Pick tile', dueAt: '2026-12-15T00:00:00.000Z', assigneeId: 'user:alice', columnId: 'todo' });
    expect((await getCard(done))?.title).toBe('Selection 2');
  });

  it('a failed write is reported for that item alone; the rest land', async () => {
    const broken = `hostext:kanban:card:${batchCardIdOf(tenantId, board.id, 'sel-2')}`;
    const cas = store.kvCompareAndSwap.bind(store);
    vi.spyOn(store, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === broken) throw new Error('disk full');
      return cas(key, expected, next);
    });
    const r = await create([item(1), item(2), item(3)]);
    expect(r.items.map((x) => x.status)).toEqual(['created', 'failed', 'created']);
    expect(r.items[1]?.error).toContain('disk full');
    vi.restoreAllMocks();
    expect((await listCards(board.id)).map((c) => c.title).sort()).toEqual(['Selection 1', 'Selection 3']);
    expect((await create([item(1), item(2), item(3)])).items.map((x) => x.status)).toEqual(['existing', 'created', 'existing']);
  });

  it('sends no assignment notice unless asked, and one board event per batch', async () => {
    let events = 0;
    const stop = await subscribeBoardChanges((id) => { if (id === board.id) events += 1; });
    await create([item(1, { assigneeId: 'user:alice' }), item(2, { assigneeId: 'user:alice' })]);
    await flush();
    expect(events).toBe(1);
    const notices = async () => (await store.listNotifications({ tenantId, recipientUserId: 'user:alice' })).length;
    expect(await notices()).toBe(0);
    await create([item(3, { assigneeId: 'user:alice' })], { notifyAssignees: true });
    expect(await notices()).toBe(1);
    await create([item(3, { assigneeId: 'user:alice' })]); // nothing new: no event
    await flush();
    expect(events).toBe(2);
    await stop();
  });
});

describe('ADR 1155 D5 — cards.patch-batch', () => {
  it('each item reports its own outcome; only re-date and grouping fields batch', async () => {
    await create([item(1, { dueAt: '2026-12-01T00:00:00.000Z' }), item(2), item(3, { labels: ['decisions'] })]);
    const [a, b, c] = ['sel-1', 'sel-2', 'sel-3'].map((s) => batchCardIdOf(tenantId, board.id, s)) as [string, string, string];
    const cVersion = (await getCard(c))!.version;
    const r = await applyBoardCommand({
      type: 'cards.patch-batch', tenantId, boardId: board.id,
      items: [
        { cardId: a, patch: { dueAt: '2026-12-20T00:00:00.000Z' } },
        { cardId: b, expectedVersion: 99, patch: { dueAt: '2026-12-20T00:00:00.000Z' } },
        { cardId: c, patch: { labels: ['decisions'] } },
        { cardId: 'card-missing', patch: { priority: 'high' } },
        { cardId: a, patch: { title: 'Renamed' } as unknown as { priority: 'high' } },
      ],
    });
    expect(r.items.map((x) => x.status)).toEqual(['updated', 'conflict', 'unchanged', 'not_found', 'invalid']);
    expect((await getCard(a))?.dueAt).toBe('2026-12-20T00:00:00.000Z');
    expect((await getCard(b))?.dueAt).toBeUndefined();
    expect((await getCard(c))?.version).toBe(cVersion);
    expect((await getCard(a))?.title).toBe('Selection 1');

    const cleared = await applyBoardCommand({ type: 'cards.patch-batch', tenantId, boardId: board.id, items: [{ cardId: a, expectedVersion: (await getCard(a))!.version, patch: { dueAt: null } }] });
    expect(cleared.items[0]?.status).toBe('updated');
    expect((await getCard(a))?.dueAt).toBeUndefined();
  });

  it('refuses an empty or oversize batch and another tenant\'s board', async () => {
    const patch = (n: number) => applyBoardCommand({ type: 'cards.patch-batch', tenantId, boardId: board.id, items: Array.from({ length: n }, () => ({ cardId: 'x', patch: { priority: 'low' as const } })) });
    expect(await codeOf(patch(0))).toBe('kanban_command_invalid');
    expect(await codeOf(patch(KANBAN_BATCH_PATCH_MAX + 1))).toBe('kanban_command_invalid');
    const other = (await createWorkspace({ name: 'Other', ownerSubject: 'user:other' })).tenantId;
    expect(await codeOf(applyBoardCommand({ type: 'cards.patch-batch', tenantId: other, boardId: board.id, items: [{ cardId: 'x', patch: { priority: 'low' } }] }))).toBe('kanban_board_not_found');
    expect(await codeOf(applyBoardCommand({ type: 'cards.create-batch', tenantId: other, boardId: board.id, items: [item(1)] }))).toBe('kanban_board_not_found');
  });
});
