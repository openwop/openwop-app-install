/**
 * feature.crm.nodes — CRM nodes (ADR 0001 §4 / ADR 0014 reference feature).
 *
 * Two PURE nodes back the CRM toggle's A/B variant bindings: `triage` (basic
 * stage-only scoring) and `triage-enriched` (adds a company-signal bump). Pure
 * + deterministic — same inputs → same outputs — so a run that uses them
 * replays identically.
 *
 * Five role:"action" READ nodes expose the `ctx.features.crm` surface
 * (companies / deals / tasks) so a workflow can read CRM data. They read the
 * tenant store (a side-effect), so the engine records their outputs and
 * replay/fork read the recorded result rather than re-querying. The service
 * enforces the tenant+org key (CTI-1) — a cross-tenant id is simply not found.
 * Pure-JS, Node-20 stdlib only.
 */

/** Resolve the CRM feature surface, or fail with the canonical capability error
 *  (workflow-register should refuse a workflow needing it on a host that doesn't
 *  expose it — ADR 0014 Phase 4 gating; this is the runtime backstop). */
function ensureCrm(ctx) {
  const crm = ctx.features && ctx.features.crm;
  if (!crm || typeof crm.listCompanies !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.crm — the CRM feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.crm' },
    );
  }
  return crm;
}

const str = (v) => (typeof v === 'string' ? v : '');

const STAGE_SCORE = { lead: 10, qualified: 40, customer: 80, churned: 5 };

function score(contact, { enriched }) {
  const base = STAGE_SCORE[contact?.stage] ?? 0;
  // Enriched variant weights a known company higher (a deterministic bump).
  const companyBump = enriched && typeof contact?.company === 'string' && contact.company.length > 0 ? 15 : 0;
  const total = Math.min(100, base + companyBump);
  const priority = total >= 70 ? 'high' : total >= 30 ? 'normal' : 'low';
  return { score: total, priority };
}

export async function triage(ctx) {
  const contact = ctx.inputs?.contact ?? ctx.inputs ?? {};
  return { status: 'success', outputs: { triage: { variant: 'basic', ...score(contact, { enriched: false }) } } };
}

export async function triageEnriched(ctx) {
  const contact = ctx.inputs?.contact ?? ctx.inputs ?? {};
  return { status: 'success', outputs: { triage: { variant: 'enriched', ...score(contact, { enriched: true }) } } };
}

export async function listCompanies(ctx) {
  const crm = ensureCrm(ctx);
  const i = ctx.inputs ?? {};
  const out = await crm.listCompanies({ orgId: str(i.orgId), ...(str(i.q) ? { q: str(i.q) } : {}) });
  return { status: 'success', outputs: { companies: out.companies ?? [] } };
}

export async function getCompany(ctx) {
  const crm = ensureCrm(ctx);
  const i = ctx.inputs ?? {};
  const out = await crm.getCompany({ orgId: str(i.orgId), companyId: str(i.companyId) });
  return { status: 'success', outputs: { company: out.company ?? null } };
}

export async function listDeals(ctx) {
  const crm = ensureCrm(ctx);
  const i = ctx.inputs ?? {};
  const out = await crm.listDeals({
    orgId: str(i.orgId),
    ...(str(i.pipelineId) ? { pipelineId: str(i.pipelineId) } : {}),
    ...(str(i.stageId) ? { stageId: str(i.stageId) } : {}),
    ...(str(i.companyId) ? { companyId: str(i.companyId) } : {}),
    ...(str(i.q) ? { q: str(i.q) } : {}),
  });
  return { status: 'success', outputs: { deals: out.deals ?? [] } };
}

export async function getDeal(ctx) {
  const crm = ensureCrm(ctx);
  const i = ctx.inputs ?? {};
  const out = await crm.getDeal({ orgId: str(i.orgId), dealId: str(i.dealId) });
  return { status: 'success', outputs: { deal: out.deal ?? null } };
}

export async function listTasks(ctx) {
  const crm = ensureCrm(ctx);
  const i = ctx.inputs ?? {};
  const out = await crm.listTasks({
    orgId: str(i.orgId),
    ...(str(i.status) ? { status: str(i.status) } : {}),
    ...(str(i.dealId) ? { dealId: str(i.dealId) } : {}),
  });
  return { status: 'success', outputs: { tasks: out.tasks ?? [] } };
}

export const nodes = {
  'feature.crm.nodes.triage': triage,
  'feature.crm.nodes.triage-enriched': triageEnriched,
  'feature.crm.nodes.list-companies': listCompanies,
  'feature.crm.nodes.get-company': getCompany,
  'feature.crm.nodes.list-deals': listDeals,
  'feature.crm.nodes.get-deal': getDeal,
  'feature.crm.nodes.list-tasks': listTasks,
};

export default nodes;
