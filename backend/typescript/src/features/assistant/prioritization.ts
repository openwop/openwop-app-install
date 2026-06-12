/**
 * Prioritization layer (ADR 0023 §4) — the tunable, signal-based scorer that
 * decides, for everything the loops emit, what SURFACES to the principal, what
 * the assistant may HANDLE silently, and what it DEFERS.
 *
 * Pure + deterministic (so a run's decision is replay-stable). The coarse knob is
 * a PROFILE (conservative│balanced│aggressive) — a toggle variant binding, stamped
 * into run.metadata.featureVariant at run creation. The fine knob is per-tenant
 * weights/thresholds. Both are passed in here; this module owns only the math.
 */

export type PriorityBucket = 'surface' | 'handle' | 'defer';

/** The signals the scorer reads, each normalized to 0..1 by the caller. */
export interface PrioritySignals {
  /** sender / stakeholder importance (StakeholderProfile.importance / 100). */
  senderImportance: number;
  /** deadline proximity — 1 = overdue/now, 0 = far away / none. */
  deadlineProximity: number;
  /** owning project priority (Project.priority / 100). */
  projectPriority: number;
  /** prior engagement — 1 = active recent thread, 0 = cold. */
  priorEngagement: number;
}

export interface PriorityWeights {
  senderImportance: number;
  deadlineProximity: number;
  projectPriority: number;
  priorEngagement: number;
}

export interface PriorityProfile {
  key: 'conservative' | 'balanced' | 'aggressive';
  weights: PriorityWeights;
  /** score ≥ surfaceAt ⇒ surface to the principal. */
  surfaceAt: number;
  /** score < deferBelow ⇒ defer; between ⇒ handle (within the approval policy). */
  deferBelow: number;
}

/**
 * Built-in profiles. `conservative` surfaces more (low bar → ask the human often);
 * `aggressive` handles/defers more (high bar → only the most important reach the
 * human). `balanced` is the default. Weights sum to 1.0.
 */
export const PRIORITY_PROFILES: Record<PriorityProfile['key'], PriorityProfile> = {
  conservative: {
    key: 'conservative',
    weights: { senderImportance: 0.3, deadlineProximity: 0.3, projectPriority: 0.2, priorEngagement: 0.2 },
    surfaceAt: 0.35,
    deferBelow: 0.15,
  },
  balanced: {
    key: 'balanced',
    weights: { senderImportance: 0.3, deadlineProximity: 0.3, projectPriority: 0.25, priorEngagement: 0.15 },
    surfaceAt: 0.55,
    deferBelow: 0.3,
  },
  aggressive: {
    key: 'aggressive',
    weights: { senderImportance: 0.35, deadlineProximity: 0.35, projectPriority: 0.2, priorEngagement: 0.1 },
    surfaceAt: 0.7,
    deferBelow: 0.45,
  },
};

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Weighted-sum score in 0..1. */
export function priorityScore(signals: PrioritySignals, weights: PriorityWeights): number {
  const w = weights;
  const total = w.senderImportance + w.deadlineProximity + w.projectPriority + w.priorEngagement || 1;
  const raw =
    clamp01(signals.senderImportance) * w.senderImportance +
    clamp01(signals.deadlineProximity) * w.deadlineProximity +
    clamp01(signals.projectPriority) * w.projectPriority +
    clamp01(signals.priorEngagement) * w.priorEngagement;
  return raw / total;
}

/** Map an ISO due date to a deadline-proximity signal (overdue/now → 1). */
export function deadlineProximityOf(dueAtIso: string | undefined, nowMs: number): number {
  if (!dueAtIso) return 0;
  const due = Date.parse(dueAtIso);
  if (!Number.isFinite(due)) return 0;
  const days = (due - nowMs) / 86_400_000;
  if (days <= 0) return 1; // overdue or now
  if (days >= 14) return 0; // two weeks+ out
  return 1 - days / 14;
}

/** The decision: score → bucket, given a profile. */
export function prioritize(signals: PrioritySignals, profile: PriorityProfile): { score: number; bucket: PriorityBucket } {
  const score = priorityScore(signals, profile.weights);
  const bucket: PriorityBucket = score >= profile.surfaceAt ? 'surface' : score < profile.deferBelow ? 'defer' : 'handle';
  return { score, bucket };
}

/** Map a priority score to the kanban card priority lane. */
export function scoreToCardPriority(score: number): 'low' | 'normal' | 'high' {
  return score >= 0.66 ? 'high' : score >= 0.33 ? 'normal' : 'low';
}
