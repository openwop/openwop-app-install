/**
 * ADR 0049 — withdrawing an assignment also resolves a BATCH assignment notice,
 * but only once none of its cards is still the recipient's work.
 *
 * Adopters emit one `task.assigned` notice for several cards, with metadata
 * `{ kind: 'kanban.assigned.batch', cardIds }`. The withdraw matched only
 * `metadata.cardId`, so a batch notice was never withdrawn on unassign, reassign or
 * complete. Bare persistence (sqlite memory + the notification backend) and the
 * real kanban service. Each case mutates the card first and then withdraws, which
 * is the order the routes use.
 *
 * Red if: a batch notice is archived while one of its cards is still assigned to
 * the recipient and open; a batch notice stays once every card is unassigned,
 * reassigned or finished; or a single-card notice stops being withdrawn, or is
 * withdrawn for another card.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { createWorkspace } from '../src/host/accessControlService.js';
import { createBoard, createCard, moveCard, updateCardFields } from '../src/host/kanbanService.js';
import { withdrawAssignmentNotification } from '../src/host/kanbanAssignmentNotify.js';

const ALICE = 'user:alice';
let store: Storage;
let tenantId: string;
let n = 0;

beforeAll(async () => {
  store = await openStorage('memory://');
  initHostExtPersistence(store);
  ensureNotificationEmitterInstalled(store);
  tenantId = (await createWorkspace({ name: 'Studio', ownerSubject: 'user:owner' })).tenantId;
});
afterAll(async () => {
  __resetHostExtPersistence();
  await store.close();
});

/** Two cards assigned to Alice, plus one batch notice naming both. */
async function batchOfTwo(): Promise<{ c1: string; c2: string; batchId: string }> {
  const board = await createBoard({ tenantId, name: `Board ${n++}` });
  const c1 = (await createCard({ boardId: board.id, columnId: 'todo', title: 'Order the sofa', assigneeId: ALICE })).id;
  const c2 = (await createCard({ boardId: board.id, columnId: 'todo', title: 'Pick the tiles', assigneeId: ALICE })).id;
  const batchId = `batch-${n++}`;
  await getNotificationEmitter().emit({
    notificationId: batchId, tenantId, recipientUserId: ALICE, type: 'task.assigned', priority: 'normal',
    title: 'Assigned: 2 cards', message: 'You were assigned 2 cards.',
    metadata: { kind: 'kanban.assigned.batch', cardIds: [c1, c2], boardId: board.id },
  });
  return { c1, c2, batchId };
}

const statusOf = async (id: string): Promise<string | undefined> => (await store.getNotification(id))?.status;

describe('ADR 0049 — a batch assignment notice is withdrawn with its last card', () => {
  it('withdrawing one card keeps the batch; withdrawing both archives it', async () => {
    const { c1, c2, batchId } = await batchOfTwo();
    await updateCardFields(c1, { assigneeId: null });
    await withdrawAssignmentNotification({ tenantId, cardId: c1, recipientUserId: ALICE });
    expect(await statusOf(batchId), 'c2 is still Alice\'s work').not.toBe('archived');

    await updateCardFields(c2, { assigneeId: 'user:bob' }); // reassigned
    await withdrawAssignmentNotification({ tenantId, cardId: c2, recipientUserId: ALICE });
    expect(await statusOf(batchId)).toBe('archived');
  });

  it('a card finished in a terminal lane counts as no longer hers', async () => {
    const { c1, c2, batchId } = await batchOfTwo();
    await moveCard(c2, 'done'); // finished, still assigned
    await updateCardFields(c1, { assigneeId: null });
    await withdrawAssignmentNotification({ tenantId, cardId: c1, recipientUserId: ALICE });
    expect(await statusOf(batchId)).toBe('archived');
  });

  it('another recipient\'s withdraw leaves Alice\'s batch alone', async () => {
    const { c1, batchId } = await batchOfTwo();
    await withdrawAssignmentNotification({ tenantId, cardId: c1, recipientUserId: 'user:bob' });
    expect(await statusOf(batchId)).not.toBe('archived');
  });

  it('a single-card notice is still withdrawn for its own card, and only for it', async () => {
    const board = await createBoard({ tenantId, name: `Board ${n++}` });
    const c1 = (await createCard({ boardId: board.id, columnId: 'todo', title: 'One', assigneeId: ALICE })).id;
    const c2 = (await createCard({ boardId: board.id, columnId: 'todo', title: 'Two', assigneeId: ALICE })).id;
    for (const id of [c1, c2]) {
      await getNotificationEmitter().emit({
        notificationId: `single-${id}`, tenantId, recipientUserId: ALICE, type: 'task.assigned', priority: 'normal',
        title: 'Assigned', message: 'You were assigned a card.', metadata: { kind: 'kanban.assigned', cardId: id, boardId: board.id },
      });
    }
    await withdrawAssignmentNotification({ tenantId, cardId: c1, recipientUserId: ALICE });
    expect(await statusOf(`single-${c1}`)).toBe('archived');
    expect(await statusOf(`single-${c2}`)).not.toBe('archived');
  });
});
