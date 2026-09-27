/**
 * Contact propensity scoring (ADR 0265 / CDP-C) — a lead/engagement score.
 *
 * REUSES the priority-matrix weighted-scoring engine (`computePriority`) rather
 * than a bespoke or ML scorer (ADR 0262 / architect: reuse the ONE weighted-sum
 * engine, retargeted at contacts). The per-trait scores are derived purely from the
 * contact (recency, profile completeness, lifecycle stage) — no external store — so
 * it is deterministic + replay-safe (segments are live reads, not run-stamped).
 * Transparent + explainable: the same weighted factors the priority-matrix UI shows.
 */
import { computePriority } from '../priority-matrix/scoring.js';
import type { CriteriaSet } from '../priority-matrix/types.js';
import type { Contact } from './contactsService.js';

/** The default propensity model — weighted trait factors (config could later be
 *  per-tenant; the engine + explainer surfaces are inherited from priority-matrix). */
export const DEFAULT_PROPENSITY: CriteriaSet = {
  aggregation: 'weighted-sum',
  criteria: [
    { id: 'recency', name: 'Recency', weight: 4, direction: 'benefit' },
    { id: 'completeness', name: 'Profile completeness', weight: 3, direction: 'benefit' },
    { id: 'stage', name: 'Lifecycle stage', weight: 5, direction: 'benefit' },
  ],
};

const STAGE_SCORE: Record<string, number> = { lead: 4, qualified: 7, customer: 10, churned: 1 };

function daysSince(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : 0;
}
const clamp10 = (n: number): number => Math.max(0, Math.min(10, n));

/** Per-contact propensity 0..10 (higher = more engaged/valuable). */
export function contactPropensity(contact: Contact, set: CriteriaSet = DEFAULT_PROPENSITY): number {
  const identifierCount = (contact.identifiers?.length ?? 0) + (contact.email ? 1 : 0);
  const scores: Record<string, number> = {
    recency: clamp10(10 - daysSince(contact.updatedAt) / 3),
    completeness: clamp10(identifierCount * 2 + (contact.company ? 2 : 0)),
    stage: STAGE_SCORE[contact.stage] ?? 3,
  };
  return computePriority(set, scores);
}
