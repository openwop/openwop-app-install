/**
 * Notification types — mirrors the BE wire shape from
 * `backend/typescript/src/types.ts`.
 *
 * Wire shape is open (BE accepts any dotted-namespace string), but the
 * FE renders unknown types via the fallback icon + color so old clients
 * forward-compat with new BE-emitted types without a rebuild.
 */

export type NotificationType =
  | 'workflow.approval_needed'
  | 'workflow.input_needed'
  | 'workflow.failed'
  | 'workflow.completed'
  | 'system.alert'
  // ADR 0074 — a transient review-status cache hint (NOT an inbox row).
  // Delivered over the same SSE stream via the emitter's non-persisted
  // `signal()` path; the notification store routes it to the review-status
  // store instead of the inbox. Excluded from ACTION_NEEDED_TYPES below.
  | 'review.updated'
  | string;

/** ADR 0074 — the transient signal type the review-status store consumes.
 *  The notification store MUST NOT ingest this into the inbox/unread count. */
export const REVIEW_UPDATED_SIGNAL_TYPE = 'review.updated' as const;

export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export type NotificationStatus = 'unread' | 'read' | 'archived';

export interface Notification {
  notificationId: string;
  type: NotificationType;
  priority: NotificationPriority;
  status: NotificationStatus;
  title: string;
  message: string;
  runId?: string | undefined;
  workflowId?: string | undefined;
  nodeId?: string | undefined;
  interruptId?: string | undefined;
  actionUrl?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt: string;
  readAt?: string | undefined;
  archivedAt?: string | undefined;
}

/** Types that mean "the user needs to act before the workflow advances."
 *  The /inbox page filters to this set; the bell panel shows everything. */
export const ACTION_NEEDED_TYPES = new Set<NotificationType>([
  'workflow.approval_needed',
  'workflow.input_needed',
]);

export function isActionNeeded(n: Notification): boolean {
  return ACTION_NEEDED_TYPES.has(n.type);
}

// ─── Notification preferences (items 5 + 6) ────────────────────────

/** The well-known notification types the preferences UI surfaces.
 *  The runtime accepts any string for `Notification.type`; unknown
 *  types fall through to default behavior (no mute, default sound).
 *  MIRRORS the backend `KNOWN_TYPES` (features/notifications/preferencesRoutes.ts)
 *  and the canonical `NotificationType` union in the backend `types.ts` — keep
 *  the three in sync when adding a type. */
export const KNOWN_TYPES: readonly NotificationType[] = [
  'workflow.approval_needed',
  'workflow.input_needed',
  'workflow.failed',
  'workflow.completed',
  'system.alert',
] as const;

/** i18n key for each well-known type's human label, surfaced in the prefs UI.
 *  Components resolve these via `t(TYPE_LABEL_KEYS[type] ?? type)` — an unknown
 *  (open-wire) type falls through to the raw type string (i18next echoes a
 *  missing key), preserving forward-compat. */
export const TYPE_LABEL_KEYS: Record<string, string> = {
  'workflow.approval_needed': 'notifications:typeApprovalNeeded',
  'workflow.input_needed':    'notifications:typeInputNeeded',
  'workflow.failed':          'notifications:typeWorkflowFailed',
  'workflow.completed':       'notifications:typeWorkflowCompleted',
  'system.alert':             'notifications:typeSystemAlert',
  // Comments feature (ADR 0021) — additive, fallback-protected; no core-union edit.
  'comment.added':            'notifications:typeCommentAdded',
  'comment.reply':            'notifications:typeCommentReply',
};

/** Per-type preference row. Each known type carries its own switch
 *  state; unknown types are treated as `muted=false, desktop=true`. */
export interface NotificationTypePreference {
  type: NotificationType;
  /** When true, the notification still arrives via SSE + appears in
   *  the bell badge count, but the panel hides it under the "muted"
   *  filter and desktop toast is suppressed. */
  muted: boolean;
  /** When true (and the OS-toast permission is granted), fire a
   *  Web Notifications API toast for this type. Defaults to true. */
  desktop: boolean;
}

/** Per-day-of-week quiet hours window. `dayOfWeek` is 0–6 with
 *  Sunday = 0, matching `Date.prototype.getDay()`. */
export interface QuietHoursConfig {
  enabled: boolean;
  /** HH:MM (24h) — quiet hours start. */
  start: string;
  /** HH:MM (24h) — quiet hours end. Crosses midnight when end < start. */
  end: string;
  /** Days of the week the quiet window applies. Sunday = 0. */
  days: readonly number[];
  /** When true, `urgent`-priority notifications still fire desktop
   *  toasts during quiet hours. Defaults to true so genuine emergencies
   *  cut through. */
  allowUrgent: boolean;
}

/** Full preferences blob. Persisted to localStorage under the key
 *  `openwop:notification-prefs:v1`. Versioned so a future schema
 *  bump can migrate or reset cleanly. */
export interface NotificationPreferences {
  /** Master kill switch — when true, NO notifications fire toasts,
   *  badge bumps still happen (so the user can clear them later). */
  globalMute: boolean;
  /** Per-type rows. Unlisted types fall back to defaults. */
  types: NotificationTypePreference[];
  quietHours: QuietHoursConfig;
  /** Schema version for future migration. */
  version: 1;
}

export function defaultPreferences(): NotificationPreferences {
  return {
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
  };
}
