/**
 * Notification store — the FE single source of truth for the bell +
 * panel + /inbox surfaces. Modeled on myndhyve's store
 * (`src/features/notifications/notificationStore.ts`) but trimmed to
 * the openwop demo's scope:
 *
 *   - in-app channel only (no push / email / desktop yet)
 *   - no quiet hours / DND (defer until preferences UI lands)
 *   - openwop's BE is the system of record; this store mirrors a slice
 *
 * Lifecycle:
 *   - `connect()` runs once at app mount: hydrate via REST, then attach
 *     the SSE feed for live deltas. The fetch-stream client reconnects
 *     internally with capped backoff and REST-backfills each reconnect
 *     gap (`onOpen` → `refresh()`), so the feed self-heals without a
 *     page reload.
 *   - `disconnect()` clears the SSE subscription.
 *   - Status mutations (read / archive / delete) update local state
 *     optimistically AND fire-and-forget the REST call; on failure,
 *     we roll back + surface an error.
 */

import { create } from 'zustand';
import {
  archiveNotification as archiveRemote,
  deleteNotification as deleteRemote,
  listNotifications,
  markAllNotificationsRead as markAllRemote,
  archiveReadNotifications as archiveReadRemote,
  bulkReadNotifications as bulkReadRemote,
  markNotificationRead as markReadRemote,
  markNotificationUnread as markUnreadRemote,
  subscribeToNotifications,
  getPreferences as getPreferencesRemote,
  putPreferences as putPreferencesRemote,
} from './notificationsClient.js';
import {
  loadPreferences,
  savePreferences,
  setPreferencesDirty,
  getPreferencesDirty,
  shouldCountUnread,
  shouldFireDesktop,
} from './preferences.js';
import { REVIEW_UPDATED_SIGNAL_TYPE } from './types.js';
import { isSafeActionUrl } from './actionLabels.js';
import { announce } from '../ui/announce.js';
import i18n from '../i18n/index.js';
import { publishReviewSignal } from './signalBus.js';
import {
  disablePush as disablePushApi,
  enablePush as enablePushApi,
  getCurrentSubscription,
  getPushConfig,
} from './pushSubscription.js';
import type { Notification, NotificationPreferences, NotificationStatus } from './types.js';
import {
  isNativeShell,
  nativeNotify,
  setNativeBadgeCount,
  onNativeNotificationActivated,
} from '../native/nativeBridge.js';

/**
 * Live SSE connection status, surfaced to the UI so the bell / panel
 * can show a "reconnecting" chip when the stream drops. The fetch-stream
 * client reconnects with capped backoff, so `error` is transient — the
 * next successful (re)connect (`onOpen`) flips us back to `connected`.
 */
export type NotificationConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Browser-side desktop notification permission, mirroring the Web
 * Notifications API's `Notification.permission` value. We track this
 * in the store so the UI can show an "Enable desktop alerts" button
 * when `'default'`, a "Blocked by browser" hint when `'denied'`, and
 * hide the affordance when `'granted'`.
 *
 * `'unsupported'` is the SSR / non-browser path — older Safari + any
 * environment where `window.Notification` is undefined.
 */
export type DesktopPermission = 'default' | 'granted' | 'denied' | 'unsupported';

interface NotificationStoreState {
  notifications: Notification[];
  unreadCount: number;
  panelOpen: boolean;
  loading: boolean;
  connectionStatus: NotificationConnectionStatus;
  desktopPermission: DesktopPermission;
  /** Web Push subscription state.
   *    'unsupported' — browser lacks Push API / service worker support
   *    'disabled'    — BE has no VAPID config (push fanout no-ops)
   *    'available'   — supported + BE configured, not subscribed
   *    'subscribed'  — supported + subscribed (events arrive via SW)
   *    'unknown'     — not yet probed (initial render) */
  pushStatus: 'unsupported' | 'disabled' | 'available' | 'subscribed' | 'unknown';
  /** Per-user notification preferences (item 5+6). Loaded from
   *  localStorage at store-creation time; persisted to localStorage on
   *  every `updatePreferences` call. */
  preferences: NotificationPreferences;
  /** True when the local prefs hold a change not yet persisted to the durable
   *  server store (a PUT failed / offline). `hydratePreferences` re-pushes the
   *  local blob instead of adopting the server copy while this is set, so an
   *  offline edit isn't silently clobbered on reconnect (ADR 0010 Phase 2). */
  preferencesUnsynced: boolean;
  /** When true, the preferences subdrawer is open inside the panel. */
  preferencesOpen: boolean;
  error: string | null;
  /** Active SSE cleanup, if any. */
  _sseCleanup: (() => void) | null;
}

interface NotificationStoreActions {
  // Lifecycle
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;

  // UI
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  // Mutations
  markAsRead: (id: string) => Promise<void>;
  markAsUnread: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** R3 IB-R2-2 — archive every READ row (one request); state re-syncs via refresh. */
  archiveRead: () => Promise<void>;
  /** R3 IB-R2-2 — mark the given rows read (one request); optimistic like markAllRead. */
  markRead: (ids: readonly string[]) => Promise<void>;

  // Desktop notifications (Web Notifications API)
  /** Prompt the browser for desktop-notification permission. MUST be
   *  called inside a user gesture (click handler) — browsers reject
   *  programmatic permission requests outside that context. Returns
   *  the resulting permission state. */
  requestDesktopPermission: () => Promise<DesktopPermission>;
  /** Refresh `desktopPermission` from `window.Notification.permission`.
   *  Used at mount so the store reflects the browser's persisted state
   *  (the user may have granted in a prior session). */
  syncDesktopPermission: () => void;

  // Preferences (items 5 + 6)
  /** Open the preferences subdrawer inside the panel. */
  openPreferences: () => void;
  /** Close the preferences subdrawer. */
  closePreferences: () => void;
  /** Replace the preferences blob. Persisted to the durable server store
   *  (ADR 0010 Phase 2) AND mirrored to localStorage as a synchronous offline
   *  cache. Use the helper `updatePreference` for typed-shape mutations. */
  updatePreferences: (next: NotificationPreferences) => void;
  /** ADR 0192 D7 — set-symmetric mute toggle for one conversation (channel/
   *  group). Rides `updatePreferences` (same optimistic-local + durable-PUT +
   *  dirty-marker machinery). */
  toggleConversationMute: (conversationId: string) => void;
  /** Pull the authoritative server preferences (cross-device) and adopt them,
   *  replacing the localStorage bootstrap value. Silent no-op for an anonymous
   *  caller (401) or when offline — the local cache stays in effect. */
  hydratePreferences: () => Promise<void>;

  // Web Push (item 7)
  /** Probe browser + BE for push availability and current subscription
   *  state. Cheap, but runs HTTP; call from a useEffect on panel mount. */
  syncPushStatus: () => Promise<void>;
  /** Subscribe the current browser to push. MUST be called inside a
   *  user gesture (click handler). Returns true on success. */
  enablePush: () => Promise<boolean>;
  /** Unsubscribe + delete the BE row. */
  disablePush: () => Promise<void>;

  // Internal — called by SSE handler
  _ingest: (n: Notification) => void;
}

type NotificationStore = NotificationStoreState & NotificationStoreActions;


/** R2 IB-SP-11 — surgical rollback. Restoring the WHOLE pre-mutation array
 *  silently dropped any row `_ingest`ed during the in-flight request. Restore
 *  only the mutated row (re-inserting it in createdAt order if it was
 *  removed), leaving concurrent arrivals intact. */
function rollbackRow(current: Notification[], prev: Notification[], id: string): Notification[] {
  const prevRow = prev.find((n) => n.notificationId === id);
  if (!prevRow) return current.filter((n) => n.notificationId !== id); // didn't exist before → drop the optimistic row
  if (current.some((n) => n.notificationId === id)) {
    return current.map((n) => (n.notificationId === id ? prevRow : n));
  }
  const restored = [...current, prevRow];
  // localeCompare is consistent on ties (returns 0), so equal timestamps keep
  // their relative order under V8's stable sort.
  restored.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return restored;
}

function recountUnread(list: Notification[], prefs: NotificationPreferences): number {
  // Muted types still appear in the panel but don't bump the bell
  // badge. Mirror the myndhyve pattern: visibility ≠ unread weight.
  return list.filter((n) => n.status === 'unread' && shouldCountUnread(n, prefs)).length;
}

/**
 * Read the current desktop-notification permission from the browser,
 * normalized to our `DesktopPermission` union. Returns `'unsupported'`
 * when `window.Notification` is missing (SSR, very-old Safari, headless
 * test envs).
 */
function readDesktopPermission(): DesktopPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return 'unsupported';
  }
  // `Notification.permission` is exactly the three values we want.
  const p = window.Notification.permission;
  if (p === 'granted' || p === 'denied') return p;
  return 'default';
}

/**
 * Fire an OS-level desktop toast for an in-app notification.
 *
 * Uses the Web Notifications API — gated on `permission === 'granted'`.
 * `tag` is set to the notificationId so the same row arriving twice
 * (SSE reconnect + REST refresh racing) only surfaces one OS toast.
 * Click-through navigates the focused window to `actionUrl` so users
 * can resume an approval flow without hunting through the panel.
 *
 * Best-effort: any browser API failure (some Chromium variants reject
 * notifications in cross-origin frames) is swallowed — the in-app
 * surface still works regardless.
 */
/**
 * Navigate the focused window to an in-app path without a full page reload.
 * Shared by the browser click handler and the native-shell activation handler
 * (ADR 0181) so the two paths can never drift.
 */
function navigateToActionUrl(actionUrl: string): void {
  // (2026-07 vuln-scan) Enforce the same-origin/relative guard the in-app render
  // sites use, HERE — so no consumption path (desktop toast, native shell) can
  // regress into an open redirect. A cross-origin actionUrl would otherwise fall
  // through pushState's SecurityError to `location.href = actionUrl` (off-origin).
  if (!isSafeActionUrl(actionUrl)) return;
  // CMNT-UX-4 — this used to be a bare `window.history.pushState`, which
  // react-router does NOT observe (it listens for `popstate`): an OS-toast /
  // native-shell click updated the address bar without navigating the SPA. Worst
  // on a same-route deep-link like `/comments?…`, where nothing at all appears to
  // happen. Route through the registered router navigator when the app shell has
  // mounted; the pushState path stays as the fallback for the pre-mount window
  // (and for the shell-less public routes, which have no router navigator).
  const nav = routerNavigator;
  if (nav) { nav(actionUrl); return; }
  // History API navigation rather than location.href so we don't do a full
  // page reload when the SPA is already loaded.
  try { window.history.pushState({}, '', actionUrl); }
  catch { window.location.href = actionUrl; }
}

/**
 * The app shell's router navigator (CMNT-UX-4). `notificationStore` is a plain
 * module, so it cannot call `useNavigate`; `NotificationNavigator` registers the
 * live one on mount and clears it on unmount. Null before the authed shell
 * mounts — `navigateToActionUrl` falls back to `pushState` in that window rather
 * than dropping the navigation.
 */
type ActionUrlNavigator = (path: string) => void;
let routerNavigator: ActionUrlNavigator | null = null;
export function registerActionUrlNavigator(nav: ActionUrlNavigator | null): void {
  routerNavigator = nav;
}
/** Test seam: the path `navigateToActionUrl` would take, without a browser. */
export function __navigateToActionUrlForTest(actionUrl: string): void { navigateToActionUrl(actionUrl); }

function fireDesktopNotification(n: Notification): void {
  // Native-shell path (ADR 0181 Phase A): when running inside the desktop /
  // mobile shell, route the OS notification through the injected bridge — it
  // delivers a richer OS toast and click-routing than the Web API — instead of
  // `window.Notification`. Click activation is handled once, app-wide, by the
  // `onNativeNotificationActivated` subscription at module load below.
  if (isNativeShell()) {
    void nativeNotify({
      title: n.title,
      body: n.message,
      tag: n.notificationId,
      // Only forward a SAFE (relative, same-origin) path to the native shell.
      ...(isSafeActionUrl(n.actionUrl) ? { navigatePath: n.actionUrl } : {}),
      requireInteraction: n.priority === 'urgent',
    });
    return;
  }
  // Browser path — Web Notifications (unchanged), gated on granted permission.
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
  if (window.Notification.permission !== 'granted') return;
  try {
    const desktop = new window.Notification(n.title, {
      body: n.message,
      tag: n.notificationId,
      icon: '/OpenWOP.svg',
      // Urgent rows keep the toast on screen until the user dismisses.
      // Browsers ignore this for non-urgent — fine, the default 5s
      // auto-dismiss is the right behavior for low-priority rows.
      requireInteraction: n.priority === 'urgent',
    });
    desktop.onclick = () => {
      window.focus();
      if (n.actionUrl) navigateToActionUrl(n.actionUrl);
      desktop.close();
    };
  } catch {
    /* defense-in-depth — browser API rejection shouldn't break the feed */
  }
}

function applyStatus(list: Notification[], id: string, status: NotificationStatus, now: string): Notification[] {
  return list.map((n) => {
    if (n.notificationId !== id) return n;
    return {
      ...n,
      status,
      ...(status === 'read' && !n.readAt ? { readAt: now } : {}),
      ...(status === 'archived' && !n.archivedAt ? { archivedAt: now } : {}),
      ...(status === 'unread' ? { readAt: undefined } : {}),
    };
  });
}

/** Monotonic connect/disconnect epoch. `connect()` captures it before its
 *  hydrate await and bails if it moved (a `disconnect()` or newer `connect()`
 *  ran during the await). Without this, the late-resuming connect attached an
 *  SSE subscription whose cleanup handle was then OVERWRITTEN by the newer
 *  caller — an unreachable reconnect-forever stream that held a server SSE
 *  slot until the tab closed. Orphans accumulated to the per-tenant stream
 *  cap (the 2026-07-14 429 incident on `notifications/stream`). */
let connectEpoch = 0;

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  panelOpen: false,
  loading: false,
  connectionStatus: 'disconnected',
  desktopPermission: readDesktopPermission(),
  pushStatus: 'unknown',
  preferences: loadPreferences(),
  preferencesUnsynced: getPreferencesDirty(),
  preferencesOpen: false,
  error: null,
  _sseCleanup: null,

  async connect() {
    if (get().connectionStatus === 'connected' || get().connectionStatus === 'connecting') return;
    const epoch = ++connectEpoch;
    set({ loading: true, connectionStatus: 'connecting', error: null });
    try {
      // R2 IB-SP-1 (Blocker) — WITHOUT includeArchived the Archived tabs
      // filtered a list that structurally never contained archived rows: an
      // archived notification vanished on the next refresh while still in the
      // DB, and the copy promised the opposite. The backend + client have
      // supported this flag all along; the store never passed it.
      const list = await listNotifications({ limit: 100, includeArchived: true });
      // Superseded during the await (disconnect() or a newer connect() ran)?
      // Then this call must not touch state and — critically — must not
      // attach a stream: the newer caller's `_sseCleanup` write below would
      // orphan it (see `connectEpoch`).
      if (epoch !== connectEpoch) return;
      set({
        notifications: [...list],
        unreadCount: recountUnread([...list], get().preferences),
        loading: false,
        connectionStatus: 'connected',
      });
      // Adopt the authoritative, cross-device server preferences (ADR 0010
      // Phase 2). Fire-and-forget so a slow/anon prefs fetch never blocks the
      // live feed — it recounts unread when it lands.
      void get().hydratePreferences();
      // Attach SSE after hydrate. The fetch-stream client reconnects with
      // capped backoff, so a transient `error` flip doesn't mean the feed
      // is dead — `onOpen` flips back to `connected` on the next connect.
      // `primed` skips the redundant backfill on the FIRST open (the
      // `listNotifications` above just hydrated); every reconnect after
      // that REST-backfills the gap, since this BE stream has no replay.
      let primed = false;
      const cleanup = subscribeToNotifications({
        onNotification: (n) => {
          // ADR 0074 — a `review.updated` frame is a transient cache hint, NOT
          // an inbox row. Route it to the signal bus (the review-status store
          // consumes it) and never `_ingest` it: no bell row, no unread bump.
          if (n.type === REVIEW_UPDATED_SIGNAL_TYPE) {
            publishReviewSignal(n);
            if (get().connectionStatus !== 'connected') set({ connectionStatus: 'connected' });
            return;
          }
          get()._ingest(n);
          if (get().connectionStatus !== 'connected') {
            set({ connectionStatus: 'connected' });
          }
        },
        onOpen: () => {
          set({ connectionStatus: 'connected' });
          if (primed) void get().refresh();
          primed = true;
        },
        onError: () => set({ connectionStatus: 'error' }),
      });
      // R2 IB-SP-3 — the emitter is process-local and its own docblock says
      // the client backfills on tab focus; nothing did. On multi-instance
      // deploys a notification emitted on another instance never reached a
      // connected client until the stream happened to drop. Refresh whenever
      // the tab becomes visible (cheap: one list read, only while connected).
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') void get().refresh();
      };
      document.addEventListener('visibilitychange', onVisible);
      const composedCleanup = (): void => { document.removeEventListener('visibilitychange', onVisible); cleanup(); };
      // Belt-and-braces: never overwrite a live cleanup handle — closing the
      // straggler here is what keeps a logic slip above from leaking a stream.
      const prior = get()._sseCleanup;
      if (prior) prior();
      set({ _sseCleanup: composedCleanup });
    } catch (err) {
      // A stale connect's failure must not clobber the state a newer
      // connect/disconnect owns.
      if (epoch !== connectEpoch) return;
      set({
        loading: false,
        connectionStatus: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  disconnect() {
    connectEpoch++; // invalidate any connect() still awaiting its hydrate
    const c = get()._sseCleanup;
    if (c) c();
    set({ _sseCleanup: null, connectionStatus: 'disconnected' });
  },

  async refresh() {
    try {
      const list = await listNotifications({ limit: 100, includeArchived: true }); // R2 IB-SP-1
      set({
        notifications: [...list],
        unreadCount: recountUnread([...list], get().preferences),
        error: null,
      });
      // R2 review F1 — if the INITIAL hydrate failed, connect() bailed before
      // ever attaching the stream, so the "reconnecting / refreshes
      // automatically" copy was a lie: nothing was reconnecting. A successful
      // read with no stream attached re-runs connect() so the claim is true.
      if (!get()._sseCleanup && get().connectionStatus !== 'connecting') void get().connect();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  openPanel() { set({ panelOpen: true }); },
  closePanel() { set({ panelOpen: false }); },
  togglePanel() { set((s) => ({ panelOpen: !s.panelOpen })); },

  async markAsRead(id) {
    const prev = get().notifications;
    const next = applyStatus(prev, id, 'read', new Date().toISOString());
    set({ notifications: next, unreadCount: recountUnread(next, get().preferences) });
    try { await markReadRemote(id); } catch (err) {
      set((st) => {
        const rolled = rollbackRow(st.notifications, prev, id);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async markAsUnread(id) {
    const prev = get().notifications;
    const next = applyStatus(prev, id, 'unread', new Date().toISOString());
    set({ notifications: next, unreadCount: recountUnread(next, get().preferences) });
    try { await markUnreadRemote(id); } catch (err) {
      set((st) => {
        const rolled = rollbackRow(st.notifications, prev, id);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async archive(id) {
    const prev = get().notifications;
    const next = applyStatus(prev, id, 'archived', new Date().toISOString());
    set({ notifications: next, unreadCount: recountUnread(next, get().preferences) });
    try { await archiveRemote(id); } catch (err) {
      set((st) => {
        const rolled = rollbackRow(st.notifications, prev, id);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async delete(id) {
    const prev = get().notifications;
    const next = prev.filter((n) => n.notificationId !== id);
    set({ notifications: next, unreadCount: recountUnread(next, get().preferences) });
    try { await deleteRemote(id); } catch (err) {
      set((st) => {
        const rolled = rollbackRow(st.notifications, prev, id);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async markAllRead() {
    const prev = get().notifications;
    const now = new Date().toISOString();
    const next: Notification[] = prev.map((n) => n.status === 'unread'
      ? { ...n, status: 'read', readAt: n.readAt ?? now }
      : n);
    set({ notifications: next, unreadCount: 0 });
    try { await markAllRemote(); } catch (err) {
      // R2 IB-SP-11 — restore only the rows WE flipped; rows `_ingest`ed
      // while the request was in flight survive the rollback.
      const flipped = new Map(prev.filter((n) => n.status === 'unread').map((n) => [n.notificationId, n]));
      set((st) => {
        const rolled = st.notifications.map((n) => flipped.get(n.notificationId) ?? n);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async archiveRead() {
    const prev = get().notifications;
    const now = new Date().toISOString();
    const next: Notification[] = prev.map((n) => n.status === 'read'
      ? { ...n, status: 'archived' as const, archivedAt: n.archivedAt ?? now }
      : n);
    set({ notifications: next, unreadCount: recountUnread(next, get().preferences) });
    try { await archiveReadRemote(); } catch (err) {
      // Restore only the rows WE flipped (the IB-SP-11 surgical-rollback shape).
      const flipped = new Map(prev.filter((n) => n.status === 'read').map((n) => [n.notificationId, n]));
      set((st) => {
        const rolled = st.notifications.map((n) => flipped.get(n.notificationId) ?? n);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async markRead(ids) {
    const idSet = new Set(ids);
    const prev = get().notifications;
    const now = new Date().toISOString();
    const next: Notification[] = prev.map((n) => idSet.has(n.notificationId) && n.status === 'unread'
      ? { ...n, status: 'read' as const, readAt: n.readAt ?? now }
      : n);
    set({ notifications: next, unreadCount: recountUnread(next, get().preferences) });
    try { await bulkReadRemote(ids); } catch (err) {
      const flipped = new Map(prev.filter((n) => idSet.has(n.notificationId) && n.status === 'unread').map((n) => [n.notificationId, n]));
      set((st) => {
        const rolled = st.notifications.map((n) => flipped.get(n.notificationId) ?? n);
        return { notifications: rolled, unreadCount: recountUnread(rolled, st.preferences),
                 error: err instanceof Error ? err.message : String(err) };
      });
    }
  },

  async requestDesktopPermission() {
    // The browser permission prompt MUST be called inside a user
    // gesture (click handler). Calling this from a `useEffect` on
    // mount will return 'denied' permanently on most browsers — the
    // panel's "Enable desktop alerts" button is the supported path.
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      set({ desktopPermission: 'unsupported' });
      return 'unsupported';
    }
    try {
      const result = await window.Notification.requestPermission();
      const normalized: DesktopPermission =
        result === 'granted' || result === 'denied' ? result : 'default';
      set({ desktopPermission: normalized });
      return normalized;
    } catch {
      // Some browsers throw if called outside a gesture; treat as denied.
      set({ desktopPermission: 'denied' });
      return 'denied';
    }
  },

  syncDesktopPermission() {
    set({ desktopPermission: readDesktopPermission() });
  },

  openPreferences() { set({ preferencesOpen: true }); },
  closePreferences() { set({ preferencesOpen: false }); },

  async syncPushStatus() {
    // Browser-side support check first — no HTTP if the API isn't here.
    if (typeof window === 'undefined'
        || !('serviceWorker' in navigator)
        || !('PushManager' in window)) {
      set({ pushStatus: 'unsupported' });
      return;
    }
    try {
      const cfg = await getPushConfig();
      if (!cfg.enabled) {
        set({ pushStatus: 'disabled' });
        return;
      }
      const sub = await getCurrentSubscription();
      set({ pushStatus: sub ? 'subscribed' : 'available' });
    } catch {
      set({ pushStatus: 'unknown' });
    }
  },

  async enablePush() {
    try {
      const cfg = await getPushConfig();
      if (!cfg.enabled || !cfg.vapidPublicKey) {
        set({ pushStatus: 'disabled' });
        return false;
      }
      await enablePushApi(cfg.vapidPublicKey);
      set({ pushStatus: 'subscribed' });
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  async disablePush() {
    try {
      await disablePushApi();
      set({ pushStatus: 'available' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  updatePreferences(next) {
    // Optimistic: update state + the local cache synchronously so the panel
    // and the desktop-toast predicate react immediately.
    set({ preferences: next });
    savePreferences(next);
    // Recount unread under the new preference set — a freshly-muted
    // type stops counting; an unmuted type starts counting again.
    set((s) => ({
      unreadCount: s.notifications
        .filter((x) => x.status === 'unread' && shouldCountUnread(x, next))
        .length,
    }));
    // Persist durably to the server (ADR 0010 Phase 2). Mark the cache dirty
    // until the PUT confirms — so a failed/offline write is re-pushed on the
    // next connect rather than being clobbered by the stale server copy.
    setPreferencesDirty(true);
    set({ preferencesUnsynced: true });
    void putPreferencesRemote(next)
      .then(() => {
        // Only clear the marker if no NEWER local edit landed meanwhile (the
        // user may have toggled again before this PUT resolved).
        if (get().preferences === next) {
          setPreferencesDirty(false);
          set({ preferencesUnsynced: false });
        }
      })
      .catch((err) => {
        // Stays dirty (set above) — an anonymous caller's PUT 401s and a
        // signed-in user's offline write retries on reconnect.
        set({ error: err instanceof Error ? err.message : String(err) });
      });
  },

  toggleConversationMute(conversationId) {
    const prefs = get().preferences;
    const muted = new Set(prefs.mutedConversations ?? []);
    if (muted.has(conversationId)) muted.delete(conversationId);
    else muted.add(conversationId);
    get().updatePreferences({ ...prefs, mutedConversations: [...muted] });
  },

  async hydratePreferences() {
    // An unsynced local change must win over the server's stale copy — push it
    // instead of adopting the server blob (else the offline edit is lost).
    if (get().preferencesUnsynced) {
      const local = get().preferences;
      try {
        await putPreferencesRemote(local);
        if (get().preferences === local) {
          setPreferencesDirty(false);
          set({ preferencesUnsynced: false });
        }
      } catch {
        // Still can't reach the server (anon/offline) — keep the local copy
        // and the dirty marker; we retry on the next connect.
      }
      return;
    }
    try {
      const server = await getPreferencesRemote();
      // Defense-in-depth, NOT a fixed incident: the real client cannot return
      // null (`normalizeServerPreferences` falls back to defaults for any
      // non-object), but a null here would make `recountUnread` throw inside a
      // swallowed promise — so the localStorage bootstrap value stands instead.
      if (server === null) return;
      set({ preferences: server });
      savePreferences(server); // refresh the offline cache to match the server
      set((s) => ({
        unreadCount: s.notifications
          .filter((x) => x.status === 'unread' && shouldCountUnread(x, server))
          .length,
      }));
    } catch {
      // Anonymous (401) or offline — the localStorage bootstrap value stands.
    }
  },

  _ingest(n) {
    let isNew = false;
    const prefs = get().preferences;
    set((s) => {
      // De-dupe: SSE can re-deliver if the client reconnects. The BE
      // assigns a stable `notificationId`, so an existing row wins.
      if (s.notifications.some((x) => x.notificationId === n.notificationId)) return s;
      isNew = true;
      const next = [n, ...s.notifications];
      // Unread count respects the preference filter — muted types
      // still SHOW in the panel (so the user can find them later)
      // but don't bump the bell badge.
      return {
        notifications: next,
        unreadCount: next.filter((x) => x.status === 'unread' && shouldCountUnread(x, prefs)).length,
      };
    });
    // Fire the OS toast only for genuinely-new unread rows + when
    // preferences allow it (globalMute / per-type / quiet hours).
    // Permission gating happens inside `fireDesktopNotification`.
    if (isNew && n.status === 'unread' && shouldFireDesktop(n, prefs)) {
      fireDesktopNotification(n);
    }
    // R2 IB-SP-10 (review-corrected) — announce ONLY a genuine arrival: the
    // badge is aria-hidden, so an arriving notification used to say nothing.
    // Announcing here (not from a count-rise effect in the bell) means initial
    // hydrate and preference unmutes stay silent, and the ADR 0363 global
    // region lives OUTSIDE any control (role=button descendants are
    // presentational). Muted types don't bump the badge, so they don't speak.
    if (isNew && n.status === 'unread' && shouldCountUnread(n, prefs)) {
      announce(i18n.t('notifications:arrivalAnnounce', { count: get().unreadCount }));
    }
  },
}));

/** Convenience hook for the bell badge. */
export function useUnreadCount(): number {
  return useNotificationStore((s) => s.unreadCount);
}

// --- Native-shell integration (ADR 0181 Phase A) ---------------------------
// The store stays the SINGLE owner of "unread"; here we mirror that one value
// out to the OS dock / taskbar badge, and route native OS-notification clicks
// back into SPA navigation. Both are no-ops in a plain browser (the bridge
// helpers degrade to nothing when `window.openwopNative` is absent), so this
// module-level wiring is inert outside a native shell and never throws.

// Mirror the authoritative unread count onto the native badge whenever it
// changes. `setNativeBadgeCount(0)` clears it. One subscription, not 13 write
// sites — the store remains the source of truth.
useNotificationStore.subscribe((state, prev) => {
  if (state.unreadCount !== prev.unreadCount) {
    setNativeBadgeCount(state.unreadCount);
  }
});

// Route a native OS-notification click to the path it carried, reusing the
// exact same navigation the browser toast uses. No-op unsubscribe in a browser.
onNativeNotificationActivated((path) => {
  if (path) navigateToActionUrl(path);
});
