/**
 * Inbox deep-link resolution (ADR 0336 Rec Phase 3). The `/inbox` page honors
 * two params, resolved against the FULL notification list (not the active tab's
 * filter) so a target is findable even when it lives under a different tab:
 *
 *  - `?notification=<id>` — a row addressed by its own notificationId
 *    (bookmarkable / shareable).
 *  - `?approval=<id>` — the pending approval a notification was emitted FOR. The
 *    emit sites (assistant actionApproval, host escalationNotify) know the
 *    approvalId but NOT the not-yet-issued notificationId, so this is the key
 *    they can build into `actionUrl`; it matches `metadata.approvalId`.
 *
 * These are pure so the derivation is unit-testable independent of the page and
 * of the FE↔BE URL round-trip (the BE emits `/inbox?approval=<encoded>`).
 */
import type { Notification } from './types.js';
import { isActionNeeded } from './types.js';

export type InboxTab = 'action-needed' | 'all' | 'archived';

export interface InboxDeepLink {
  notificationId: string;
  approvalId: string;
}

/** Parse the honored params out of a location search string. */
export function parseInboxDeepLink(search: string): InboxDeepLink {
  const p = new URLSearchParams(search);
  return { notificationId: p.get('notification') ?? '', approvalId: p.get('approval') ?? '' };
}

/** Whether `n` is the deep-link target. Precedence: notificationId exact, else
 *  approvalId (in `metadata.approvalId`). An empty param never matches. */
export function matchesInboxDeepLink(n: Notification, link: InboxDeepLink): boolean {
  if (link.notificationId && n.notificationId === link.notificationId) return true;
  if (link.approvalId && typeof n.metadata?.approvalId === 'string' && n.metadata.approvalId === link.approvalId) return true;
  return false;
}

/** The tab whose filter is guaranteed to include `n` — so a deep-link never
 *  lands on a tab that hides its target (an `agent.escalation` is NOT
 *  action-needed and would be invisible on the default action-needed tab). */
export function canonicalInboxTabFor(n: Notification): InboxTab {
  if (n.status === 'archived') return 'archived';
  return isActionNeeded(n) ? 'action-needed' : 'all';
}

/** Whether the given tab's filter currently surfaces `n`. */
export function inboxTabShows(tab: InboxTab, n: Notification): boolean {
  if (n.status === 'archived') return tab === 'archived';
  if (tab === 'archived') return false;
  if (tab === 'action-needed') return isActionNeeded(n);
  return true; // 'all'
}
