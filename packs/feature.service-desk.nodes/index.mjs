/**
 * feature.service-desk.nodes — ticket reads over ctx.features['service-desk']
 * (ADR 0422 P3). Reads only: agent-lane writes ride the approval queue; the
 * reply-approved event binds channel delivery via workflow automation.
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

export async function listTickets(ctx) {
  const sd = ensure(ctx, 'listTickets');
  const i = ctx.inputs ?? {};
  const out = await sd.listTickets({ orgId: str(i.orgId), ...(str(i.status) ? { status: str(i.status) } : {}) });
  return { status: 'success', outputs: { tickets: out.tickets ?? [] } };
}

export async function getTicket(ctx) {
  const sd = ensure(ctx, 'getTicket');
  const i = ctx.inputs ?? {};
  const out = await sd.getTicket({ ticketId: str(i.ticketId) });
  return { status: 'success', outputs: { ticket: out.ticket ?? null } };
}

export const nodes = {
  'feature.service-desk.nodes.list-tickets': listTickets,
  'feature.service-desk.nodes.get-ticket': getTicket,
};
export default nodes;
