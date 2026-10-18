/**
 * R2 IB-SP-1 (UX_UPGRADE-inbox, the Blocker) — archived rows are REACHABLE.
 *
 * The Archived tabs filtered a list that structurally never contained
 * archived rows: the store's fetches omitted `includeArchived`, the backend
 * defaults them out, and an archived notification vanished on the next
 * refresh while still in the DB. Round 1's test injected archived rows into
 * a MOCKED store — the exact fixture mask that hid this. These tests run the
 * REAL client (network stubbed at fetch level), so the wiring — the query
 * param on the wire AND the rows landing in the store — is what's pinned.
 *
 * The fetch stub behaves like the backend: archived rows come back ONLY when
 * `includeArchived=true` is on the request. Without that, a store that drops
 * the flag would still receive the archived row and the "lands" assertions
 * could not fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../notificationsClient.js', async (orig) => ({
  ...(await orig<typeof import('../notificationsClient.js')>()),
  // The SSE subscription needs EventSource (absent in jsdom) — mock ONLY it.
  subscribeToNotifications: vi.fn(() => () => {}),
  // The REAL contract: getPreferences resolves a full preferences object
  // (normalizeServerPreferences falls back to defaults — it can never be
  // null). Review F6 caught the earlier `async () => null` mock pinning a
  // contract the client doesn't have.
  getPreferences: vi.fn(async () => defaultPreferences()),
}));

import { useNotificationStore } from '../notificationStore.js';
import { getPreferences } from '../notificationsClient.js';
import { defaultPreferences } from '../types.js';

// Rows in the REAL wire shape (isNotification validates at the boundary —
// an invalid fixture would silently drop and re-create the mask this test
// exists to remove).
const ROWS = [
  { notificationId: 'n1', type: 'system', title: 'Live one', message: 'm', status: 'unread', priority: 'normal', createdAt: '2026-08-09T00:00:00Z' },
  { notificationId: 'n2', type: 'system', title: 'Archived one', message: 'm', status: 'archived', priority: 'normal', createdAt: '2026-08-08T00:00:00Z' },
];

const requestedUrls: string[] = [];

/** The `includeArchived` query value of the list request, or null. */
function listFlag(): string | null {
  const listUrl = requestedUrls.find((u) => /\/notifications\?/.test(u));
  if (!listUrl) return null;
  return new URL(listUrl, 'http://x').searchParams.get('includeArchived');
}

beforeEach(() => {
  requestedUrls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    requestedUrls.push(String(url));
    // Backend default: archived rows are excluded unless asked for.
    const archivedToo = new URL(String(url), 'http://x').searchParams.get('includeArchived') === 'true';
    const rows = archivedToo ? ROWS : ROWS.filter((r) => r.status !== 'archived');
    return new Response(JSON.stringify({ notifications: rows }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  useNotificationStore.setState({ notifications: [], connectionStatus: 'disconnected', _sseCleanup: null, loading: false, error: null });
});
afterEach(() => { vi.unstubAllGlobals(); useNotificationStore.getState().disconnect(); });

describe('archived reachability through the REAL client', () => {
  it('connect() requests includeArchived=true and the archived row lands in the store', async () => {
    // Two writers set `unreadCount`: connect()'s `recountUnread`, then the
    // fire-and-forget `hydratePreferences()` with its own inline filter. Hold
    // the hydrate so each count is read from the writer that produced it
    // (unheld, the hydrate lands first and masks a broken connect() count).
    let releasePrefs!: () => void;
    vi.mocked(getPreferences).mockImplementationOnce(() => new Promise((r) => { releasePrefs = () => r(defaultPreferences()); }));
    await useNotificationStore.getState().connect();
    expect(listFlag(), requestedUrls.join('\n')).toBe('true');
    const list = useNotificationStore.getState().notifications;
    expect(list.some((n) => n.status === 'archived')).toBe(true);
    // …and the archived row does NOT bump the unread badge (connect()'s count)…
    expect(useNotificationStore.getState().unreadCount).toBe(1);
    // …nor after the preferences hydrate recounts.
    // Settle signal: the hydrate ADOPTS the server object (a new identity).
    const before = useNotificationStore.getState().preferences;
    releasePrefs();
    await vi.waitFor(() => expect(useNotificationStore.getState().preferences).not.toBe(before));
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });

  it('refresh() carries the same flag (the panel-open path)', async () => {
    await useNotificationStore.getState().connect(); // hydrate prefs first (real order)
    requestedUrls.length = 0;
    // Empty the store so the archived row can only come from THIS read.
    useNotificationStore.setState({ notifications: [] });
    await useNotificationStore.getState().refresh();
    expect(listFlag()).toBe('true');
    const st = useNotificationStore.getState();
    expect(st.notifications.some((n) => n.status === 'archived'), `error=${st.error} n=${st.notifications.length} urls=${requestedUrls.join('|')}`).toBe(true);
  });
});
