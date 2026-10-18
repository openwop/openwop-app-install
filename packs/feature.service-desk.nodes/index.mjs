/**
 * feature.service-desk.nodes — ticket reads + the addressed team notification
 * over ctx.features['service-desk'] (ADR 0422 P3, ADR 0878 D8). Customer-facing
 * writes ride the approval queue and the service's own delivery, never a node.
 */
function ensure(ctx, method) {
  const s = ctx.features && ctx.features['service-desk'];
  if (!s || typeof s[method] !== 'function') {
    throw Object.assign(
      new Error(`host does not expose ctx.features['service-desk'].${method} — the Service Desk feature must be composed (ADR 0014)`),
      { code: 'host_capability_missing', capability: 'host.sample.service-desk' },
    );
  }
  return s;
}
function str(v) { return typeof v === 'string' ? v : ''; }

/** ADR 0878 D8 — an event-bound run routes `trigger.payload` to the `event`
 *  port; an empty `ticketId` falls back to it (the commerce ADR 0875 D11 shape). */
function ticketIdOf(i) {
  const direct = str(i.ticketId);
  if (direct) return direct;
  const ev = i.event && typeof i.event === 'object' ? i.event : {};
  return str(ev.ticketId);
}

export async function listTickets(ctx) {
  const sd = ensure(ctx, 'listTickets');
  const i = ctx.inputs ?? {};
  const out = await sd.listTickets({ orgId: str(i.orgId), ...(str(i.status) ? { status: str(i.status) } : {}) });
  return { status: 'success', outputs: { tickets: out.tickets ?? [] } };
}

export async function getTicket(ctx) {
  const sd = ensure(ctx, 'getTicket');
  const i = ctx.inputs ?? {};
  const out = await sd.getTicket({ ticketId: ticketIdOf(i) });
  // A missing (or unreadable) ticket is a typed failure: a downstream AI node must
  // never summarize nothing (ADR 0878 pre-code review H8).
  if (!out.ticket) {
    return { status: 'failure', error: { code: 'ticket_unavailable', message: 'The ticket does not exist or is not readable by this run.' } };
  }
  return { status: 'success', outputs: { ticket: out.ticket } };
}

export async function notifyTeam(ctx) {
  const sd = ensure(ctx, 'notifyTicketTeam');
  const i = ctx.inputs ?? {};
  const message = str(i.message) || str(i.content) || str(i.text);
  const out = await sd.notifyTicketTeam({ ticketId: ticketIdOf(i), title: str(i.title), message });
  return { status: 'success', outputs: { notified: out.notified ?? 0 } };
}

export const nodes = {
  'feature.service-desk.nodes.list-tickets': listTickets,
  'feature.service-desk.nodes.get-ticket': getTicket,
  'feature.service-desk.nodes.notify-team': notifyTeam,
};
export default nodes;
