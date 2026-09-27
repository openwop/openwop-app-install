/**
 * ADR 0422 P3 — `ctx.features['service-desk']`: the workflow-facing reads the
 * node pack wraps. Reads only — ticket WRITES from the agent lane ride the
 * approval queue (draft-reply → enqueueActionWithApproval), and channel
 * delivery rides the reply-approved event→workflow binding.
 */
import type { BundleScope, SurfaceFn } from '../../host/inMemorySurfaces.js';
import { getTicket, listTickets } from './tickets.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function buildServiceDeskSurface(scope: BundleScope): Record<string, SurfaceFn> {
  const { tenantId } = scope;
  return {
    listTickets: async (args) => ({
      tickets: (await listTickets(tenantId, str(args.orgId), str(args.status) ? { status: str(args.status) } : undefined))
        .map((t) => ({ ticketId: t.ticketId, subject: t.subject, status: t.status, priority: t.priority, channel: t.channel, messages: t.messages.length, updatedAt: t.updatedAt })),
    }),
    getTicket: async (args) => {
      const t = await getTicket(tenantId, str(args.ticketId));
      return { ticket: t ?? null };
    },
  };
}
