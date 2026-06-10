/**
 * feature.crm.nodes — CRM contact-triage nodes (ADR 0001 §4 reference feature).
 *
 * Two pure nodes back the CRM toggle's A/B variant bindings: `triage` (basic
 * stage-only scoring) and `triage-enriched` (adds a company-signal bump). Pure
 * + deterministic — same inputs → same outputs — so a run that uses them
 * replays identically.
 */

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

export const nodes = {
  'feature.crm.nodes.triage': triage,
  'feature.crm.nodes.triage-enriched': triageEnriched,
};

export default nodes;
