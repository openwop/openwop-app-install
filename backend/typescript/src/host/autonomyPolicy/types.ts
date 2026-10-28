/**
 * ADR 0942 D1/D2 — the campaign autonomy policy model. Closed vocabularies only:
 * a class, fact or operator not listed here is refused at save (`validate.ts`),
 * never evaluated. Host layer, because the effect chokepoints that consult it
 * (`adsAdapter`, `smsAdapter`, approval decide) are host modules (the ADR
 * 0028/0036 placement).
 *
 * @see docs/adr/0942-campaign-autonomy-policy.md
 */

/** D1 — the twenty action classes. Adding one is a code change here plus its chokepoint. */
export const ACTION_CLASSES = [
  'creative.generate',
  'plan.approve',
  'creative.review',
  'content.publish',
  'ads.publish',
  'ads.launch',
  'ads.budget',
  'email.campaign-send',
  'sms.send',
  'social.post',
  'experiment.promote',
  'lead.contact',
  'lead.grade-adjust',
  'journey.publish',
  'email.resume-sending',
  'report.publish',
  'asset.accept-vendor',
  'vendor.engage',
  'playbook.rollout',
  'campaign.change-set.apply',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** `creative.review` is staged (ADR 0947); a rule may target one stage. */
export const REVIEW_STAGES = ['internal', 'compliance', 'client'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** Classes whose effect leaves the host (D10.3/D10.4 floors apply to these). */
export const NON_EXTERNAL_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'creative.generate', 'plan.approve', 'creative.review',
]);

/** Classes that may never be looser than `approve` (D2: `email.resume-sending`). */
export const APPROVE_FLOOR_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>(['email.resume-sending']);

/** Classes on which `clientApprover` is accepted in v1 (ADR 0942 Q4). */
export const CLIENT_APPROVER_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>(['campaign.change-set.apply']);

export const OUTCOMES = ['auto', 'notify-after', 'approve', 'blocked'] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** Severity order: blocked > approve > notify-after > auto. */
export const SEVERITY: Readonly<Record<Outcome, number>> = { auto: 0, 'notify-after': 1, approve: 2, blocked: 3 };

/** D2 — the risk facts a chokepoint or gate supplies. Value type per fact. */
export const FACT_TYPES = {
  spendMinor: 'number',
  spendDeltaPct: 'number',
  audienceSize: 'number',
  findingsCritical: 'number',
  findingsHigh: 'number',
  regulatedCategory: 'boolean',
  confidence: 'number',
  firstForDestination: 'boolean',
} as const;
export type RiskFact = keyof typeof FACT_TYPES;
export type RiskFacts = { [K in RiskFact]?: (typeof FACT_TYPES)[K] extends 'number' ? number : boolean };

export const CONDITION_OPS = ['>=', '>', '<=', '<', '==', 'in'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export interface Condition { fact: RiskFact; op: ConditionOp; value: number | boolean | string[] }

export interface PerPartyQuorum { party: 'agency' | 'client'; refs: 'roleRefs' | 'clientApprover'; min: 1 | 2 }

export interface ApproverSpec {
  /** ADR 0075 refs, resolved on the CLIENT org. */
  roleRefs?: string[];
  groupRefs?: string[];
  subjectRefs?: string[];
  /** An ADR 0958 client-stakeholder `decide` grant; v1 only on `campaign.change-set.apply`. */
  clientApprover?: boolean;
  requiredApprovals: 1 | 2 | 3;
  rejectionPolicy?: 'any' | 'majority';
  /** ADR 0942 D9 (as corrected 2026-10-19): per-party quorum. Required whenever
   *  `clientApprover` is mixed with role/group refs — a bare count never stands in
   *  for "one of each". */
  perParty?: PerPartyQuorum[];
  delegation: 'allowed' | 'none';
  /** Expire = reject (RFC 0093). */
  sla?: { remindAfterMs?: number; escalateAfterMs?: number; expireAfterMs?: number };
  escalateTo?: { roleRefs: string[] };
}

export const NOTIFY_CHANNELS = ['inbox', 'email', 'teams', 'push'] as const;
export interface NotifySpec {
  roleRefs?: string[];
  subjectRefs?: string[];
  channels: Array<(typeof NOTIFY_CHANNELS)[number]>;
  digest: 'immediate' | 'daily';
  /** ADR 0950 veto window; minimum 1 h when set. */
  vetoWindowMs?: number;
}

export type Decision =
  | { outcome: 'auto' }
  | { outcome: 'notify-after'; notify: NotifySpec }
  | { outcome: 'approve'; approver: ApproverSpec; notify?: NotifySpec }
  | { outcome: 'blocked'; reason: string };

export interface ActionRule {
  actionClass: ActionClass;
  /** `creative.review` only. Absent on a creative.review rule ⇒ every stage. */
  stage?: ReviewStage;
  default: Decision;
  /** AND within one entry; first match wins. Each `then` is at least as severe as `default`. */
  escalations?: Array<{ when: Condition[]; then: Decision }>;
}

export const PRESET_IDS = ['review-everything@1', 'guarded@1', 'autopilot@1'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** An immutable policy version (custom rules). Presets are code constants with no row. */
export interface AutonomyPolicy {
  tenantId: string;
  policyId: string;
  version: number;
  name: string;
  basePreset?: PresetId;
  rules: ActionRule[];
  /** sha256(canonicalJSON({basePreset, rules})) — the replay identity. */
  hash: string;
  createdBy: string;
  createdAt: string;
}

/** Which policy a client (campaignId absent) or a campaign uses. */
export interface AutonomyBinding {
  tenantId: string;
  orgId: string;
  campaignId?: string;
  /** `preset:<name>` for a preset (version = the preset version), else an `apol_` id. */
  policyId: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** The policy a resolution runs under, materialized (custom row or preset). */
export interface ResolvedPolicy {
  policyId: string;
  version: number;
  name: string;
  basePreset?: PresetId;
  rules: ActionRule[];
  hash: string;
}
