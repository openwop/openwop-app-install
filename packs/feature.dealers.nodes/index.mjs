/**
 * feature.dealers.nodes — Dealer Network nodes (ADR 0281 / ADR 0014).
 *
 * Three role:"action" READ nodes (list-dealers, list-outlets, list-registrations)
 * + one GOVERNED WRITE (approve-registration) over the `ctx.features.dealers`
 * surface. The surface enforces the run owner's scope for the write; the write
 * node is kept out of the advisory agent's allowlist (ADR 0208 §2). tenantId comes
 * from the run scope, never node args (CTI-1). Pure-JS, Node-20 stdlib only.
 */

function ensure(ctx) {
  const d = ctx.features && ctx.features.dealers;
  if (!d || typeof d.listDealers !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.dealers — the dealers feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.dealers' },
    );
  }
  return d;
}

const str = (v) => (typeof v === 'string' ? v : '');
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

export async function listDealers(ctx) {
  const d = ensure(ctx);
  const i = args(ctx);
  const out = await d.listDealers({ orgId: str(i.orgId), ...(str(i.territoryId) ? { territoryId: str(i.territoryId) } : {}), ...(str(i.status) ? { status: str(i.status) } : {}) });
  return { status: 'success', outputs: { dealers: out.dealers ?? [] } };
}

export async function listOutlets(ctx) {
  const d = ensure(ctx);
  const i = args(ctx);
  const out = await d.listOutlets({ orgId: str(i.orgId), ...(str(i.dealerId) ? { dealerId: str(i.dealerId) } : {}) });
  return { status: 'success', outputs: { outlets: out.outlets ?? [] } };
}

export async function listRegistrations(ctx) {
  const d = ensure(ctx);
  const i = args(ctx);
  const out = await d.listRegistrations({ orgId: str(i.orgId), ...(str(i.dealerId) ? { dealerId: str(i.dealerId) } : {}), ...(str(i.status) ? { status: str(i.status) } : {}) });
  return { status: 'success', outputs: { registrations: out.registrations ?? [] } };
}

/* ─── Governed write (ADR 0281 P3) — submits for human review (ADR 1034 D1); the surface enforces the run owner's scope ─── */

export async function approveRegistration(ctx) {
  const d = ensure(ctx);
  if (typeof d.approveRegistration !== 'function') throw Object.assign(new Error('ctx.features.dealers.approveRegistration not exposed'), { code: 'host_capability_missing', capability: 'host.sample.dealers' });
  const i = args(ctx);
  const out = await d.approveRegistration({ orgId: str(i.orgId), regId: str(i.regId) });
  // ADR 1034 D1 — the surface SUBMITS for review and returns the card. A result without
  // one is a typed failure, never `success` with nothing in it (the COM2-M3 lesson,
  // feature.sales-commissions.nodes approveStatement).
  if (!out?.review?.approvalId) {
    throw Object.assign(new Error('the dealers surface did not return a review for this registration'), { code: 'invalid_response' });
  }
  return { status: 'success', outputs: { success: out.success ?? true, submittedForReview: true, review: out.review } };
}

// Parity tripwire fix (NODE-PACK-AUDIT 2026-07-17): the loader reads the
// NAMED `nodes` export (tarballLoader.ts) — without this map every declared
// node was invisible at load time (the skills-bridge bug class).
export const nodes = {
  'feature.dealers.nodes.list-dealers': listDealers,
  'feature.dealers.nodes.list-outlets': listOutlets,
  'feature.dealers.nodes.list-registrations': listRegistrations,
  'feature.dealers.nodes.approve-registration': approveRegistration,
};

export default nodes;
