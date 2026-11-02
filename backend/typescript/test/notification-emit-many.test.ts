/**
 * ADR 0214 D3 / NOTIF-3 — `emitMany` per-item isolation: one recipient's insert
 * failing must NOT drop the others (nor abort the whole batched web-push), and only
 * the rows that actually landed are returned. (The single-subscription-scan batching
 * is structurally one `listPushSubscriptions` call in `pushNotificationsBatch`;
 * exercised end-to-end by the channel-activity route test.)
 */
import { describe, it, expect, vi } from 'vitest';
import { getNotificationEmitter, setNotificationBackend } from '../src/notifications/emitter.js';
import { openStorage } from '../src/storage/index.js';
import type { NotificationRecord } from '../src/types.js';

function mk(uid: string): Omit<NotificationRecord, 'notificationId' | 'createdAt' | 'status'> {
  return { tenantId: 't', recipientUserId: uid, type: 'chat.channel_post', priority: 'normal', title: '#c', message: `msg ${uid}` };
}

describe('emitMany — per-item isolation (NOTIF-3)', () => {
  it('a single insert failure does not strand the other recipients; only inserted rows are returned', async () => {
    // A REAL storage, with one recipient's insert made to fail (no hand-typed fake).
    const storage = await openStorage('memory://');
    const real = storage.insertNotification.bind(storage);
    vi.spyOn(storage, 'insertNotification').mockImplementation(async (r: NotificationRecord) => {
      if (r.recipientUserId === 'boom') throw new Error('db transient');
      return real(r);
    });
    setNotificationBackend(storage);

    const out = await getNotificationEmitter().emitMany([mk('u1'), mk('boom'), mk('u3')]);

    // boom failed; the rest still landed — read back from the store, not the spy.
    const rows = await storage.listNotifications({ tenantId: 't', limit: 10 });
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual(['u1', 'u3']);
    expect(out.map((r) => r.recipientUserId)).toEqual(['u1', 'u3']); // only landed rows returned
  });

  it('an empty input is a no-op', async () => {
    const storage = await openStorage('memory://');
    const insert = vi.spyOn(storage, 'insertNotification');
    setNotificationBackend(storage);
    expect(await getNotificationEmitter().emitMany([])).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
  });
});
