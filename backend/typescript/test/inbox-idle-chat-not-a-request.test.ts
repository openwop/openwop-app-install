/**
 * #5922 P0 — an idle chat is not a request.
 *
 * Every chat is a run whose conversation gate suspends between turns. The
 * suspend manager notified for that `conversation` interrupt, so each open chat
 * put one "Input needed" item in the inbox, and ADR 1114 never retired it
 * (the interrupt only closes when the chat does, which is never).
 *
 * Pinned here: a `conversation` suspension notifies nobody while an approval
 * still does; the one-time background job retires the items already sent,
 * host-wide, as read + `withdrawn` (never archived, never another kind), and a
 * second run finds nothing. Sabotage witness: drop `'conversation'` from
 * `NEVER_NOTIFY_KINDS`, or the `metadata.kind` filter from the storage update,
 * and a case here fails.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as string[]);
vi.mock('../src/notifications/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/notifications/notify.js')>()),
  emitInterruptNotification: async (_b: unknown, record: { kind: string }) => { emitted.push(record.kind); },
}));

import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { NotificationRecord } from '../src/types.js';
import { getSuspendManager, setSuspendBackend, NEVER_NOTIFY_KINDS } from '../src/executor/suspendManager.js';
import { retireConversationRequests } from '../src/notifications/retireRequests.js';
import { BACKGROUND_APP_JOBS } from '../src/host/appMigrations.js';

function row(id: string, tenantId: string, over: Partial<NotificationRecord>): NotificationRecord {
  return {
    notificationId: id, tenantId, type: 'workflow.input_needed', priority: 'normal',
    status: 'unread', title: 'Conversation in progress', message: 'm', createdAt: '2026-11-01T00:00:00.000Z', ...over,
  };
}

let storage: Storage;
beforeAll(async () => {
  storage = await openStorage('memory://');
  setSuspendBackend(storage);
});

describe('#5922 — a chat waiting for its next message files nothing', () => {
  it('a conversation suspension notifies nobody; an approval still does', async () => {
    expect(NEVER_NOTIFY_KINDS.has('conversation')).toBe(true);
    const sm = getSuspendManager();
    await sm.createInterrupt({ runId: 'r-chat', nodeId: 'turn', kind: 'conversation', data: { conversationId: 'c1', turnIndex: 0 } });
    await sm.createInterrupt({ runId: 'r-gate', nodeId: 'gate', kind: 'approval', data: { prompt: 'Ship it?' } });
    expect(emitted).toEqual(['approval']);
  });
});

describe('#5922 — the items already sent are retired once', () => {
  it('stamps open conversation requests in every tenant, and nothing else', async () => {
    await storage.insertNotification(row('c1', 'org:a', { runId: 'r1', interruptId: 'i1', metadata: { kind: 'conversation' } }));
    await storage.insertNotification(row('c2', 'org:b', { runId: 'r2', interruptId: 'i2', status: 'read', metadata: { kind: 'conversation' } }));
    await storage.insertNotification(row('c3', 'org:a', { runId: 'r3', interruptId: 'i3', status: 'archived', metadata: { kind: 'conversation' } }));
    await storage.insertNotification(row('c4', 'org:a', { runId: 'r4', interruptId: 'i4', metadata: { kind: 'conversation', resolution: { state: 'run-ended', at: 'x' } } }));
    await storage.insertNotification(row('ap', 'org:a', { runId: 'r5', interruptId: 'i5', type: 'openwop-app.workflow.approval-needed', metadata: { kind: 'approval' } }));
    await storage.insertNotification(row('nr', 'org:a', { runId: 'r6', metadata: { kind: 'conversation' } })); // names no interrupt

    const at = new Date('2026-11-14T12:00:00.000Z');
    expect(await retireConversationRequests(storage, () => at)).toBe(2);

    const c1 = await storage.getNotification('c1');
    expect(c1?.status).toBe('read');
    expect(c1?.readAt).toBe(at.toISOString());
    expect(c1?.metadata).toEqual({ kind: 'conversation', resolution: { state: 'withdrawn', at: at.toISOString() } });
    expect((await storage.getNotification('c2'))?.metadata?.resolution).toEqual({ state: 'withdrawn', at: at.toISOString() });
    expect((await storage.getNotification('c3'))?.status).toBe('archived');
    expect((await storage.getNotification('c3'))?.metadata?.resolution).toBeUndefined();
    expect((await storage.getNotification('c4'))?.metadata?.resolution).toEqual({ state: 'run-ended', at: 'x' });
    expect((await storage.getNotification('ap'))?.status).toBe('unread');
    expect((await storage.getNotification('ap'))?.metadata?.resolution).toBeUndefined();
    expect((await storage.getNotification('nr'))?.metadata?.resolution).toBeUndefined();

    // Idempotent: a second boot, or a second instance, finds nothing.
    expect(await retireConversationRequests(storage)).toBe(0);
  });

  it('runs as a background job that is done once it ran, and pending on a storage that cannot', async () => {
    const job = BACKGROUND_APP_JOBS.find((j) => j.id === 'retire-conversation-requests');
    expect(job).toBeDefined();
    expect(await job!.run(storage)).toEqual({ complete: true });
    const without = Object.assign(Object.create(storage) as Storage, { resolveRequestNotificationsOfKind: undefined });
    expect(await job!.run(without)).toEqual({ complete: false });
  });
});
