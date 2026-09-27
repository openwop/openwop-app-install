/**
 * ADR 0308 P3 — `openwop:notifications.notify-me`, the inbox deliverable tool.
 *
 * Makes "check your inbox for the link" a TRUE sentence: the agent notifies the
 * REQUESTING USER ONLY (self-scope — the schema exposes no recipient input at
 * all) through the ONE notification emitter (`getNotificationEmitter`, the
 * `channelActivityNotify` shape — no parallel path). Notifications are core
 * platform infrastructure (no toggle; ADR 0010, ungated emit since 2026-06-11),
 * so the fail-closed floor here is:
 *  - a HUMAN-initiated turn (`scope.actingUserId`) — system runs get a refusal;
 *  - `url` restricted to RELATIVE in-app paths — the inbox renders `actionUrl`
 *    raw via `Link`/`history.pushState`, so a model-supplied absolute URL would
 *    be an off-app phishing vector from a trusted surface (P3 architect review).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';

export const NOTIFY_ME_TOOL_ID = 'openwop:notifications.notify-me';

/** Agent-deliverable notifications carry their own type so the inbox (and any
 *  future preference rule) can distinguish them from run/system notifications. */
export const AGENT_DELIVERABLE_NOTIFICATION_TYPE = 'agent.deliverable';

const TITLE_MAX = 200;
const MESSAGE_MAX = 1_000;
const URL_MAX = 500;

function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

/** In-app paths only: leading `/`, not protocol-relative `//`, no whitespace or
 *  control characters (header/markdown smuggling), bounded length. */
export function isSafeInAppPath(url: string): boolean {
  if (url.length === 0 || url.length > URL_MAX) return false;
  if (!url.startsWith('/') || url.startsWith('//')) return false;
  if (url.includes('\\') || /\s/.test(url)) return false;
  for (let i = 0; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

export function registerNotificationsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: NOTIFY_ME_TOOL_ID,
      description:
        'Send an in-app inbox notification TO THE USER YOU ARE TALKING TO (only them — no other recipients are possible), '
        + 'usually linking a deliverable you just created (a document draft, an email draft). '
        + 'Use it AFTER a deliverable tool succeeded, passing that tool\'s url. '
        + 'Only after this succeeds may you tell the user to check their inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short notification title (what landed).' },
          body: { type: 'string', description: 'Optional one-or-two-sentence message.' },
          url: { type: 'string', description: 'Optional in-app link the notification opens (a RELATIVE path like /documents — external URLs are rejected).' },
        },
        required: ['title'],
      },
    },
    async run(input, scope) {
      const actingUserId = scope.actingUserId;
      if (!actingUserId) {
        return toolError('acting_user_required', 'Inbox notifications can only be sent from a human-initiated turn — and only to that human.');
      }
      const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
      if (!title) return toolError('validation_error', '`title` is required.');
      const body = typeof input.body === 'string' ? input.body.replace(/\s+/g, ' ').trim() : '';
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      if (url && !isSafeInAppPath(url)) {
        return toolError('invalid_url', 'Only relative in-app paths (starting with "/") are allowed — pass the `url` a deliverable tool returned.');
      }
      await getNotificationEmitter().emit({
        tenantId: scope.tenantId,
        recipientUserId: actingUserId,
        type: AGENT_DELIVERABLE_NOTIFICATION_TYPE,
        priority: 'normal',
        title: title.slice(0, TITLE_MAX),
        message: (body || title).slice(0, MESSAGE_MAX),
        ...(url ? { actionUrl: url } : {}),
        // Traceability: which turn produced it (notifications are not retried
        // idempotently — an inbox ping, not a ledger).
        metadata: { producedBy: scope.agentProfileId ?? 'assistant', ...(scope.runId ? { runId: scope.runId } : {}) },
      });
      return {
        content: JSON.stringify({
          delivered: true,
          recipient: 'the requesting user',
          note: 'Inbox notification sent. You may now tell the user to check their inbox.',
        }),
      };
    },
  });
}
