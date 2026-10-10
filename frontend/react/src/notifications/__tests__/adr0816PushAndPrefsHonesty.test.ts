/**
 * ADR 0816 — the inbox's push + preferences UI tells the truth about what the
 * server now does.
 *
 *  NTFUX-1 — the quiet-hours zone survives a server round-trip and every save of
 *            an enabled window carries one (the server applies quiet hours to
 *            background push ONLY with a zone).
 *  NTFUX-2 — a typed subscribe refusal becomes a STATE (no retry that cannot
 *            work), not a generic error.
 *  NTFUX-3 — "push is on" means push reaches THIS caller here; a browser
 *            subscription bound to another account reads as `elsewhere`.
 *  NTFUX-4 — a failed durable save of a signed-in caller's prefs is surfaced;
 *            an anonymous caller's 401 is not a failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeQuietHours } from '../preferences.js';
import { defaultPreferences } from '../types.js';

const push = vi.hoisted(() => ({
  binding: 'none' as 'none' | 'here' | 'elsewhere',
  enableError: null as Error | null,
}));
const putPreferences = vi.hoisted(() => vi.fn(async (p: unknown) => p));

vi.mock('../pushSubscription.js', () => {
  class PushSubscribeError extends Error {
    constructor(readonly status: number, readonly reason: string | undefined) { super(`subscribe returned ${status}`); }
  }
  return {
    PushSubscribeError,
    getPushConfig: vi.fn(async () => ({ enabled: true, vapidPublicKey: 'k' })),
    currentPushBinding: vi.fn(async () => push.binding),
    enablePush: vi.fn(async () => { if (push.enableError) throw push.enableError; return { subscriptionId: 's' }; }),
    disablePush: vi.fn(async () => true),
  };
});
vi.mock('../notificationsClient.js', () => ({
  listNotifications: vi.fn(async () => []),
  subscribeToNotifications: vi.fn(() => () => undefined),
  archiveNotification: vi.fn(async () => undefined),
  deleteNotification: vi.fn(async () => undefined),
  markAllNotificationsRead: vi.fn(async () => undefined),
  markNotificationRead: vi.fn(async () => undefined),
  markNotificationUnread: vi.fn(async () => undefined),
  getPreferences: vi.fn(async () => null),
  putPreferences,
}));

import { useNotificationStore } from '../notificationStore.js';
import { PushSubscribeError } from '../pushSubscription.js';

describe('ADR 0816 NTFUX-1 — the quiet-hours zone is never silently dropped', () => {
  it('a server round-trip keeps the zone', () => {
    const qh = sanitizeQuietHours({ enabled: true, start: '22:00', end: '07:00', days: [1], allowUrgent: true, timezone: 'Europe/Paris' });
    expect(qh.timezone).toBe('Europe/Paris');
  });

  it('an unrelated save (muting one type) of an enabled window still sends a zone', () => {
    const base = defaultPreferences();
    const prefs = { ...base, quietHours: { ...base.quietHours, enabled: true } };
    useNotificationStore.getState().updatePreferences({ ...prefs, globalMute: true });
    const sent = putPreferences.mock.calls.at(-1)![0] as { quietHours: { timezone?: string } };
    expect(typeof sent.quietHours.timezone).toBe('string');
    expect(sent.quietHours.timezone!.length).toBeGreaterThan(0);
  });
});

describe('ADR 0816 NTFUX-2/3 — push state is the server\'s truth', () => {
  beforeEach(() => {
    push.binding = 'none';
    push.enableError = null;
    useNotificationStore.setState({ pushStatus: 'unknown', pushBusy: false, error: null });
    Object.assign(window, { PushManager: function PushManager() { /* present */ } });
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  });

  it('a browser subscription bound to another account reads as elsewhere, not "on"', async () => {
    push.binding = 'elsewhere';
    await useNotificationStore.getState().syncPushStatus();
    expect(useNotificationStore.getState().pushStatus).toBe('elsewhere');
    push.binding = 'here';
    await useNotificationStore.getState().syncPushStatus();
    expect(useNotificationStore.getState().pushStatus).toBe('subscribed');
  });

  it('a refused push service is a state with no retry; a taken endpoint likewise', async () => {
    push.enableError = new PushSubscribeError(400, 'push_endpoint_refused');
    expect(await useNotificationStore.getState().enablePush()).toBe(false);
    expect(useNotificationStore.getState().pushStatus).toBe('refused');
    push.enableError = new PushSubscribeError(409, 'push_endpoint_taken');
    expect(await useNotificationStore.getState().enablePush()).toBe(false);
    expect(useNotificationStore.getState().pushStatus).toBe('taken');
  });

  it('a second click while an enable is in flight does not subscribe twice', async () => {
    const { enablePush: api } = await import('../pushSubscription.js');
    vi.mocked(api).mockClear();
    const a = useNotificationStore.getState().enablePush();
    const b = useNotificationStore.getState().enablePush();
    await Promise.all([a, b]);
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  });
});

describe('ADR 0816 NTFUX-4 — a failed save is said, an anonymous 401 is not', () => {
  it('flags a signed-in failure and clears on the next success', async () => {
    putPreferences.mockRejectedValueOnce(new Error('/host/openwop-app/notifications/preferences → 503'));
    useNotificationStore.getState().updatePreferences({ ...defaultPreferences(), globalMute: true });
    await vi.waitFor(() => expect(useNotificationStore.getState().preferencesSaveFailed).toBe(true));
    const next = { ...defaultPreferences(), globalMute: false };
    useNotificationStore.getState().updatePreferences(next);
    await vi.waitFor(() => expect(useNotificationStore.getState().preferencesSaveFailed).toBe(false));
  });

  it('an anonymous caller\'s 401 is not reported as a failed save', async () => {
    useNotificationStore.setState({ preferencesSaveFailed: false });
    putPreferences.mockRejectedValueOnce(new Error('/host/openwop-app/notifications/preferences → 401'));
    useNotificationStore.getState().updatePreferences({ ...defaultPreferences(), globalMute: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(useNotificationStore.getState().preferencesSaveFailed).toBe(false);
  });
});
