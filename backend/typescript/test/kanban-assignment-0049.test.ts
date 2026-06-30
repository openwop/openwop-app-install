/**
 * ADR 0049 (kanban card assignment) + ADR 0050 (per-recipient notification
 * targeting).
 *
 * Covers, against the sqlite memory backend booted by createApp:
 *  - ADR 0050: an ADDRESSED notification (recipientUserId set) is visible only
 *    to its recipient + tenant broadcasts; broadcasts reach everyone;
 *    markAllNotificationsRead is recipient-scoped.
 *  - ADR 0049: the "assigned to me" mirror aggregates direct + role-addressed
 *    cards across boards; completion stamping on a terminal column; the
 *    `taskAssign` surface op now emits an addressed notification (the formerly
 *    dead `notifyAssignee`) and withdraws the prior assignee's on reassign.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  createBoard,
  createCard,
  moveCard,
  getCard,
  listCardsAssignedToUser,
} from '../src/host/kanbanService.js';
import { createKanbanSurface } from '../src/host/kanbanSurface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(0, res); });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

const storage = (): Storage => {
  const s = __hostExtStorage();
  if (!s) throw new Error('storage not initialized');
  return s;
};

describe('ADR 0050 — per-recipient notification targeting', () => {
  it('addressed notifications are private to their recipient; broadcasts reach all', async () => {
    const tenantId = 'ws:notif-test';
    const emit = (recipientUserId: string | undefined, title: string) =>
      storage().insertNotification({
        notificationId: `n-${title}`,
        tenantId,
        ...(recipientUserId ? { recipientUserId } : {}),
        type: 'task.assigned',
        priority: 'normal',
        status: 'unread',
        title,
        message: title,
        createdAt: new Date().toISOString(),
      });
    await emit(undefined, 'broadcast');
    await emit('userA', 'for-A');
    await emit('userB', 'for-B');

    const aView = await storage().listNotifications({ tenantId, recipientUserId: 'userA' });
    const titles = aView.map((n) => n.title).sort();
    expect(titles).toEqual(['broadcast', 'for-A']); // NOT for-B

    const adminView = await storage().listNotifications({ tenantId });
    expect(adminView).toHaveLength(3); // no recipient filter → everything

    // mark-all-read scoped to userA clears A + broadcast, leaves B unread.
    const cleared = await storage().markAllNotificationsRead(tenantId, new Date().toISOString(), 'userA');
    expect(cleared).toBe(2);
    const bStill = await storage().getNotification('n-for-B');
    expect(bStill?.status).toBe('unread');
  });
});

describe('ADR 0049 — assignment model', () => {
  it('mirror aggregates direct + role-addressed cards across boards', async () => {
    const tenantId = 'ws:mirror-test';
    const b1 = await createBoard({ tenantId, name: 'Project A' });
    const b2 = await createBoard({ tenantId, name: 'Project B' });
    await createCard({ boardId: b1.id, columnId: 'todo', title: 'direct-to-me', assigneeId: 'userA' });
    await createCard({ boardId: b2.id, columnId: 'todo', title: 'role-editor', assigneeRole: 'editor' });
    await createCard({ boardId: b1.id, columnId: 'todo', title: 'someone-else', assigneeId: 'userZ' });

    const mine = await listCardsAssignedToUser(tenantId, 'userA', ['editor']);
    const titles = mine.map((c) => c.title).sort();
    expect(titles).toEqual(['direct-to-me', 'role-editor']);
    // each row carries its origin board name (the mirror shows provenance)
    expect(mine.find((c) => c.title === 'role-editor')?.boardName).toBe('Project B');

    // Without the role, the role-addressed card drops out.
    const noRole = await listCardsAssignedToUser(tenantId, 'userA', []);
    expect(noRole.map((c) => c.title)).toEqual(['direct-to-me']);
  });

  it('stamps completedAt on entry into a terminal column and clears it on exit', async () => {
    const tenantId = 'ws:complete-test';
    const b = await createBoard({ tenantId, name: 'Board' });
    const card = await createCard({ boardId: b.id, columnId: 'todo', title: 'task' });
    expect(card.completedAt).toBeUndefined();

    await moveCard(card.id, 'done'); // default 'done' column is terminal
    expect((await getCard(card.id))?.completedAt).toBeTruthy();

    await moveCard(card.id, 'doing');
    expect((await getCard(card.id))?.completedAt).toBeUndefined();
  });
});

describe('ADR 0049 — taskAssign honors notifyAssignee', () => {
  it('emits an addressed notification on assign and withdraws the prior on reassign', async () => {
    const tenantId = 'ws:assign-test';
    const b = await createBoard({ tenantId, name: 'Board' });
    const card = await createCard({ boardId: b.id, columnId: 'todo', title: 'do the thing' });
    const surface = createKanbanSurface({ tenantId } as BundleScope);

    await surface.taskAssign({ taskId: card.id, assigneeId: 'userA', notifyAssignee: true, idempotencyKey: 'k1' });
    const aInbox = await storage().listNotifications({ tenantId, recipientUserId: 'userA' });
    const assigned = aInbox.filter((n) => n.type === 'task.assigned');
    expect(assigned).toHaveLength(1);
    expect((assigned[0].metadata as { cardId?: string }).cardId).toBe(card.id);
    expect(assigned[0].status).toBe('unread');

    // Reassign to B → A's item is withdrawn (archived), B gets a fresh one.
    await surface.taskAssign({ taskId: card.id, assigneeId: 'userB', notifyAssignee: true, idempotencyKey: 'k2' });
    const aAfter = await storage().listNotifications({ tenantId, recipientUserId: 'userA', includeArchived: true });
    expect(aAfter.find((n) => n.type === 'task.assigned')?.status).toBe('archived');
    const bInbox = await storage().listNotifications({ tenantId, recipientUserId: 'userB' });
    expect(bInbox.filter((n) => n.type === 'task.assigned' && n.status === 'unread')).toHaveLength(1);
  });

  it('does not emit when notifyAssignee is false', async () => {
    const tenantId = 'ws:assign-silent';
    const b = await createBoard({ tenantId, name: 'Board' });
    const card = await createCard({ boardId: b.id, columnId: 'todo', title: 'silent' });
    const surface = createKanbanSurface({ tenantId } as BundleScope);
    await surface.taskAssign({ taskId: card.id, assigneeId: 'userA', notifyAssignee: false, idempotencyKey: 'k3' });
    const aInbox = await storage().listNotifications({ tenantId, recipientUserId: 'userA' });
    expect(aInbox.filter((n) => n.type === 'task.assigned')).toHaveLength(0);
  });
});
