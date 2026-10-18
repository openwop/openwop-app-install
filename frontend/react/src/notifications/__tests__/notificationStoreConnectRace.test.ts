/**
 * notificationStore connect/disconnect race — the SSE orphan-stream guard.
 *
 * `connect()` awaits its REST hydrate before attaching the SSE subscription.
 * A `disconnect()` + re-`connect()` during that await used to let the STALE
 * connect resume and subscribe anyway; the newer connect then overwrote
 * `_sseCleanup`, leaving the stale subscription unreachable — and
 * `subscribeToNotifications` reconnects forever by design, so the orphan held
 * a server SSE slot until the tab closed. Orphans accumulated to the
 * per-tenant stream cap (the 2026-07-14 `notifications/stream` 429 incident).
 * These tests pin the epoch guard: after any interleaving, at most ONE
 * subscription is live and `disconnect()` closes it.
 *
 * DOUBLE GUARD: `connect()` also closes any prior `_sseCleanup` before storing
 * its own (belt-and-braces). With the epoch bail removed, that second guard
 * still leaves ONE live subscription in case 1 — so a live-count alone cannot
 * witness the epoch guard there. Case 1 therefore also asserts the stale
 * connect never SUBSCRIBED at all (the subscribe call count).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Deferred-hydrate + subscription-counting client mock. `resolvers` lets a
// test hold each connect() at its hydrate await and release them in any order.
const resolvers: Array<(v: unknown[]) => void> = [];
let liveSubscriptions = 0;

vi.mock('../notificationsClient.js', () => ({
  listNotifications: vi.fn(() => new Promise<unknown[]>((res) => { resolvers.push(res); })),
  subscribeToNotifications: vi.fn(() => {
    liveSubscriptions += 1;
    return () => { liveSubscriptions -= 1; };
  }),
  archiveNotification: vi.fn(async () => undefined),
  deleteNotification: vi.fn(async () => undefined),
  markAllNotificationsRead: vi.fn(async () => undefined),
  markNotificationRead: vi.fn(async () => undefined),
  markNotificationUnread: vi.fn(async () => undefined),
  archiveReadNotifications: vi.fn(async () => ({ updated: 0 })),
  bulkReadNotifications: vi.fn(async () => ({ updated: 0 })),
  // The real client never returns null (it falls back to defaults).
  getPreferences: vi.fn(async () => defaultPreferences()),
  putPreferences: vi.fn(async () => undefined),
}));

import { useNotificationStore } from '../notificationStore.js';
import { subscribeToNotifications } from '../notificationsClient.js';
import { defaultPreferences } from '../types.js';

describe('notificationStore connect/disconnect race (orphaned-stream guard)', () => {
  beforeEach(() => {
    resolvers.length = 0;
    liveSubscriptions = 0;
    vi.mocked(subscribeToNotifications).mockClear();
    // Reset the singleton's lifecycle slice between cases.
    useNotificationStore.setState({ connectionStatus: 'disconnected', _sseCleanup: null, loading: false, error: null });
  });

  it('disconnect + reconnect during the hydrate await leaves exactly ONE live subscription', async () => {
    const s = () => useNotificationStore.getState();
    const first = s().connect();      // held at its hydrate await
    s().disconnect();                 // supersedes the in-flight connect
    const second = s().connect();     // the caller that should own the stream
    expect(resolvers.length).toBe(2);
    resolvers[0]!([]);                // stale connect resumes… and must bail
    resolvers[1]!([]);                // fresh connect resumes and subscribes
    await Promise.all([first, second]);

    expect(liveSubscriptions).toBe(1); // pre-fix: 2 (one orphaned forever)
    // The stale connect bailed BEFORE subscribing (not subscribed-then-closed).
    expect(subscribeToNotifications).toHaveBeenCalledTimes(1);
    expect(s().connectionStatus).toBe('connected');

    s().disconnect();                  // …and the survivor is actually closable
    expect(liveSubscriptions).toBe(0);
  });

  it('a disconnect with no reconnect kills an in-flight connect entirely', async () => {
    const s = () => useNotificationStore.getState();
    const inflight = s().connect();
    s().disconnect();
    resolvers[0]!([]);
    await inflight;

    expect(liveSubscriptions).toBe(0);                 // pre-fix: 1, unreachable
    expect(s().connectionStatus).toBe('disconnected'); // stale connect didn't flip state back
  });

  it('plain connect → disconnect still works (no regression)', async () => {
    const s = () => useNotificationStore.getState();
    const p = s().connect();
    resolvers[0]!([]);
    await p;
    expect(liveSubscriptions).toBe(1);
    expect(s().connectionStatus).toBe('connected');
    s().disconnect();
    expect(liveSubscriptions).toBe(0);
    expect(s().connectionStatus).toBe('disconnected');
  });
});
