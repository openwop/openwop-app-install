/**
 * Notification preferences — loading, persistence, and the
 * "should this notification fire a desktop toast?" predicate.
 *
 * Storage: localStorage under `openwop:notification-prefs:v1`. As of ADR 0010
 * Phase 2 this is the SYNCHRONOUS BOOTSTRAP CACHE, not the source of truth: the
 * durable, cross-device record lives server-side (`GET`/`PUT
 * /v1/host/openwop-app/notifications/preferences`). The store seeds from this cache
 * for an immediate value, then `hydratePreferences()` adopts the server copy and
 * refreshes the cache; writes go to the server and mirror back here. The cache
 * keeps the desktop-toast predicate working synchronously + offline/anon.
 *
 * Predicate composition (in order):
 *   1. globalMute → suppress everything
 *   2. per-type muted → suppress this type
 *   3. per-type desktop=false → suppress OS toast (in-app still fires)
 *   4. quiet hours active → suppress unless `allowUrgent` + urgent
 */

import {
  defaultPreferences,
  type Notification,
  type NotificationPreferences,
  type NotificationTypePreference,
  type QuietHoursConfig,
} from './types.js';

const STORAGE_KEY = 'openwop:notification-prefs:v1';
/** HH:MM (24h). MUST match the backend's `hhmm` validator
 *  (features/notifications/preferencesRoutes.ts) so a value the server accepts
 *  on PUT round-trips cleanly back through the FE on GET. */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Sibling flag: set when a local prefs write could NOT reach the durable
 *  server store (offline / PUT failed). Persisted (not just in-memory) so a
 *  reload-while-offline doesn't lose the marker — the store re-pushes the local
 *  blob on the next successful connect instead of being clobbered by the stale
 *  server copy (ADR 0010 Phase 2). */
const DIRTY_KEY = 'openwop:notification-prefs-dirty:v1';

/** Load preferences from localStorage, or return defaults if absent /
 *  malformed. Defensive parse — a corrupted blob shouldn't crash boot. */
export function loadPreferences(): NotificationPreferences {
  if (typeof window === 'undefined') return defaultPreferences();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPreferences();
    const parsed: unknown = JSON.parse(raw);
    if (!isPreferences(parsed)) return defaultPreferences();
    return parsed;
  } catch {
    return defaultPreferences();
  }
}

/** Persist preferences. Best-effort — quota errors swallowed since the
 *  in-memory store is the authoritative copy for the session. */
export function savePreferences(prefs: NotificationPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage full or disabled — preferences won't survive reload */
  }
}

/** Mark the local prefs cache as needing a push to the server (true), or in
 *  sync with it (false). Best-effort — a quota/disabled-storage error just
 *  means the marker won't survive reload. */
export function setPreferencesDirty(dirty: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (dirty) window.localStorage.setItem(DIRTY_KEY, '1');
    else window.localStorage.removeItem(DIRTY_KEY);
  } catch {
    /* storage disabled — the in-memory flag still governs this session */
  }
}

/** True when the local prefs cache holds a change not yet persisted server-side. */
export function getPreferencesDirty(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DIRTY_KEY) === '1';
  } catch {
    return false;
  }
}

// ─── coercion (untrusted server / legacy storage → a valid blob) ───
//
// The server validates every field on WRITE, but the durable store can still
// hold a legacy / hand-edited row, so the FE coerces on read rather than
// trusting the wire. These COERCE per field (fall back to a valid default)
// instead of all-or-nothing rejecting — a single bad `days` entry shouldn't
// reset the user's whole quiet-hours window. Shared by `normalizeServer
// Preferences` (notificationsClient) so the two read paths agree.

/** Coerce an untrusted quiet-hours object into a fully-valid `QuietHoursConfig`.
 *  Drops non-integer / out-of-range days and resets a malformed HH:MM time to
 *  the default — so `isInQuietHours` never sees garbage (a bad `start` would
 *  otherwise parse to NaN and silently disable the window). */
export function sanitizeQuietHours(raw: unknown): QuietHoursConfig {
  const d = defaultPreferences().quietHours;
  if (raw === null || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const days = Array.isArray(r.days)
    ? r.days.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 6)
    : d.days;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    start: typeof r.start === 'string' && HHMM_RE.test(r.start) ? r.start : d.start,
    end: typeof r.end === 'string' && HHMM_RE.test(r.end) ? r.end : d.end,
    days,
    allowUrgent: typeof r.allowUrgent === 'boolean' ? r.allowUrgent : d.allowUrgent,
  };
}

/** Coerce an untrusted per-type array, dropping rows that aren't a well-formed
 *  `{type, muted, desktop}`. */
export function sanitizeTypePrefs(raw: unknown): NotificationTypePreference[] {
  if (!Array.isArray(raw)) return defaultPreferences().types;
  return raw.filter((t): t is NotificationTypePreference =>
    t !== null && typeof t === 'object'
    && typeof (t as Record<string, unknown>).type === 'string'
    && typeof (t as Record<string, unknown>).muted === 'boolean'
    && typeof (t as Record<string, unknown>).desktop === 'boolean');
}

/** Should this notification fire an OS-level desktop toast?
 *
 *  Returns true only if all four gates pass: not globalMuted, type-
 *  specific not muted, type-specific desktop=true, not in quiet hours
 *  (unless allowUrgent + urgent). Called from `notificationStore`
 *  `_ingest` before `fireDesktopNotification`.
 */
export function shouldFireDesktop(
  notification: Notification,
  prefs: NotificationPreferences,
  now: Date = new Date(),
): boolean {
  if (prefs.globalMute) return false;
  const typePref = prefs.types.find((t) => t.type === notification.type);
  if (typePref?.muted) return false;
  if (typePref && !typePref.desktop) return false;
  if (isInQuietHours(prefs.quietHours, now)) {
    if (notification.priority === 'urgent' && prefs.quietHours.allowUrgent) {
      return true;
    }
    return false;
  }
  return true;
}

/** Should this notification count toward the unread badge?
 *  Muted types still SHOW in the panel (so the user can find them
 *  later) but don't bump the badge. Mirrors the myndhyve pattern. */
export function shouldCountUnread(
  notification: Notification,
  prefs: NotificationPreferences,
): boolean {
  if (prefs.globalMute) return false;
  const typePref = prefs.types.find((t) => t.type === notification.type);
  if (typePref?.muted) return false;
  return true;
}

/** True when `now` falls inside the configured quiet-hours window. */
export function isInQuietHours(q: NotificationPreferences['quietHours'], now: Date): boolean {
  if (!q.enabled) return false;
  const day = now.getDay();
  if (!q.days.includes(day)) return false;
  const [startH, startM] = q.start.split(':').map((s) => Number(s));
  const [endH, endM] = q.end.split(':').map((s) => Number(s));
  if ([startH, startM, endH, endM].some((n) => Number.isNaN(n))) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = (startH ?? 0) * 60 + (startM ?? 0);
  const endMin = (endH ?? 0) * 60 + (endM ?? 0);
  // Overnight window (e.g., 22:00 → 08:00 next day)
  if (startMin > endMin) {
    return nowMin >= startMin || nowMin < endMin;
  }
  return nowMin >= startMin && nowMin < endMin;
}

// ─── runtime type guards ───────────────────────────────────────────

function isPreferences(v: unknown): v is NotificationPreferences {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.version !== 1) return false;
  if (typeof r.globalMute !== 'boolean') return false;
  if (!Array.isArray(r.types)) return false;
  if (!isQuietHours(r.quietHours)) return false;
  return r.types.every(isTypePref);
}

function isTypePref(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.type === 'string' && typeof r.muted === 'boolean' && typeof r.desktop === 'boolean';
}

function isQuietHours(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.enabled === 'boolean'
    && typeof r.start === 'string'
    && typeof r.end === 'string'
    && Array.isArray(r.days)
    && typeof r.allowUrgent === 'boolean';
}
