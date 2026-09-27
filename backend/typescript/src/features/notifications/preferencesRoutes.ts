/**
 * Notification preferences — durable, server-backed, per-(tenant, user) store
 * (ADR 0010 Phase 2). The frontend previously kept these in `localStorage`
 * (per-device, lost on clear, invisible to the server); this promotes them to a
 * durable store so preferences are cross-device and authoritative.
 *
 *   GET  /v1/host/openwop-app/notifications/preferences  — the caller's prefs (or defaults)
 *   PUT  /v1/host/openwop-app/notifications/preferences  — replace the caller's prefs
 *
 * Both are signed-in gated (anonymous demo sessions have no durable identity to
 * key on) and mounted UNDER the feature's toggle-gate middleware, so a tenant
 * with the feature off gets the surface-wide 404 before reaching here.
 *
 * The wire shape mirrors the frontend `NotificationPreferences` blob so the
 * client can read/write it without translation. Every field is validated +
 * bounded on write — the store is plain JSON, so an unbounded/garbage blob would
 * otherwise persist and re-serve.
 *
 * @see docs/adr/0010-notifications.md
 */

import type { Express } from 'express';
import type { NotificationPriority } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { setNotificationMuteResolver } from '../../host/notificationPolicy.js';

/** Well-known types the prefs UI surfaces; unknown emitted types fall back to
 *  defaults (not muted, desktop on). The canonical source is the
 *  `NotificationType` union in `backend/.../src/types.ts` (it's a compile-time
 *  type, not a runtime array, hence this list); it is MIRRORED in the frontend
 *  `KNOWN_TYPES` (frontend/.../notifications/types.ts). Keep all three in sync —
 *  adding a type to one without the others leaves the new type unsurfaced in the
 *  prefs UI even though the backend seeds a default for it. */
const KNOWN_TYPES = [
  'openwop-app.workflow.approval-needed',
  'workflow.input_needed',
  'workflow.failed',
  'workflow.completed',
  'system.alert',
  // NOTIF-1 / ADR 0214 — channel-activity (agent posts) as a FIRST-CLASS per-type
  // control: one toggle silences all agent-post pushes, so the opt-out isn't only
  // per-channel. Mirrored in the FE KNOWN_TYPES.
  'chat.channel_post',
] as const;

const MAX = {
  /** A defensive cap on per-type rows so a caller can't store an unbounded
   *  list (open type vocabulary — KNOWN_TYPES is just the seeded UI set). */
  typeRows: 100,
  /** Max length of a type string (dotted namespace). */
  typeLen: 200,
  /** Quiet-hours days array is bounded to the 7 days of the week. */
  days: 7,
} as const;

interface TypePreference {
  type: string;
  muted: boolean;
  desktop: boolean;
}

interface QuietHours {
  enabled: boolean;
  start: string; // HH:MM (24h)
  end: string;   // HH:MM (24h)
  days: number[]; // 0–6, Sunday = 0
  allowUrgent: boolean;
  /** NOTIF-2 — the IANA zone the start/end window is evaluated in (the FE sends the
   *  browser tz). Absent ⇒ quiet-hours is NOT enforced server-side (honest — the
   *  window is meaningless without a zone). */
  timezone?: string;
}

interface NotificationPreferences {
  tenantId: string;
  userId: string;
  globalMute: boolean;
  types: TypePreference[];
  quietHours: QuietHours;
  /** ADR 0192 D7 — conversation ids (channels/groups) the user muted: the rail
   *  dims them + suppresses counters, and the emitter drops addressed
   *  notifications keyed `metadata.conversationId` (dormant until a producer
   *  emits conversation-addressed notifications — ADR 0196 OQ-1). */
  mutedConversations?: string[];
  version: 1;
  updatedAt: string;
}

const prefs = new DurableCollection<NotificationPreferences>(
  'notifications:prefs',
  // Composite key — preferences are per-(tenant, user). The tenant prefix keeps
  // two tenants' same-named users from colliding (CTI-1).
  (p) => `${p.tenantId}:${p.userId}`,
);

/** The seeded defaults, returned when a user has never saved prefs. Matches the
 *  frontend `defaultPreferences()` so a first GET is identical to the FE default. */
function defaultPreferences(tenantId: string, userId: string, now: string): NotificationPreferences {
  return {
    tenantId,
    userId,
    globalMute: false,
    types: KNOWN_TYPES.map((type) => ({
      type,
      muted: false,
      desktop: type !== 'workflow.completed', // completed rows are noisy by default
    })),
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '08:00',
      days: [0, 1, 2, 3, 4, 5, 6],
      allowUrgent: true,
    },
    version: 1,
    updatedAt: now,
  };
}

/** NOTIF-2 — is `now` inside the user's quiet-hours window, for a notification of this
 *  priority? Evaluated in the stored IANA timezone; without a timezone (or on a bad
 *  zone) it does NOT enforce (the window is meaningless without a zone). `allowUrgent`
 *  lets urgent/high through. Handles an overnight window (start > end) wrapping midnight.
 *  Note: the day gate uses NOW's weekday, so an overnight window's post-midnight tail
 *  falls on the next day (a `22:00–08:00` window on `[Sat]` doesn't mute Sun 00:00–08:00).
 *  This fails toward DELIVERING (never over-mutes) — acceptable. */
function isWithinQuietHours(qh: QuietHours, priority: NotificationPriority): boolean {
  if (!qh.enabled || !qh.timezone) return false;
  if (qh.allowUrgent && (priority === 'urgent' || priority === 'high')) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: qh.timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  } catch { return false; }
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  if (wd < 0 || !qh.days.includes(wd)) return false;
  const nowMin = (Number(parts.find((p) => p.type === 'hour')?.value) % 24) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  const [sh, sm] = qh.start.split(':').map(Number); const startMin = sh! * 60 + sm!;
  const [eh, em] = qh.end.split(':').map(Number); const endMin = eh! * 60 + em!;
  return startMin <= endMin ? (nowMin >= startMin && nowMin < endMin) : (nowMin >= startMin || nowMin < endMin);
}

/** ADR 0214 D2 — register the mute policy the host-level notifiers consult. Reads
 *  the SAME prefs store the routes write, so a user's mute takes effect immediately.
 *  Honors globalMute + per-conversation mute (ADR 0192 D7) + per-type mute + quiet-hours
 *  (NOTIF-2, when a timezone is set). Idempotent. */
export function registerNotificationMutePolicy(): void {
  setNotificationMuteResolver(async (tenantId, userId, ctx) => {
    const p = await prefs.get(`${tenantId}:${userId}`);
    if (!p) return false;
    if (p.globalMute) return true;
    if (ctx.conversationId && (p.mutedConversations ?? []).includes(ctx.conversationId)) return true;
    if (p.types.some((t) => t.type === ctx.type && t.muted)) return true;
    return isWithinQuietHours(p.quietHours, ctx.priority);
  });
}

export function registerNotificationPreferenceRoutes(app: Express): void {
  const BASE = '/v1/host/openwop-app/notifications/preferences';

  app.get(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const stored = await prefs.get(`${user.tenantId}:${user.userId}`);
      res.json({ preferences: stored ?? defaultPreferences(user.tenantId, user.userId, new Date().toISOString()) });
    } catch (err) {
      next(err);
    }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      // ADR 0192 D7 — MERGE-ON-ABSENT for `mutedConversations`: the PUT is a
      // whole-blob replace, so a client built before the field existed (an older
      // SPA tab, the chat widget) would otherwise silently wipe every mute.
      const stored = await prefs.get(`${user.tenantId}:${user.userId}`);
      const next_ = validatePreferences(req.body, user.tenantId, user.userId, new Date().toISOString(), stored?.mutedConversations);
      await prefs.put(next_);
      res.json({ preferences: next_ });
    } catch (err) {
      next(err);
    }
  });
}

// ─── validation (every field bounded on write) ─────────────────────────────

function validatePreferences(raw: unknown, tenantId: string, userId: string, now: string, storedMuted?: readonly string[]): NotificationPreferences {
  if (raw === null || typeof raw !== 'object') {
    throw new OpenwopError('validation_error', 'Request body MUST be a preferences object.', 400, {});
  }
  const body = raw as Record<string, unknown>;
  const mutedConversations = body.mutedConversations !== undefined
    ? validateMutedConversations(body.mutedConversations)
    : storedMuted !== undefined ? [...storedMuted] : undefined; // merge-on-absent (ADR 0192 D7)
  return {
    tenantId,
    userId,
    globalMute: bool(body.globalMute, 'globalMute'),
    types: validateTypes(body.types),
    quietHours: validateQuietHours(body.quietHours),
    ...(mutedConversations !== undefined ? { mutedConversations } : {}),
    version: 1,
    updatedAt: now,
  };
}

/** ADR 0192 D7 — bounded like every other field on this blob. */
function validateMutedConversations(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'Field `mutedConversations` MUST be an array of conversation ids.', 400, { field: 'mutedConversations' });
  }
  if (raw.length > 500) {
    throw new OpenwopError('validation_error', 'Field `mutedConversations` MUST have at most 500 entries.', 400, { field: 'mutedConversations' });
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new OpenwopError('validation_error', 'Each `mutedConversations` entry MUST be a string of 1-128 chars.', 400, { field: 'mutedConversations' });
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function validateTypes(raw: unknown): TypePreference[] {
  if (!Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'Field `types` MUST be an array.', 400, { field: 'types' });
  }
  if (raw.length > MAX.typeRows) {
    throw new OpenwopError('validation_error', `Field \`types\` MUST have at most ${MAX.typeRows} rows.`, 400, { field: 'types' });
  }
  const seen = new Set<string>();
  const out: TypePreference[] = [];
  for (const row of raw) {
    if (row === null || typeof row !== 'object') {
      throw new OpenwopError('validation_error', 'Each `types` row MUST be an object.', 400, { field: 'types' });
    }
    const r = row as Record<string, unknown>;
    if (typeof r.type !== 'string' || r.type.trim().length === 0) {
      throw new OpenwopError('validation_error', 'Each `types` row MUST have a non-empty `type` string.', 400, { field: 'types.type' });
    }
    if (r.type.length > MAX.typeLen) {
      throw new OpenwopError('validation_error', `\`types.type\` MUST be at most ${MAX.typeLen} chars.`, 400, { field: 'types.type' });
    }
    // De-dup by type so the predicate's `.find(t => t.type === …)` is unambiguous.
    if (seen.has(r.type)) continue;
    seen.add(r.type);
    out.push({
      type: r.type,
      muted: bool(r.muted, 'types.muted'),
      desktop: bool(r.desktop, 'types.desktop'),
    });
  }
  return out;
}

function validateQuietHours(raw: unknown): QuietHours {
  if (raw === null || typeof raw !== 'object') {
    throw new OpenwopError('validation_error', 'Field `quietHours` MUST be an object.', 400, { field: 'quietHours' });
  }
  const q = raw as Record<string, unknown>;
  // NOTIF-2 — an optional IANA timezone (bounded; validated as a real zone).
  let timezone: string | undefined;
  if (q.timezone !== undefined) {
    if (typeof q.timezone !== 'string' || q.timezone.length === 0 || q.timezone.length > 64) {
      throw new OpenwopError('validation_error', 'Field `quietHours.timezone` MUST be a string of 1-64 chars.', 400, { field: 'quietHours.timezone' });
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: q.timezone }); } catch {
      throw new OpenwopError('validation_error', 'Field `quietHours.timezone` MUST be a valid IANA timezone.', 400, { field: 'quietHours.timezone' });
    }
    timezone = q.timezone;
  }
  return {
    enabled: bool(q.enabled, 'quietHours.enabled'),
    start: hhmm(q.start, 'quietHours.start'),
    end: hhmm(q.end, 'quietHours.end'),
    days: validateDays(q.days),
    allowUrgent: bool(q.allowUrgent, 'quietHours.allowUrgent'),
    ...(timezone ? { timezone } : {}),
  };
}

function validateDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new OpenwopError('validation_error', 'Field `quietHours.days` MUST be an array.', 400, { field: 'quietHours.days' });
  }
  if (raw.length > MAX.days) {
    throw new OpenwopError('validation_error', 'Field `quietHours.days` MUST have at most 7 entries.', 400, { field: 'quietHours.days' });
  }
  const seen = new Set<number>();
  for (const d of raw) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
      throw new OpenwopError('validation_error', 'Each `quietHours.days` entry MUST be an integer 0–6.', 400, { field: 'quietHours.days' });
    }
    seen.add(d);
  }
  // Normalize to a sorted, de-duplicated set so the stored shape is canonical.
  return [...seen].sort((a, b) => a - b);
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a boolean.`, 400, { field });
  }
  return value;
}

function hhmm(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a HH:MM (24h) time.`, 400, { field });
  }
  return value;
}
