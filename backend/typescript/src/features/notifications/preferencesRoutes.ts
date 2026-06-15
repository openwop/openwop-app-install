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
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { resolveCallerUser } from '../users/usersGuards.js';

/** Well-known types the prefs UI surfaces; unknown emitted types fall back to
 *  defaults (not muted, desktop on). The canonical source is the
 *  `NotificationType` union in `backend/.../src/types.ts` (it's a compile-time
 *  type, not a runtime array, hence this list); it is MIRRORED in the frontend
 *  `KNOWN_TYPES` (frontend/.../notifications/types.ts). Keep all three in sync —
 *  adding a type to one without the others leaves the new type unsurfaced in the
 *  prefs UI even though the backend seeds a default for it. */
const KNOWN_TYPES = [
  'workflow.approval_needed',
  'workflow.input_needed',
  'workflow.failed',
  'workflow.completed',
  'system.alert',
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
}

interface NotificationPreferences {
  tenantId: string;
  userId: string;
  globalMute: boolean;
  types: TypePreference[];
  quietHours: QuietHours;
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
      const next_ = validatePreferences(req.body, user.tenantId, user.userId, new Date().toISOString());
      await prefs.put(next_);
      res.json({ preferences: next_ });
    } catch (err) {
      next(err);
    }
  });
}

// ─── validation (every field bounded on write) ─────────────────────────────

function validatePreferences(raw: unknown, tenantId: string, userId: string, now: string): NotificationPreferences {
  if (raw === null || typeof raw !== 'object') {
    throw new OpenwopError('validation_error', 'Request body MUST be a preferences object.', 400, {});
  }
  const body = raw as Record<string, unknown>;
  return {
    tenantId,
    userId,
    globalMute: bool(body.globalMute, 'globalMute'),
    types: validateTypes(body.types),
    quietHours: validateQuietHours(body.quietHours),
    version: 1,
    updatedAt: now,
  };
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
  return {
    enabled: bool(q.enabled, 'quietHours.enabled'),
    start: hhmm(q.start, 'quietHours.start'),
    end: hhmm(q.end, 'quietHours.end'),
    days: validateDays(q.days),
    allowUrgent: bool(q.allowUrgent, 'quietHours.allowUrgent'),
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
