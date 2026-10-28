/**
 * Lead scoring (ADR 0297 D3) — CRM-owned, COMPUTED ON READ from the stores
 * that already exist (no new store of truth, the ruling's shape): the
 * analytics identity links (which visitor sessions belong to this contact),
 * the CDP funnel events those sessions produced, and (when an org is given)
 * the contact's commerce orders. Every part of the score is returned, so the
 * number is explainable — "which signals, which weights" (the D3 gate).
 *
 * Weights are deliberately simple, fixed, and visible (not ML): a completed
 * funnel step is worth 5 views; a paid order is worth 20. Tuning them is a
 * product decision recorded here, not a hidden model.
 */
import { readSignals } from './leadIntel/signals.js';
import { evaluateLeadScore, V0_CONTENT } from './leadIntel/model.js';

/** The v0 weights (ADR 0954 D1: `V0_CONTENT` is the one definition of them). */
export const LEAD_SCORE_WEIGHTS = { view: 1, completion: 5, paidOrder: 20 } as const;

export interface LeadScore {
  contactId: string;
  score: number;
  parts: {
    linkedSessions: number;
    funnelViews: number;
    funnelCompletions: number;
    paidOrders: number;
  };
  weights: typeof LEAD_SCORE_WEIGHTS;
  /** ADR 0954 P0 (L3) — true when a capped read makes the counts lower bounds.
   *  The old read capped at 50 000 tenant events and said nothing. */
  truncated: boolean;
}

/**
 * ADR 0954 P0 — the v0 model on the one engine, reading funnel events through the
 * per-visitor index (no per-contact tenant scan). Same numbers as before for every
 * caller; per-client models are read by the lead-intelligence routes, not here.
 */
export async function computeLeadScore(tenantId: string, contactId: string, orgId?: string): Promise<LeadScore> {
  const inputs = await readSignals(tenantId, { contactId }, new Set(V0_CONTENT.signals.map((s) => s.signalId)), orgId);
  const { score } = evaluateLeadScore(V0_CONTENT, inputs.raw);
  return {
    contactId, score,
    parts: {
      linkedSessions: inputs.linkedSessions,
      funnelViews: inputs.raw['funnel.view'] ?? 0,
      funnelCompletions: inputs.raw['funnel.completion'] ?? 0,
      paidOrders: inputs.raw['commerce.paid-order'] ?? 0,
    },
    weights: LEAD_SCORE_WEIGHTS,
    truncated: inputs.truncated,
  };
}
