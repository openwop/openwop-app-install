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
import { listCollectedEvents } from '../cdp/collectService.js';
import { sessionsForContact } from '../analytics/identityLinkService.js';
import { listOrders } from '../commerce/commerceService.js';

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
}

export async function computeLeadScore(tenantId: string, contactId: string, orgId?: string): Promise<LeadScore> {
  const sessions = new Set(await sessionsForContact(tenantId, contactId));
  let funnelViews = 0;
  let funnelCompletions = 0;
  if (sessions.size > 0) {
    for (const evt of await listCollectedEvents(tenantId, 50_000)) {
      if (evt.eventType !== 'funnel.step_viewed' && evt.eventType !== 'funnel.step_completed') continue;
      const visitor = (evt.payload as { visitor?: unknown }).visitor;
      if (typeof visitor !== 'string' || !sessions.has(visitor)) continue;
      if (evt.eventType === 'funnel.step_viewed') funnelViews += 1;
      else funnelCompletions += 1;
    }
  }
  let paidOrders = 0;
  if (orgId) {
    paidOrders = (await listOrders(tenantId, orgId)).filter((o) => o.contactId === contactId && o.status !== 'canceled' && o.status !== 'pending').length;
  }
  const score = funnelViews * LEAD_SCORE_WEIGHTS.view
    + funnelCompletions * LEAD_SCORE_WEIGHTS.completion
    + paidOrders * LEAD_SCORE_WEIGHTS.paidOrder;
  return {
    contactId, score,
    parts: { linkedSessions: sessions.size, funnelViews, funnelCompletions, paidOrders },
    weights: LEAD_SCORE_WEIGHTS,
  };
}
