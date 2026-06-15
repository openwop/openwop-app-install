/**
 * Thin HTTP client for the notification routes at
 * `/v1/host/openwop-app/notifications/*`.
 *
 * Mirrors the conventions of `runsClient.ts` / `interruptsClient.ts`:
 *   - re-uses `authedHeaders()` + `fetchOpts()` from config so all auth
 *     modes (bearer / cookie) flip via the same env knob
 *   - throws on non-2xx so callers can surface errors via React state
 *
 * Response shapes are validated at the boundary via `isNotification` —
 * a hand-written type guard rather than a runtime-validation library,
 * so the FE stays zero-dep on `zod` / `valibot`. The guard rejects
 * malformed BE payloads instead of casting blindly, so downstream
 * UI code can assume the shape it claims.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';
import { readSseFrames } from '../client/sseFrames.js';
import { defaultPreferences } from './types.js';
import { sanitizeQuietHours, sanitizeTypePrefs } from './preferences.js';
import type { Notification, NotificationPreferences, NotificationPriority, NotificationStatus } from './types.js';

const VALID_STATUSES: readonly NotificationStatus[] = ['unread', 'read', 'archived'];
const VALID_PRIORITIES: readonly NotificationPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Runtime type guard for a Notification wire object. Rejects payloads
 *  with the wrong shape, unknown status/priority, or missing required
 *  fields. Used at every REST + SSE boundary. */
export function isNotification(x: unknown): x is Notification {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r.notificationId !== 'string') return false;
  if (typeof r.type !== 'string') return false;
  if (typeof r.title !== 'string') return false;
  if (typeof r.message !== 'string') return false;
  if (typeof r.createdAt !== 'string') return false;
  if (typeof r.status !== 'string' || !(VALID_STATUSES as readonly string[]).includes(r.status)) return false;
  if (typeof r.priority !== 'string' || !(VALID_PRIORITIES as readonly string[]).includes(r.priority)) return false;
  return true;
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, fetchOpts({
    ...init,
    headers: { ...authedHeaders(), ...(init?.headers ?? {}) },
  }));
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export interface ListNotificationsParams {
  status?: NotificationStatus | readonly NotificationStatus[];
  includeArchived?: boolean;
  limit?: number;
}

export async function listNotifications(
  params: ListNotificationsParams = {},
): Promise<readonly Notification[]> {
  const q = new URLSearchParams();
  if (params.status) {
    const s = Array.isArray(params.status) ? params.status.join(',') : (params.status as string);
    q.set('status', s);
  }
  if (params.includeArchived) q.set('includeArchived', 'true');
  if (params.limit != null) q.set('limit', String(params.limit));
  const qs = q.toString();
  const body = await jsonFetch<{ notifications: unknown }>(
    `/v1/host/openwop-app/notifications${qs ? `?${qs}` : ''}`,
  );
  if (!Array.isArray(body.notifications)) return [];
  // Drop any rows the BE returned in an unexpected shape (forward-
  // compatibility — a new BE that adds a status the FE doesn't yet
  // recognize just hides the row instead of crashing the panel).
  return body.notifications.filter(isNotification);
}

async function mutateAndValidate(path: string, method: 'POST' | 'DELETE' = 'POST'): Promise<Notification> {
  const body = await jsonFetch<unknown>(path, { method });
  if (!isNotification(body)) {
    throw new Error(`${path} returned a malformed notification payload`);
  }
  return body;
}

export async function markNotificationRead(notificationId: string): Promise<Notification> {
  return mutateAndValidate(
    `/v1/host/openwop-app/notifications/${encodeURIComponent(notificationId)}/read`,
  );
}

export async function markNotificationUnread(notificationId: string): Promise<Notification> {
  return mutateAndValidate(
    `/v1/host/openwop-app/notifications/${encodeURIComponent(notificationId)}/unread`,
  );
}

export async function archiveNotification(notificationId: string): Promise<Notification> {
  return mutateAndValidate(
    `/v1/host/openwop-app/notifications/${encodeURIComponent(notificationId)}/archive`,
  );
}

export async function deleteNotification(notificationId: string): Promise<void> {
  const res = await fetch(
    `${config.baseUrl}/v1/host/openwop-app/notifications/${encodeURIComponent(notificationId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok) throw new Error(`delete returned ${res.status}`);
}

export async function markAllNotificationsRead(): Promise<{ updated: number }> {
  return jsonFetch<{ updated: number }>(
    `/v1/host/openwop-app/notifications:mark-all-read`,
    { method: 'POST' },
  );
}

/**
 * Durable, server-backed preferences (ADR 0010 Phase 2). The BE keys them per
 * (tenant, user) and returns the seeded defaults when a user has never saved —
 * so a first GET is a valid blob, not a 404. Requires sign-in; an anonymous
 * caller gets 401 (the store treats that as "use the local cache").
 */
export async function getPreferences(): Promise<NotificationPreferences> {
  const body = await jsonFetch<{ preferences: unknown }>('/v1/host/openwop-app/notifications/preferences');
  return normalizeServerPreferences(body.preferences);
}

export async function putPreferences(prefs: NotificationPreferences): Promise<NotificationPreferences> {
  const body = await jsonFetch<{ preferences: unknown }>('/v1/host/openwop-app/notifications/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      globalMute: prefs.globalMute,
      types: prefs.types,
      quietHours: prefs.quietHours,
    }),
  });
  return normalizeServerPreferences(body.preferences);
}

/** Coerce a server preferences object into the FE `NotificationPreferences`
 *  shape. The server stamps extra fields (tenantId, userId, updatedAt) and a
 *  legacy/hand-edited durable row could hold a malformed field — coerce each
 *  field (via the shared `sanitize*` helpers, so this matches the localStorage
 *  read path) so the predicate code never sees garbage. The per-element day +
 *  HH:MM checks mirror the backend's write-time validation. */
function normalizeServerPreferences(raw: unknown): NotificationPreferences {
  const d = defaultPreferences();
  if (raw === null || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    globalMute: typeof r.globalMute === 'boolean' ? r.globalMute : d.globalMute,
    types: sanitizeTypePrefs(r.types),
    quietHours: sanitizeQuietHours(r.quietHours),
    version: 1,
  };
}

/** Handlers for the live notification SSE subscription. */
export interface NotificationStreamHandlers {
  /** A live `notification` frame arrived and passed shape validation. */
  onNotification: (n: Notification) => void;
  /** Fired on every successful (re)connect. The store backfills via REST
   *  here: the BE notification stream has NO Last-Event-ID replay (unlike
   *  the run-event stream), so any rows emitted while we were disconnected
   *  would otherwise be lost — a refresh on (re)open closes that gap. */
  onOpen?: () => void;
  /** Fired when the live connection drops (network blip, 5xx, proxy
   *  hangup, or a terminal non-2xx like a Cloud-Run 410 on a recycled
   *  instance). The reader keeps retrying with capped backoff, so this is
   *  a transient "stale, reconnecting" signal — NOT a terminal failure. */
  onError?: () => void;
}

/** Backoff bounds for the persistent reconnect loop. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** A connection that survives at least this long is treated as "healthy":
 *  its drop resets the backoff escalation. A connection that dies sooner
 *  (e.g. immediate 410, or accept-then-FIN) escalates toward the cap so a
 *  persistently-broken endpoint isn't hammered. */
const HEALTHY_UPTIME_MS = 10_000;

/**
 * Subscribe to live notification events via SSE. Returns a cleanup.
 *
 * Fetch + ReadableStream (the same transport as the run-event stream),
 * NOT native `EventSource`. `EventSource` is terminal on any non-200
 * response per the WHATWG spec — a Cloud-Run `410 Gone` on a recycled
 * instance would silently kill the feed with no reconnect — and it can't
 * carry an `Authorization` header (so bearer/dev mode got no live feed).
 * This reader:
 *   - reconnects forever with capped-exponential backoff + jitter (the
 *     feed is session-long, so it must NOT give up after N like the
 *     run-event stream, whose run terminates),
 *   - fires `onOpen` on every (re)connect so the store can REST-backfill
 *     the gap (no Last-Event-ID replay on this endpoint),
 *   - carries auth the same way the run-event stream does — bearer mode
 *     sends `Authorization`, cookie mode rides `credentials: 'include'`
 *     (so prod's cross-origin Cloud-Run request stays a simple cookie
 *     request with no `Authorization` preflight).
 */
export function subscribeToNotifications(handlers: NotificationStreamHandlers): () => void {
  // Dedicated SSE base URL — same rationale as the run-event stream: the
  // Firebase Hosting proxy on prod buffers SSE, so we hit Cloud Run direct.
  const url = `${config.sseBaseUrl}/v1/host/openwop-app/notifications/stream`;
  const isBearer = config.authMode === 'bearer';
  const abort = new AbortController();
  let closed = false;
  let attempt = 0;

  // Abortable sleep — resolves early on cleanup so unsubscribe is prompt.
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });

  void (async () => {
    while (!closed) {
      let connectedAt: number | null = null;
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...(isBearer ? authedHeaders() : {}),
          },
          // Cookie mode (prod, cross-origin Cloud Run) authenticates via the
          // `openwop.session` cookie — same path the run-event stream proved.
          credentials: isBearer ? 'same-origin' : 'include',
          signal: abort.signal,
        });
        if (!res.ok || res.body === null) {
          throw new Error(`notifications stream → HTTP ${res.status}`);
        }
        connectedAt = Date.now();
        handlers.onOpen?.();
        for await (const frame of readSseFrames(res.body, abort.signal)) {
          if (frame.event !== 'notification') continue; // skip heartbeat/unknown
          try {
            const data: unknown = JSON.parse(frame.data);
            // Drop malformed/forward-compat frames rather than crash the feed.
            if (isNotification(data)) handlers.onNotification(data);
          } catch {
            /* skip malformed frame */
          }
        }
        // Body ended without throwing (server closed / instance recycled).
      } catch {
        // Network drop, non-2xx, or proxy hangup — fall through to reconnect.
      }
      if (closed) return;
      handlers.onError?.();
      // Escalate backoff only when the connection was short-lived; a healthy
      // session that merely dropped reconnects fast (attempt → 1).
      const healthy = connectedAt !== null && Date.now() - connectedAt >= HEALTHY_UPTIME_MS;
      attempt = healthy ? 1 : attempt + 1;
      const ceil = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt - 1, 10));
      // Full jitter over [ceil/2, ceil] — de-syncs reconnect stampedes.
      await sleep(ceil / 2 + Math.random() * (ceil / 2));
    }
  })();

  return () => {
    closed = true;
    abort.abort();
  };
}
