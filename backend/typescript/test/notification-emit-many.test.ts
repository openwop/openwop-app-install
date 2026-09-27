/**
 * ADR 0214 D3 / NOTIF-3 — `emitMany` per-item isolation: one recipient's insert
 * failing must NOT drop the others (nor abort the whole batched web-push), and only
 * the rows that actually landed are returned. (The single-subscription-scan batching
 * is structurally one `listPushSubscriptions` call in `pushNotificationsBatch`;
 * exercised end-to-end by the channel-activity route test.)
 */
import { describe, it, expect } from 'vitest';
import { getNotificationEmitter, setNotificationBackend } from '../src/notifications/emitter.js';
import type { Storage } from '../src/storage/storage.js';
import type { NotificationRecord } from '../src/types.js';

function mk(uid: string): Omit<NotificationRecord, 'notificationId' | 'createdAt' | 'status'> {
  return { tenantId: 't', recipientUserId: uid, type: 'chat.channel_post', priority: 'normal', title: '#c', message: `msg ${uid}` };
}

describe('emitMany — per-item isolation (NOTIF-3)', () => {
  it('a single insert failure does not strand the other recipients; only inserted rows are returned', async () => {
    const inserted: string[] = [];
    const fake = {
      insertNotification: async (r: NotificationRecord) => {
        if (r.recipientUserId === 'boom') throw new Error('db transient');
        inserted.push(r.recipientUserId!);
      },
      // Unused (web-push is unconfigured in tests → pushNotificationsBatch returns early),
      // present so the batch path can't throw on a missing method.
      listPushSubscriptions: async () => [],
      deletePushSubscription: async () => {},
    } as unknown as Storage;
    setNotificationBackend(fake);

    const out = await getNotificationEmitter().emitMany([mk('u1'), mk('boom'), mk('u3')]);

    expect(inserted).toEqual(['u1', 'u3']);            // boom failed; the rest still inserted
    expect(out.map((r) => r.recipientUserId)).toEqual(['u1', 'u3']); // only landed rows returned
  });

  it('an empty input is a no-op', async () => {
    setNotificationBackend({ insertNotification: async () => { throw new Error('should not be called'); }, listPushSubscriptions: async () => [], deletePushSubscription: async () => {} } as unknown as Storage);
    expect(await getNotificationEmitter().emitMany([])).toEqual([]);
  });
});
