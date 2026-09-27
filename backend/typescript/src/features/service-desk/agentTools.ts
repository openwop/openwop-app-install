/**
 * ADR 0422 P3 — the Support Agent's chat tools (ADR 0308 seam). Reads +
 * DRAFTS only: `draft-reply` NEVER sends — it enqueues through the assistant
 * approval queue (`enqueueActionWithApproval`, kind `servicedesk.reply`); the
 * human decision executes the append + reply-approved event. Toggle-gated,
 * fail-empty without an acting user.
 *
 * Authority parity (CHAT-FIRST-PORT-AUDIT D8): every tool shares the service-desk
 * ROUTES' predicate — `orgScopeGranted(tenant, subject, org, scope)` in the
 * ticket's OWN org (reads need `workspace:read`, the reply/status actions need
 * `workspace:write`). Before this the tools checked only `actingUserId` + the
 * toggle and then trusted a caller-supplied `orgId` (list) or a ticket fetched by
 * id with no org check (get/draft/set-status), so any co-tenant could read or act
 * on another org's tickets. Reads now fail EMPTY (the same null/empty shape as an
 * unknown id — no existence leak); actions fail TYPED (`forbidden_scope` when the
 * ticket is readable but not writable, `not_found` when it is not even readable).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getTicket, listTickets } from './tickets.js';
import { TICKET_STATUSES } from './ticketTypes.js';
import { setStatus } from './tickets.js';
import { orgScopeGranted } from './routes.js';

export const SD_LIST_TOOL_ID = 'openwop:servicedesk.list-tickets';
export const SD_GET_TOOL_ID = 'openwop:servicedesk.get-ticket';
export const SD_DRAFT_TOOL_ID = 'openwop:servicedesk.draft-reply';
export const SD_STATUS_TOOL_ID = 'openwop:servicedesk.set-status';

async function enabled(tenantId: string, userId?: string): Promise<boolean> {
  const a = await resolveOne('service-desk', { tenantId, ...(userId ? { userId } : {}) }).catch(() => null);
  return a?.enabled === true;
}

const empty = (note: string): { content: string } => ({ content: JSON.stringify({ note }) });

type LoadedTicket = NonNullable<Awaited<ReturnType<typeof getTicket>>>;

/**
 * Fetch a ticket and gate the acting user IN the ticket's org — the routes'
 * `getTicket` + `ticket.orgId !== orgId` shape, re-expressed for a tool that has
 * no path org (the org comes from the ticket). Returns `not_found` when the
 * ticket is absent OR unreadable (a uniform result — a foreign org's ticket is
 * indistinguishable from a missing one, no existence leak); `forbidden` when it
 * is readable but the caller lacks the write scope an action needs. Mirrors
 * campaign-brief's `loadBriefForTool`.
 */
async function loadTicketForTool(
  tenantId: string,
  actingUserId: string,
  ticketId: string,
  requiredScope: 'workspace:read' | 'workspace:write',
): Promise<{ ok: true; ticket: LoadedTicket } | { ok: false; reason: 'not_found' | 'forbidden' }> {
  const ticket = await getTicket(tenantId, ticketId);
  if (!ticket || !(await orgScopeGranted(tenantId, actingUserId, ticket.orgId, 'workspace:read'))) {
    return { ok: false, reason: 'not_found' };
  }
  if (requiredScope === 'workspace:write' && !(await orgScopeGranted(tenantId, actingUserId, ticket.orgId, 'workspace:write'))) {
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, ticket };
}

const typedError = (code: string, message: string): { content: string; isError: true } => ({
  content: JSON.stringify({ error: { code, message } }),
  isError: true,
});

export function registerServiceDeskAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: SD_LIST_TOOL_ID,
      description: 'List the org\'s support tickets (id, subject, status, priority, channel). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', minLength: 1 },
          status: { type: 'string', description: `Optional filter: ${TICKET_STATUSES.join(' | ')}.` },
        },
        required: ['orgId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId || !(await enabled(scope.tenantId, scope.actingUserId))) return empty('service desk unavailable');
      const orgId = String(input.orgId ?? '');
      // Read gate: the caller-supplied orgId MUST be one the acting user has
      // workspace:read on. Fail EMPTY (an unauthorized org is indistinguishable
      // from an org with no tickets — no existence leak).
      if (!(await orgScopeGranted(scope.tenantId, scope.actingUserId, orgId, 'workspace:read'))) {
        return { content: JSON.stringify({ tickets: [] }) };
      }
      const tickets = await listTickets(scope.tenantId, orgId, typeof input.status === 'string' && input.status ? { status: input.status } : undefined);
      return { content: JSON.stringify({ tickets: tickets.map((t) => ({ ticketId: t.ticketId, subject: t.subject, status: t.status, priority: t.priority, channel: t.channel, messages: t.messages.length, updatedAt: t.updatedAt })) }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: SD_GET_TOOL_ID,
      description: 'Read ONE support ticket incl. its message thread (read-before-draft — always read the thread before drafting a reply).',
      inputSchema: { type: 'object', properties: { ticketId: { type: 'string', minLength: 1 } }, required: ['ticketId'], additionalProperties: false },
    },
    async run(input, scope) {
      if (!scope.actingUserId || !(await enabled(scope.tenantId, scope.actingUserId))) return empty('service desk unavailable');
      // Read gate on the ticket's OWN org. An unreadable ticket returns the SAME
      // `{ ticket: null }` as an unknown id (no existence leak).
      const loaded = await loadTicketForTool(scope.tenantId, scope.actingUserId, String(input.ticketId ?? ''), 'workspace:read');
      return { content: JSON.stringify({ ticket: loaded.ok ? loaded.ticket : null }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: SD_DRAFT_TOOL_ID,
      description:
        'DRAFT a reply to a support ticket for HUMAN APPROVAL — this never sends. The draft lands in the approvals inbox; on approval it is appended to the ticket as the outbound reply and channel delivery fires via the workspace automation binding.',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', minLength: 1 },
          reply: { type: 'string', minLength: 1, maxLength: 8000, description: 'The reply text to propose.' },
        },
        required: ['ticketId', 'reply'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId || !(await enabled(scope.tenantId, scope.actingUserId))) return empty('service desk unavailable');
      // Write gate on the ticket's OWN org: unreadable ⇒ typed not_found (no
      // existence leak); readable-but-not-writable ⇒ typed forbidden_scope.
      const loaded = await loadTicketForTool(scope.tenantId, scope.actingUserId, String(input.ticketId ?? ''), 'workspace:write');
      if (!loaded.ok) {
        return loaded.reason === 'forbidden'
          ? typedError('forbidden_scope', 'You need workspace:write in this ticket\'s organization to reply.')
          : typedError('not_found', 'ticket not found');
      }
      const ticket = loaded.ticket;
      const { enqueueActionWithApproval } = await import('../assistant/actionApproval.js');
      const action = await enqueueActionWithApproval(scope.tenantId, {
        kind: 'servicedesk.reply',
        payload: { ticketId: ticket.ticketId, orgId: ticket.orgId, channel: ticket.channel },
        draft: String(input.reply ?? ''),
        riskLevel: 'medium',
        reason: `Support reply to "${ticket.subject.slice(0, 80)}"`,
        // The thread is customer-authored content — taint accordingly (ADR 0027).
        derivedFromUntrusted: true,
      });
      return { content: JSON.stringify({ queued: { actionId: action.actionId, status: action.status }, note: 'reply drafted for human approval — NOT sent' }) };
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: SD_STATUS_TOOL_ID,
      description: `Set a ticket's status (${TICKET_STATUSES.join(' | ')}). Reversible workflow bookkeeping — sending anything to the customer still requires the draft-reply approval lane.`,
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: [...TICKET_STATUSES] },
        },
        required: ['ticketId', 'status'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId || !(await enabled(scope.tenantId, scope.actingUserId))) return empty('service desk unavailable');
      // Write gate on the ticket's OWN org (same shape as draft-reply).
      const loaded = await loadTicketForTool(scope.tenantId, scope.actingUserId, String(input.ticketId ?? ''), 'workspace:write');
      if (!loaded.ok) {
        return loaded.reason === 'forbidden'
          ? typedError('forbidden_scope', 'You need workspace:write in this ticket\'s organization to change its status.')
          : typedError('not_found', 'ticket not found');
      }
      try {
        const ticket = await setStatus(scope.tenantId, loaded.ticket.ticketId, String(input.status ?? ''), `agent:${scope.agentProfileId ?? 'assistant'}`);
        return { content: JSON.stringify({ ticket: { ticketId: ticket.ticketId, status: ticket.status } }) };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return { content: JSON.stringify({ error: { code: e.code ?? 'error', message: e.message ?? 'failed' } }), isError: true };
      }
    },
  });
}
