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

/** ADR 1125 D4 — Needs you (open requests, plus the approval queue), Updates
 *  (news and finished requests) and Archived. Each row is on exactly one tab. */
export type InboxTab = 'needs-you' | 'updates' | 'archived';

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

/** The tab whose filter includes `n`, so a deep link never lands on a tab that
 *  hides its target. A finished request opens Updates (ADR 1125 D4). */
export function canonicalInboxTabFor(n: Notification, featureTypes?: ReadonlySet<string>): InboxTab {
  if (n.status === 'archived') return 'archived';
  return isActionNeeded(n, featureTypes) ? 'needs-you' : 'updates';
}

/** Whether the given tab's filter currently surfaces `n`. */
export function inboxTabShows(tab: InboxTab, n: Notification, featureTypes?: ReadonlySet<string>): boolean {
  if (n.status === 'archived') return tab === 'archived';
  if (tab === 'archived') return false;
  const open = isActionNeeded(n, featureTypes);
  return tab === 'needs-you' ? open : !open;
}
