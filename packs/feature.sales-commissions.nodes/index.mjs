/**
 * feature.sales-commissions.nodes — Sales Commissions nodes (ADR 0280 / ADR 0014).
 *
 * Two role:"action" READ nodes (list-plans, list-statements) + two GOVERNED WRITE
 * nodes (compute-statement, approve-statement) over the `ctx.features.commissions`
 * surface. The surface enforces the run owner's scope (host:commissions:manage for
 * writes; subject-scoping for statement reads); the write nodes are kept out of the
 * advisory agent's allowlist (ADR 0208 §2). tenantId comes from the run scope, never
 * node args (CTI-1). Pure-JS, Node-20 stdlib only.
 */

/** Resolve the commissions surface, or fail with the canonical capability error. */
function ensure(ctx) {
  const c = ctx.features && ctx.features.commissions;
  if (!c || typeof c.listPlans !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.commissions — the sales-commissions feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.commissions' },
    );
  }
  return c;
}

const str = (v) => (typeof v === 'string' ? v : '');
function args(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

export async function listPlans(ctx) {
  const c = ensure(ctx);
  const out = await c.listPlans({ orgId: str(args(ctx).orgId) });
  return { status: 'success', outputs: { plans: out.plans ?? [] } };
}

export async function listStatements(ctx) {
  const c = ensure(ctx);
  const i = args(ctx);
  const out = await c.listStatements({
    orgId: str(i.orgId),
    ...(str(i.subjectId) ? { subjectId: str(i.subjectId) } : {}),
    ...(str(i.period) ? { period: str(i.period) } : {}),
    ...(str(i.planId) ? { planId: str(i.planId) } : {}),
  });
  return { status: 'success', outputs: { statements: out.statements ?? [] } };
}

/* ─── Governed writes (ADR 0280 P4) — the surface enforces the run owner's scope ─── */

export async function computeStatement(ctx) {
  const c = ensure(ctx);
  if (typeof c.computeStatement !== 'function') throw Object.assign(new Error('ctx.features.commissions.computeStatement not exposed'), { code: 'host_capability_missing', capability: 'host.sample.commissions' });
  const i = args(ctx);
  const out = await c.computeStatement({ orgId: str(i.orgId), planId: str(i.planId), subjectId: str(i.subjectId), period: str(i.period) });
  return { status: 'success', outputs: { success: out.success ?? true, statement: out.statement ?? null } };
}

/**
 * R2 COM2-M3 (review) — this SUBMITS a statement for review; it does not approve one.
 * The surface stopped applying the transition (a chain must not be the approver on a
 * payout record), and this wrapper still read `out.statement` — which no longer exists.
 * The chain got `status: 'success'` with `statement: null`, so the `review.approvalId`
 * was thrown away, a downstream edge on `statement.status === 'approved'` read
 * `undefined` and silently took the wrong branch: success-with-empty, the exact shape
 * CLAUDE.md forbids, reintroduced by the fix that closed M3.
 */
export async function approveStatement(ctx) {
  const c = ensure(ctx);
  if (typeof c.approveStatement !== 'function') throw Object.assign(new Error('ctx.features.commissions.approveStatement not exposed'), { code: 'host_capability_missing', capability: 'host.sample.commissions' });
  const i = args(ctx);
  const out = await c.approveStatement({ orgId: str(i.orgId), statementId: str(i.statementId) });
  if (!out?.review?.approvalId) {
    throw Object.assign(new Error('the commissions surface did not return a pending review for this statement'), { code: 'invalid_response' });
  }
  return { status: 'success', outputs: { success: out.success ?? true, submittedForReview: true, review: out.review } };
}

// Parity tripwire fix (NODE-PACK-AUDIT 2026-07-17): the loader reads the
// NAMED `nodes` export (tarballLoader.ts) — without this map every declared
// node was invisible at load time (the skills-bridge bug class).
export const nodes = {
  'feature.sales-commissions.nodes.list-plans': listPlans,
  'feature.sales-commissions.nodes.list-statements': listStatements,
  'feature.sales-commissions.nodes.compute-statement': computeStatement,
  'feature.sales-commissions.nodes.approve-statement': approveStatement,
};

export default nodes;
