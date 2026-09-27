/**
 * UX_UPGRADE-inbox ROUND 2 — XIB-4.
 *
 *  - IB-SP-11: a FAILED mutation rolls back only the row it touched. The old
 *    whole-array restore silently dropped any notification `_ingest`ed by SSE
 *    while the request was in flight — a real arrival destroyed by an
 *    unrelated failure.
 *  - IB-SP-10: a genuine ARRIVAL is announced through the ADR 0363 global
 *    announcer (fired from `_ingest`, so hydrate/unmute stay silent); the
 *    badge itself is aria-hidden so before this NOTHING spoke.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, act } from '@testing-library/react';

import { useNotificationStore } from '../notificationStore.js';
import { currentAnnouncements, announce } from '../../ui/announce.js';
import type { Notification } from '../types.js';

const row = (id: string, status: Notification['status'], createdAt: string): Notification => ({
  notificationId: id, type: 'system', title: `t-${id}`, message: 'm',
  status, priority: 'normal', createdAt,
} as Notification);

/** A fetch stub whose resolution the test controls — the in-flight window is real. */
function deferredFailingFetch(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal('fetch', vi.fn(async () => {
    await gate;
    return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }));
  return { release };
}

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], unreadCount: 0, error: null, preferences: useNotificationStore.getState().preferences });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('R2 IB-SP-11 — surgical rollback preserves concurrent arrivals', () => {
  it('a failed markAsRead restores THAT row but keeps a row ingested mid-flight', async () => {
    useNotificationStore.setState({ notifications: [row('n1', 'unread', '2026-08-09T00:00:00Z')], unreadCount: 1 });
    const { release } = deferredFailingFetch();
    const pending = useNotificationStore.getState().markAsRead('n1');
    // SSE delivers a new notification while the write is in flight.
    act(() => { useNotificationStore.getState()._ingest(row('n2', 'unread', '2026-08-09T00:01:00Z')); });
    release();
    await pending;
    const st = useNotificationStore.getState();
    const n1 = st.notifications.find((n) => n.notificationId === 'n1');
    expect(n1?.status).toBe('unread'); // rolled back
    // The concurrent arrival SURVIVES the rollback (the old code dropped it).
    expect(st.notifications.some((n) => n.notificationId === 'n2')).toBe(true);
    expect(st.error).toBeTruthy();
  });

  it('a failed delete re-inserts the row without erasing a mid-flight arrival', async () => {
    useNotificationStore.setState({ notifications: [row('n1', 'read', '2026-08-09T00:00:00Z')], unreadCount: 0 });
    const { release } = deferredFailingFetch();
    const pending = useNotificationStore.getState().delete('n1');
    expect(useNotificationStore.getState().notifications).toHaveLength(0); // optimistic removal
    act(() => { useNotificationStore.getState()._ingest(row('n2', 'unread', '2026-08-09T00:01:00Z')); });
    release();
    await pending;
    const ids = useNotificationStore.getState().notifications.map((n) => n.notificationId);
    expect(ids).toContain('n1');
    expect(ids).toContain('n2');
  });

  it('a failed markAllRead restores only the rows it flipped; the arrival stays unread', async () => {
    useNotificationStore.setState({
      notifications: [row('n1', 'unread', '2026-08-09T00:00:00Z'), row('n3', 'read', '2026-08-08T00:00:00Z')],
      unreadCount: 1,
    });
    const { release } = deferredFailingFetch();
    const pending = useNotificationStore.getState().markAllRead();
    act(() => { useNotificationStore.getState()._ingest(row('n2', 'unread', '2026-08-09T00:01:00Z')); });
    release();
    await pending;
    const st = useNotificationStore.getState();
    expect(st.notifications.find((n) => n.notificationId === 'n1')?.status).toBe('unread'); // rolled back
    expect(st.notifications.find((n) => n.notificationId === 'n2')?.status).toBe('unread'); // survived
    expect(st.notifications.find((n) => n.notificationId === 'n3')?.status).toBe('read');   // untouched
    expect(st.unreadCount).toBe(2);
  });
});

describe('R2 IB-SP-10 — a genuine ARRIVAL is announced (global announcer)', () => {
  const baseline = (): string => currentAnnouncements().polite;

  it('_ingest of a new unread row announces the unread count', () => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
    act(() => { useNotificationStore.getState()._ingest(row('a1', 'unread', '2026-08-09T01:00:00Z')); });
    expect(baseline()).toMatch(/1 unread notification/i);
  });

  it('a re-delivered (duplicate) row announces nothing', () => {
    useNotificationStore.setState({ notifications: [row('a1', 'unread', '2026-08-09T01:00:00Z')], unreadCount: 1 });
    act(() => { announce(''); }); // reset the polite channel
    const before = baseline();
    act(() => { useNotificationStore.getState()._ingest(row('a1', 'unread', '2026-08-09T01:00:00Z')); });
    expect(baseline()).toBe(before);
  });

  it('a repeat arrival at the SAME count still re-announces (withRepeatMark, review F4)', () => {
    // 1 unread → read it → a NEW arrival returns the count to 1. The old
    // collapseRepeats implementation went silent here — the exact event the
    // announcement exists for.
    useNotificationStore.setState({ notifications: [row('b1', 'read', '2026-08-09T01:00:00Z')], unreadCount: 0 });
    act(() => { useNotificationStore.getState()._ingest(row('b2', 'unread', '2026-08-09T01:01:00Z')); });
    const first = baseline();
    expect(first).toMatch(/1 unread notification/i);
    act(() => { useNotificationStore.getState().notifications; useNotificationStore.setState((st) => ({
      notifications: st.notifications.map((n) => n.notificationId === 'b2' ? { ...n, status: 'read' as const } : n), unreadCount: 0 })); });
    act(() => { useNotificationStore.getState()._ingest(row('b3', 'unread', '2026-08-09T01:02:00Z')); });
    const second = baseline();
    expect(second).toMatch(/1 unread notification/i);
    expect(second).not.toBe(first); // identity changed → AT re-reads it
  });

  it("the user's own mark-read announces nothing (falls are silent)", () => {
    useNotificationStore.setState({ notifications: [row('c1', 'unread', '2026-08-09T01:00:00Z')], unreadCount: 1 });
    act(() => { announce(''); });
    const before = baseline();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })));
    act(() => { void useNotificationStore.getState().markAsRead('c1'); });
    expect(baseline()).toBe(before);
  });
});

describe('R3 IB-R2-2 — scoped bulk verbs: optimistic flip, surgical rollback, subset-only', () => {
  it('archiveRead flips ONLY read rows optimistically and calls the ONE bulk endpoint', async () => {
    useNotificationStore.setState({ notifications: [
      row('u1', 'unread', '2026-08-14T00:00:00Z'),
      row('r1', 'read', '2026-08-14T00:01:00Z'),
      row('a1', 'archived', '2026-08-14T00:02:00Z'),
    ], unreadCount: 1 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await useNotificationStore.getState().archiveRead();
    const st = useNotificationStore.getState();
    expect(st.notifications.find((n) => n.notificationId === 'r1')?.status).toBe('archived');
    expect(st.notifications.find((n) => n.notificationId === 'u1')?.status).toBe('unread'); // untouched
    expect(calls.length).toBe(1); // ONE request — the whole point vs the N-loop
    expect(calls[0]).toContain(':archive-read');
  });

  it('a failed archiveRead rolls back ONLY the flipped rows; a mid-flight arrival survives', async () => {
    useNotificationStore.setState({ notifications: [row('r1', 'read', '2026-08-14T00:00:00Z')], unreadCount: 0 });
    const { release } = deferredFailingFetch();
    const pending = useNotificationStore.getState().archiveRead();
    act(() => { useNotificationStore.getState()._ingest(row('n2', 'unread', '2026-08-14T00:01:00Z')); });
    release();
    await pending;
    const st = useNotificationStore.getState();
    expect(st.notifications.find((n) => n.notificationId === 'r1')?.status).toBe('read'); // rolled back
    expect(st.notifications.some((n) => n.notificationId === 'n2')).toBe(true);
    expect(st.error).toBeTruthy();
  });

  it('markRead flips only the GIVEN unread ids and sends them in one request body', async () => {
    useNotificationStore.setState({ notifications: [
      row('u1', 'unread', '2026-08-14T00:00:00Z'),
      row('u2', 'unread', '2026-08-14T00:01:00Z'),
      row('r1', 'read', '2026-08-14T00:02:00Z'),
    ], unreadCount: 2 });
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ updated: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await useNotificationStore.getState().markRead(['u1']);
    const st = useNotificationStore.getState();
    expect(st.notifications.find((n) => n.notificationId === 'u1')?.status).toBe('read');
    expect(st.notifications.find((n) => n.notificationId === 'u2')?.status).toBe('unread'); // NOT in the set
    expect(bodies.length).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ ids: ['u1'] });
  });
});
