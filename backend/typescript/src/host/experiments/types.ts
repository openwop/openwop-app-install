/**
 * ADR 0949 D1 — the one experiment model. Core (`host/experiments/`), imported
 * by features, never the reverse. Every experiment-shaped surface (CMS page,
 * funnel step, and later email, ads, social) stores its experiments here.
 */

export type ExperimentMode = 'decide' | 'optimize';
export type ExperimentStatus = 'proposed' | 'draft' | 'running' | 'stopped'
  | 'concluded' | 'promoting' | 'promoted' | 'rolled_back' | 'abandoned';
export type UnitKind = 'visitor' | 'contact' | 'platform' | 'geo';

export interface MetricRef { kind: string; name: string }

/** `ref` is what the arm serves on its surface (a CMS version id, a funnel page
 *  id …); null = the holdout / live content. Index 0 is the control. */
export interface Arm { key: string; ref: string | null; weight: number }
export interface Factor { factorId: string; levels: { key: string; ref: string }[] }

export interface AllocationEpoch {
  epoch: number;
  weights: Record<string, number>;
  at: string;
  reason: 'launch' | 'optimize' | 'ramp' | 'rollback';
  decidedByRunId?: string;
  /** ADR 0950 D3 — a ramp's band layout in bucket order (a key may repeat);
   *  when present it decides assignment, and `weights` is its per-arm total. */
  layout?: Array<{ key: string; weight: number }>;
  /** ADR 0950 — the promotion stage this epoch applied (its idempotency key). */
  stage?: number;
}

export interface PreRegistration {
  primaryMetric: MetricRef;
  guardrails: { metric: MetricRef; direction: 'up_is_bad' | 'down_is_bad'; niMargin: number }[];
  /** ADR 0949 P2a — the expected control conversion rate the power calculation
   *  starts from (absolute, in (0, 1)); `mde` is an absolute lift on it. */
  baselineRate: number;
  mde: number; alpha: number; power: number; fdrQ: number;
  minDays: number;
  minSamplePerArm: number;
  maxDays: number;
  cuped?: { covariate: MetricRef };
  lockedAt: string; planHash: string;
}

/** The editable half of a pre-registration (no derived or locked fields). */
export interface PlanInput {
  primaryMetric: MetricRef;
  guardrails: PreRegistration['guardrails'];
  baselineRate: number;
  mde: number; alpha: number; power: number; fdrQ: number;
  minDays: number;
  maxDays: number;
}

export interface Experiment {
  experimentId: string;
  tenantId: string;
  /** The client org (ADR 0921). */
  orgId: string;
  campaignId?: string;
  variantSetId?: string;
  name: string;
  hypothesis: string;
  /** e.g. `{kind: 'cms.page', ref: pageId}`. */
  surface: { kind: string; ref: string };
  unit: UnitKind;
  design: { type: 'ab' | 'abn' | 'mvt'; factors?: Factor[] };
  arms: Arm[];
  mode: ExperimentMode;
  status: ExperimentStatus;
  /** Fixed at creation; assignment stays sticky for the experiment's life. */
  salt: string;
  /** The scope string the legacy assignment hashed on, when it is not the
   *  experiment id (funnel steps hash on `funnel:<id>:step:<id>`). Absent ⇒ the
   *  experiment id, so a migrated assignment stays byte-identical. */
  assignmentScope?: string;
  plan?: PreRegistration;
  /** ADR 0949 P2a — the unlocked plan a draft is being edited towards. Locking
   *  validates it, derives the sample size and moves it to `plan`. */
  planDraft?: PlanInput;
  optimize?: { rewardMetric: MetricRef; floorPct: number; epochMinutes: number };
  /** ADR 0949 P4 — set by the epoch job once the first-exposure store holds the
   *  cap for this experiment; new units are then hashed, not recorded. */
  stickinessCapped?: boolean;
  /** ADR 0950 — the promotion: which arm, what it replaced (the surface's
   *  baseline content, recorded at finalize so a rollback can restore it). */
  promotion?: { winner: string; holdoutPct: number; baselineRef?: string | null; finalizeRequestedAt?: string; finalizedAt?: string; pendingApproval?: boolean; rolledBackAt?: string; contentRestoredAt?: string };
  /** Initial gate evidence, frozen by the promotion reservation CAS. */
  promotionGate?: PromotionAdmission;
  /** ADR 0950 P2 — the ONE run allowed to promote this experiment (bare run id).
   *  Claimed by `startPromotion` before the run starts; every promotion node
   *  refuses any other run, so a copy of the chain launched by hand changes nothing. */
  promotionRunId?: string;
  /** Reservation time: a run not inserted yet keeps its claim through the startup grace. */
  promotionRunClaimedAt?: string;
  epochs: AllocationEpoch[];
  /** A pre-engine experiment migrated as-is (ADR 0949 D5): it keeps assigning
   *  byte-identically and its manual promote, and cannot enter ADR 0950 until it
   *  is relaunched with a plan. */
  legacy?: true;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
}

/** Host-owned admission evidence. Resumed stages use their own allocation and
 * cohort; they do not elect a new winner against the launch allocation. */
export interface PromotionAdmission {
  winner: string;
  planHash: string;
  cellsHash: string;
  checkedAt: string;
  resumedFromStage?: number;
  epoch?: number;
}
