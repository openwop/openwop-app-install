/**
 * Shared click-through helpers for a notification's "view" link, consumed by
 * BOTH surfaces — the bell drawer (`NotificationPanel`) and the full inbox
 * (`NotificationsPage`). Extracted here so the two never drift (ADR: deep-link
 * spine). Depends only on the `NotificationType` union, so it introduces no
 * import cycle with either component.
 */
import type { NotificationType } from './types';

/**
 * i18n key for a notification's click-through action link, by type. These are
 * VERBS ("View order"), distinct from `TYPE_LABEL_KEYS` (the type-chip noun).
 * An unknown / open-wire type falls back to the generic `actionView`, so a
 * BE-emitted type the FE doesn't know still renders a sensible link.
 */
const ACTION_LABEL_KEYS: Record<string, string> = {
  'openwop-app.workflow.approval-needed':  'actionOpenInbox',
  'workflow.input_needed':     'actionOpenInbox',
  'workflow.failed':           'actionViewRun',
  'workflow.completed':        'actionViewRun',
  'commerce.order.paid':       'actionViewOrder',
  'commerce.ucp-buyer.placed': 'actionViewPurchase',
  'commerce.ucp-buyer.status': 'actionViewPurchase',
  'campaign.pacing':           'actionViewCampaign',
  'comment.added':             'actionViewComment',
  'comment.reply':             'actionViewComment',
  'task.assigned':             'actionViewCard',
  'chat.channel_post':         'actionOpenChannel',
  'agent.deliverable':         'actionViewDeliverable',
  'agent.escalation':          'actionOpenInbox',
  'assistant.briefing':        'actionViewBriefing',
};

/** Catalog key for a notification row's inline action link, by type. */
export function actionLabelKeyFor(type: NotificationType): string {
  return ACTION_LABEL_KEYS[type] ?? 'actionView';
}

const URL_MAX = 2048;

/**
 * In-app paths only — mirrors the backend `isSafeInAppPath` (agentTools.ts):
 * a leading `/`, not protocol-relative `//`, no backslash / whitespace /
 * control characters, bounded length. Defense-in-depth for rendering a
 * server-provided `actionUrl` into a router `<Link to>` — the emit sites
 * are many and a future one could regress. Returns a type guard so callers
 * narrow `string | undefined` → `string` at the call site.
 */
export function isSafeActionUrl(url: string | undefined): url is string {
  if (!url || url.length > URL_MAX) return false;
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  if (url.includes('\\') || /\s/.test(url)) return false;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}
