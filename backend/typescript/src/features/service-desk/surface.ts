/**
 * ADR 0422 P3 — `ctx.features['service-desk']`: the workflow-facing surface the
 * node pack wraps. Ticket WRITES from the agent lane ride the approval queue
 * (draft-reply → enqueueActionWithApproval) and delivery is the service's
 * (ADR 0878 D3) — never a node.
 *
 * ADR 0878 D1 (SD2-S1): `getTicket` takes no `orgId`, so the seam's org floor
 * (`featureSurfaces.orgFloor`) never fired for it and a run acting for an org-A
 * member read an org-B ticket by id. It now applies the SAME predicate to the
 * ticket's own org. Nothing here returns the requester's address
 * (`projectTicketForAgent`): run history and model context never need it.
 */
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { assertRunScopeOrg } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { getTicket, listTickets, projectTicketForAgent } from './tickets.js';
import { notifyTicketTeam, ticketLabel } from './sla.js';
import { sanitizeFreeText } from '../../byok/textRedaction.js';
import type { Ticket } from './ticketTypes.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The run's person may read this ticket's org, or it is answered as absent.
 *  Only an authz refusal becomes "absent"; anything else (storage) is rethrown. */
async function readableTicket(scope: BundleScope, ticketId: string): Promise<Ticket | null> {
  const t = ticketId ? await getTicket(scope.tenantId, ticketId) : null;
  if (!t) return null;
  try {
    await assertRunScopeOrg(scope, t.orgId, 'workspace:read');
  } catch (err) {
    if (err instanceof OpenwopError && (err.code === 'not_found' || err.code === 'forbidden_scope')) return null;
    throw err;
  }
  return t;
}

export function buildServiceDeskSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const { tenantId } = scope;
  return {
    // `orgId` is in the args, so the seam's org floor gates this one.
    listTickets: async (args) => ({
      tickets: (await listTickets(tenantId, str(args.orgId), str(args.status) ? { status: str(args.status) } : undefined))
        .map((t) => ({ ticketId: t.ticketId, subject: t.subject, status: t.status, priority: t.priority, channel: t.channel, messages: t.messages.length, updatedAt: t.updatedAt })),
    }),
    getTicket: async (args) => {
      const t = await readableTicket(scope, str(args.ticketId));
      return { ticket: t ? projectTicketForAgent(t) : null };
    },
    /**
     * ADR 0878 D8 — tell the people who work this ticket: its assignee, else its
     * org's `workspace:write` holders. Never a tenant broadcast — the generic
     * `notify` node can only address `tenant`/`self`/`role:`, and an event-bound
     * run has no actor, so it would have broadcast one org's customer thread.
     */
    notifyTicketTeam: async (args) => {
      const t = await readableTicket(scope, str(args.ticketId));
      if (!t) throw new OpenwopError('not_found', 'Ticket not found.', 404, { ticketId: str(args.ticketId) });
      // Messaging OTHER people about a ticket is a write (grade-code SD2CD-10):
      // the run's person needs `workspace:write` in its org, not just read.
      await assertRunScopeOrg(scope, t.orgId, 'workspace:write');
      const title = sanitizeFreeText(str(args.title).slice(0, 140)) || `Support ticket needs attention: ${ticketLabel(t)}`;
      const message = sanitizeFreeText(str(args.message).slice(0, 2000));
      const recipients = await notifyTicketTeam(t, { title, message, type: 'servicedesk.ticket-escalated' });
      return { notified: recipients.length };
    },
  };
}
