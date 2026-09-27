/**
 * Notification delivery policy — the core-defines-seam / feature-registers pattern
 * (ADR 0214 D2), mirroring `subjectDisplay` / `subjectOrgScope`.
 *
 * A host-level producer (e.g. the channel-activity notifier) must honor a user's
 * mute preferences, but those preferences are OWNED by `features/notifications`.
 * Rather than a host→feature import, the feature registers a resolver here and the
 * producer calls `isNotificationMuted`. Default (no resolver) = deliver.
 */
import type { NotificationPriority } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.notificationPolicy');
let lastResolverWarnAt = 0;

export interface NotificationMuteContext {
  /** The conversation the notification is about (for per-conversation mute). */
  conversationId?: string;
  /** The notification `type` (for per-type mute). */
  type: string;
  priority: NotificationPriority;
}

type MuteResolver = (tenantId: string, userId: string, ctx: NotificationMuteContext) => Promise<boolean>;

let resolver: MuteResolver | null = null;

/** Registered ONCE at boot by `features/notifications`. */
export function setNotificationMuteResolver(fn: MuteResolver): void {
  resolver = fn;
}

/** True when the recipient has muted this notification. Fail-open (deliver) if no
 *  resolver is registered or it throws — a mute lookup must never drop a real signal
 *  by erroring. */
export async function isNotificationMuted(tenantId: string, userId: string, ctx: NotificationMuteContext): Promise<boolean> {
  if (!resolver) return false;
  try {
    return await resolver(tenantId, userId, ctx);
  } catch (err) {
    // CS-CH-6 — fail-open stays (a mute lookup must never drop a real signal),
    // but a BROKEN resolver floods every muted channel; make it visible in ops
    // (throttled — one warn per minute, not one per fan-out recipient).
    const now = Date.now();
    if (now - lastResolverWarnAt > 60_000) {
      lastResolverWarnAt = now;
      log.warn('notification_mute_resolver_failed_fail_open', { tenantId, error: err instanceof Error ? err.message : String(err) });
    }
    return false;
  }
}
