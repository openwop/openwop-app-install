/**
 * ADR 0534 P3 — the work-selection compiler, wired to the core seam.
 *
 * Thin by design. The ranking engine is `host/weightedScoring.ts` (P0) and the
 * policy is `./compiler.ts` (P1); this only resolves the per-tenant toggle and
 * adapts the two to the seam's shape.
 *
 * Returning `null` when the toggle is off is deliberate and distinct from
 * throwing: core reads `null` as "not applicable" and uses insertion order
 * without logging a fault, so a tenant that simply has the feature off produces
 * no noise.
 */

import { rankByPriority } from '../../host/weightedScoring.js';
import type { WorkSelectionCompiler, WorkSelectionPick } from '../../host/heartbeatService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { WORK_SELECTION_CRITERIA, projectCardScores } from './compiler.js';

export const WORK_SELECTION_TOGGLE = 'work-selection';

/**
 * Identifier stamped into `run.metadata` beside the decision, so a replayed run
 * records WHICH policy ranked it. Bump when the criteria set or projection
 * changes in a way that would rank differently — a stamp that cannot distinguish
 * two policies cannot explain a historical pick.
 */
export const WORK_SELECTION_POLICY = 'work-selection@1';

/**
 * Whether ranking is on for this tenant.
 *
 * `resolveOne` is the request-less evaluator (`requireFeatureEnabled` needs a
 * `req`, and the heartbeat daemon has none). `bucketUnit: 'tenant'` makes the
 * tenantId a complete subject — no principal to supply, and none exists in a
 * background pass anyway.
 *
 * Fails CLOSED to insertion order: an unresolvable toggle must not silently
 * enable a behaviour change for a tenant that never opted in.
 */
async function rankingEnabled(tenantId: string): Promise<boolean> {
  const assignment = await resolveOne(WORK_SELECTION_TOGGLE, { tenantId });
  return assignment?.enabled === true;
}

/** The seam implementation: rank the candidates, or decline. */
export const workSelectionCompiler: WorkSelectionCompiler = async (cards, now, ctx) => {
  if (!(await rankingEnabled(ctx.tenantId))) return null;

  const ranked = rankByPriority(WORK_SELECTION_CRITERIA, cards, (card) =>
    projectCardScores(card, now),
  );

  return ranked.map<WorkSelectionPick>((r) => ({
    card: r.item,
    rank: r.rank,
    score: r.priority,
    scores: projectCardScores(r.item, now),
  }));
};
