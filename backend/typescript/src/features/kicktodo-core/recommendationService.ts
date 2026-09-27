/**
 * ADR 0692 — KickTodo-local recommendations: "what next" for a signed-in
 * participant, derived from their OWN enrollments and the catalog's depth facet.
 *
 * Why this is local and not the platform `recommendations` feature: that
 * feature recommends Commerce PRODUCTS over co-purchase affinity built from orders
 * (`features/recommendations/recommendationsService.ts`) and exposes no source
 * registry, so wiring it would either cross the ADR 0001 boundary or recommend
 * only PAID challenges. A challenge is not a product; the signal a participant
 * has is the challenge they finished and the depth they finished it at.
 *
 * Deterministic, explainable, no model, no affinity table. Every recommendation
 * carries a REASON the UI renders verbatim:
 *   starter     — nothing enrolled yet: beginner (or unlabeled) content first
 *   next-depth  — a challenge one level above the deepest level completed
 *   same-depth  — another challenge at the deepest level completed / in flight
 *   more        — anything else not yet started
 * Excluded: any challenge the participant has in flight or has completed.
 * Order within a reason is by title, so two reads agree and a test can pin it.
 *
 * Self-data only: reads the CALLER's enrollments (the same rule as journal/today),
 * never another participant's.
 */
import { listPublished, getChallenge } from './challengeService.js';
import { listEnrollmentsFor } from './enrollmentService.js';
import type { ChallengeDefinition, EnrollmentState } from './types.js';

export type DepthLevel = NonNullable<ChallengeDefinition['depthLevel']>;
export type RecommendationReason = 'starter' | 'next-depth' | 'same-depth' | 'more';

export interface ChallengeRecommendation {
  id: string;
  version: number;
  title: string;
  depthLevel?: DepthLevel;
  reason: RecommendationReason;
}

const DEPTH_RANK: Record<DepthLevel, number> = { beginner: 0, intermediate: 1, advanced: 2 };
const RANKED_DEPTHS: readonly DepthLevel[] = ['beginner', 'intermediate', 'advanced'];
const IN_FLIGHT: ReadonlySet<EnrollmentState> = new Set(['active', 'snoozed', 'escalated']);
const REASON_RANK: Record<RecommendationReason, number> = { 'next-depth': 0, 'same-depth': 1, starter: 2, more: 3 };

export const DEFAULT_RECOMMENDATION_LIMIT = 3;

/** Pure ranking over the caller-provided facts, exported so the rule is testable
 *  without a store: which reason each candidate gets, and the order. */
export function rankRecommendations(input: {
  catalog: readonly Pick<ChallengeDefinition, 'id' | 'version' | 'title' | 'depthLevel'>[];
  /** Challenge ids the participant has in flight or has completed — never recommended. */
  excludeIds: ReadonlySet<string>;
  /** The deepest level the participant has COMPLETED, if any. */
  deepestCompleted: DepthLevel | null;
  /** The deepest level in flight, if any (used only when nothing is completed). */
  deepestInFlight: DepthLevel | null;
  hasAnyEnrollment: boolean;
  limit: number;
}): ChallengeRecommendation[] {
  const anchor = input.deepestCompleted ?? input.deepestInFlight;
  const next: DepthLevel | null = input.deepestCompleted
    ? (RANKED_DEPTHS[DEPTH_RANK[input.deepestCompleted] + 1] ?? null)
    : null;
  const reasonFor = (c: Pick<ChallengeDefinition, 'depthLevel'>): RecommendationReason => {
    if (!input.hasAnyEnrollment) return c.depthLevel === 'beginner' || c.depthLevel === undefined ? 'starter' : 'more';
    if (next && c.depthLevel === next) return 'next-depth';
    if (anchor && c.depthLevel === anchor) return 'same-depth';
    return 'more';
  };
  return input.catalog
    .filter((c) => !input.excludeIds.has(c.id))
    .map((c): ChallengeRecommendation => ({
      id: c.id, version: c.version, title: c.title, ...(c.depthLevel ? { depthLevel: c.depthLevel } : {}), reason: reasonFor(c),
    }))
    .sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .slice(0, input.limit);
}

export async function recommendedChallengesFor(
  tenantId: string,
  ownerSubject: string,
  limit: number = DEFAULT_RECOMMENDATION_LIMIT,
): Promise<ChallengeRecommendation[]> {
  const [catalog, enrollments] = await Promise.all([listPublished(tenantId), listEnrollmentsFor(tenantId, ownerSubject)]);
  const excludeIds = new Set<string>();
  let deepestCompleted: DepthLevel | null = null;
  let deepestInFlight: DepthLevel | null = null;
  for (const e of enrollments) {
    if (IN_FLIGHT.has(e.state) || e.state === 'completed') excludeIds.add(e.challengeId);
    if (e.state !== 'completed' && !IN_FLIGHT.has(e.state)) continue;
    const c = await getChallenge(tenantId, e.challengeId, e.challengeVersion);
    const depth = c?.depthLevel;
    if (!depth) continue;
    if (e.state === 'completed') {
      if (deepestCompleted === null || DEPTH_RANK[depth] > DEPTH_RANK[deepestCompleted]) deepestCompleted = depth;
    } else if (deepestInFlight === null || DEPTH_RANK[depth] > DEPTH_RANK[deepestInFlight]) {
      deepestInFlight = depth;
    }
  }
  return rankRecommendations({
    catalog, excludeIds, deepestCompleted, deepestInFlight, hasAnyEnrollment: enrollments.length > 0, limit,
  });
}
