/**
 * Challenge Plan + daily decomposition (ADR 0415 P2; PRD §7.3 workflows 3–4).
 *
 * The PLAN is the cross-workflow contract for one challenge. Generation is
 * model work (the AI structured-output seam composes these schemas); this
 * module owns what must NEVER be model judgment:
 *
 *  - `validatePlan` — the deterministic gate (PRD §7.3 W3): measurable
 *    outcomes, orphan-achievement detection, action→achievement→outcome
 *    traceability, plausible daily load, duration bounds. A failing plan is a
 *    TYPED rejection listing every defect (error-fed repair is the caller's
 *    ONE bounded retry), never success-with-empty.
 *  - `validateDays` — the daily-quality gate (PRD §7.3 W4 rules): one primary
 *    action per day, disclosed time budget, day coverage without stacking,
 *    recovery presence for spans ≥ 7 days.
 *  - `draftFromPlan` — the deterministic transform of a VALIDATED plan into a
 *    `kicktodo-core` ChallengeDefinition draft (the single challenge owner);
 *    the factory never invents a second challenge store.
 */

import { createHash } from 'node:crypto';
import { createDraft } from '../kicktodo-core/challengeService.js';
import type { ChallengeDefinition } from '../kicktodo-core/types.js';

/** KT-EXP-8 / ADR 0441 §4 — the deterministic draft id for a candidate: one draft
 *  per (tenant, candidate), so a re-decompose overwrites instead of orphaning. The
 *  `ktc-` prefix keeps it distinct from the manual route's random `chal:<uuid>`. */
function candidateDraftId(tenantId: string, candidateId: string): string {
  return `chal:ktc-${createHash('sha256').update(`${tenantId}|${candidateId}`).digest('hex').slice(0, 32)}`;
}

// ── Plan-shape vocabulary (XCH-KT-1) — ONE source for the TS types, the
// deterministic validator's bounds, and the JSON schema the model receives.
// A bound changed here changes all three together; nothing is hand-copied.
export const PLAN_EVIDENCE_POLICIES = ['attestation', 'note', 'photo', 'measurement'] as const;
export type EvidencePolicy = (typeof PLAN_EVIDENCE_POLICIES)[number];
export const PLAN_DEPTH_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type DepthLevel = (typeof PLAN_DEPTH_LEVELS)[number];
export const PLAN_DURATION_DAYS = { min: 3, max: 60 } as const;
export const PLAN_DAILY_MINUTES = { min: 5, max: 120 } as const;

export interface PlanOutcome {
  outcomeId: string;
  measurableOutcome: string;
  method: string;
}

export interface PlanAchievement {
  achievementId: string;
  observableEvidence: string;
  outcomeIds: string[];
}

export interface PlanDay {
  day: number;
  stableActivityId: string;
  title: string;
  actionInstruction: string;
  userFacingWhy: string;
  estimatedMinutes: number;
  achievementIds: string[];
  evidencePolicy: EvidencePolicy;
  isRecovery?: boolean;
  /** ADR 0458 §2.2 (correction, 2026-09-15) — the dossier claim ids this day's
   *  `userFacingWhy` / `actionInstruction` rely on. Closed-world against the
   *  candidate's dossier when `validatePlan` is given `knownClaimIds`; carried
   *  verbatim onto the draft activity. Empty means "instruction only — no
   *  factual statement beyond the day's own rationale". */
  claimRefs?: string[];
  /** ADR 0429 P4 — publisher-declared substitutions for this day. The factory
   *  emits them (accessibility alternatives are already a research question)
   *  and the deterministic validator enforces the same parity rule the
   *  publish gate does, so a factory-authored challenge ships substitutable
   *  by construction rather than by hope. */
  alternatives?: Array<{
    stableActivityId: string;
    title: string;
    actionInstruction: string;
    evidencePolicy: EvidencePolicy;
  }>;
}

export interface ChallengePlan {
  title: string;
  promise: string;
  audience: string;
  durationDays: number;
  dailyMinutesBudget: number;
  /** ADR 0443 R4 — optional content-depth facet, authored with the plan and
   *  carried onto the draft (frozen at publish like the rest of the body). */
  depthLevel?: DepthLevel;
  outcomes: PlanOutcome[];
  achievements: PlanAchievement[];
  days: PlanDay[];
}

export interface PlanDefect {
  code: string;
  message: string;
  ref?: string;
}

/**
 * XCH-KT-1 — the authoritative JSON Schema for a ChallengePlan, built from the
 * SAME vocabulary constants `semanticPlanDefects` enforces. This is what the
 * plan-generate node fetches at call time (surface `planSchema`) and hands the
 * model as `responseSchema` + prompt grounding — replacing the hand-authored
 * prose shape that could drift from the validator. Cross-reference rules
 * (achievement→outcome tracing, day workload, recovery cadence) are NOT
 * expressible here; they remain the validator's job, fed back through the
 * node's bounded repair.
 */
export const CHALLENGE_PLAN_JSON_SCHEMA = {
  type: 'object',
  description: 'A KickTodo challenge plan. The host validates authoritatively after generation.',
  additionalProperties: false,
  required: ['title', 'promise', 'audience', 'durationDays', 'dailyMinutesBudget', 'outcomes', 'achievements', 'days'],
  properties: {
    title: { type: 'string', minLength: 1 },
    promise: { type: 'string', minLength: 1, description: 'What the participant will be able to do.' },
    audience: { type: 'string' },
    durationDays: { type: 'integer', minimum: PLAN_DURATION_DAYS.min, maximum: PLAN_DURATION_DAYS.max },
    dailyMinutesBudget: { type: 'integer', minimum: PLAN_DAILY_MINUTES.min, maximum: PLAN_DAILY_MINUTES.max },
    depthLevel: { type: 'string', enum: [...PLAN_DEPTH_LEVELS] },
    outcomes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['outcomeId', 'measurableOutcome', 'method'],
        properties: {
          outcomeId: { type: 'string', minLength: 1 },
          measurableOutcome: { type: 'string', minLength: 1 },
          method: { type: 'string', minLength: 1 },
        },
      },
    },
    achievements: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['achievementId', 'observableEvidence', 'outcomeIds'],
        properties: {
          achievementId: { type: 'string', minLength: 1 },
          observableEvidence: { type: 'string', minLength: 1 },
          outcomeIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        },
      },
    },
    days: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'stableActivityId', 'title', 'actionInstruction', 'userFacingWhy', 'estimatedMinutes', 'achievementIds', 'evidencePolicy'],
        properties: {
          day: { type: 'integer', minimum: 1 },
          stableActivityId: { type: 'string', minLength: 1, description: 'kebab-case, unique across the plan' },
          title: { type: 'string', minLength: 1 },
          actionInstruction: { type: 'string', minLength: 1 },
          userFacingWhy: { type: 'string', minLength: 1 },
          estimatedMinutes: { type: 'integer', minimum: 1 },
          achievementIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          evidencePolicy: { type: 'string', enum: [...PLAN_EVIDENCE_POLICIES] },
          isRecovery: { type: 'boolean' },
          claimRefs: {
            type: 'array',
            description: 'The claimIds from the EVIDENCE this day\'s why/instruction rely on. Only ids the evidence lists are accepted; an empty array means the day makes no factual claim beyond its own instruction.',
            items: { type: 'string', minLength: 1 },
          },
          alternatives: {
            type: 'array',
            description: 'ADR 0429 P4 publisher-declared substitutions; each must carry the SAME evidencePolicy as its parent day.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['stableActivityId', 'title', 'actionInstruction', 'evidencePolicy'],
              properties: {
                stableActivityId: { type: 'string', minLength: 1 },
                title: { type: 'string', minLength: 1 },
                actionInstruction: { type: 'string', minLength: 1 },
                evidencePolicy: { type: 'string', enum: [...PLAN_EVIDENCE_POLICIES] },
              },
            },
          },
        },
      },
    },
  },
} as const;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * GC-4 — STRUCTURAL gate, run before any semantic check.
 *
 * `validatePlan` receives untrusted model output (the workflow node forwards
 * `args.plan` as `unknown`). The semantic checks below field-access
 * `plan.outcomes.map`, `plan.days`, `d.achievementIds.some`, `plan.title.trim`
 * — every one throws an uncaught `TypeError` on a shape the model can plausibly
 * emit (a non-array `outcomes`, a day missing `achievementIds`, a null plan).
 * That crash became a raw 500 instead of the typed `plan_invalid` defect list
 * the ADR 0315 "invalid model output is a typed failure, never a crash"
 * invariant and the bounded repair loop require. The old
 * `as unknown as ChallengePlan` cast at the call sites CONCEALED this by telling
 * the compiler the input was already valid.
 *
 * This returns structural defects into the SAME `PlanDefect[]` the repair loop
 * reads; a `ChallengePlan` type predicate (below) narrows without a cast once
 * structure holds, so zero defects ⇒ the semantic pass and `draftFromPlan`'s
 * `.map`s cannot throw.
 */
function structuralPlanDefects(input: unknown): PlanDefect[] {
  if (!isRecord(input)) return [{ code: 'plan-not-object', message: 'The plan must be an object.' }];
  const defects: PlanDefect[] = [];
  // Each collection must be an array whose ELEMENTS are objects — the semantic
  // pass dereferences `o.outcomeId` / `a.achievementId` / `d.stableActivityId`
  // without null-guards, so a `[null]` or `[3]` element would throw. Checking
  // element records here (not just top-level array-ness) is what makes the
  // `isChallengePlan` predicate below HONEST rather than over-promising.
  if (!Array.isArray(input.outcomes) || input.outcomes.some((o) => !isRecord(o))) {
    defects.push({ code: 'outcomes-malformed', message: '`outcomes` must be an array of objects.' });
  }
  if (!Array.isArray(input.achievements) || input.achievements.some((a) => !isRecord(a))) {
    defects.push({ code: 'achievements-malformed', message: '`achievements` must be an array of objects.' });
  }
  if (!Array.isArray(input.days)) {
    defects.push({ code: 'days-not-array', message: '`days` must be an array.' });
  } else {
    for (const d of input.days) {
      // A day must be an object with an `achievementIds` array; `alternatives`,
      // if present, must be an array (the `for…of` at the substitution check
      // would throw on a non-iterable).
      if (!isRecord(d) || !Array.isArray(d.achievementIds) || (d.alternatives !== undefined && !Array.isArray(d.alternatives))) {
        defects.push({ code: 'day-malformed', message: 'Every day must be an object with an `achievementIds` array (and an array `alternatives` if present).' });
        break; // one structural report is enough; the model must re-emit
      }
    }
  }
  return defects;
}

/** True once `structuralPlanDefects` is empty — every collection is an array of
 *  objects and each day is well-shaped, so the semantic pass and
 *  `draftFromPlan` can field-access without a cast or a throw. The predicate now
 *  VERIFIES what it asserts (the code-review's HIGH-#2 correction). */
export function isChallengePlan(input: unknown): input is ChallengePlan {
  return structuralPlanDefects(input).length === 0;
}

/** Deterministic plan gate — every defect reported, none silently fixed.
 *  TOTAL over `unknown`: a malformed plan yields a defect list, never a throw. */
/** ADR 0458 §2.2 (correction) — the closed world a plan's `claimRefs` must live
 *  in: the candidate's SUPPORTED claim ids (`supportedClaimIds`). `knownClaimIds`
 *  absent ⇒ refs are not checked (a plan validated with no dossier in scope keeps
 *  its prior meaning); present ⇒ every ref must match. */
export interface PlanValidationOptions {
  knownClaimIds?: readonly string[];
}

export function validatePlan(input: unknown, opts?: PlanValidationOptions): PlanDefect[] {
  const structural = structuralPlanDefects(input);
  if (structural.length || !isChallengePlan(input)) return structural;
  try {
    return semanticPlanDefects(input).concat(claimRefDefects(input, opts?.knownClaimIds));
  } catch {
    // GC-4 totality backstop. The structural gate names the COMMON malformations
    // (non-object plan, non-array outcomes/days, a day without achievementIds),
    // but it cannot cheaply type-check every ELEMENT field — an `outcomes:[null]`,
    // a numeric `measurableOutcome`, an `achievements:[3]` would still make a
    // semantic access (`o.outcomeId`, `.trim()`) throw. Any input that breaks the
    // validator is, by definition, an invalid plan: report it as a defect, never
    // a raw 500. A plan reaching zero defects has therefore passed every
    // element-level check, so `draftFromPlan`'s `.map`s remain safe.
    return [{ code: 'plan-malformed', message: 'The plan contains malformed elements.' }];
  }
}

/** Every `claimRefs` entry must be a non-empty string naming a claim the dossier
 *  recorded. A model that cites a claim id nobody extracted is the plan-level
 *  form of a fabricated citation, and it fails the same way an orphan
 *  achievement does: a typed defect the bounded repair sees verbatim. */
function claimRefDefects(plan: ChallengePlan, knownClaimIds: readonly string[] | undefined): PlanDefect[] {
  const defects: PlanDefect[] = [];
  const known = knownClaimIds ? new Set(knownClaimIds) : null;
  for (const d of plan.days ?? []) {
    if (d.claimRefs === undefined) continue;
    if (!Array.isArray(d.claimRefs) || d.claimRefs.some((r) => typeof r !== 'string' || r.trim().length === 0)) {
      defects.push({ code: 'claim-refs-malformed', message: '`claimRefs` must be an array of non-empty claim ids.', ref: d.stableActivityId });
      continue;
    }
    if (!known) continue;
    const unknown = d.claimRefs.filter((r) => !known.has(r));
    if (unknown.length) {
      defects.push({ code: 'claim-ref-unknown', message: `claimRefs name claims the research did not record or does not support: ${unknown.join(', ')}. Cite only SUPPORTED ids from the EVIDENCE, or use an empty array.`, ref: d.stableActivityId });
    }
  }
  return defects;
}

function semanticPlanDefects(plan: ChallengePlan): PlanDefect[] {
  const defects: PlanDefect[] = [];
  if (!plan.title?.trim()) defects.push({ code: 'title-missing', message: 'The plan needs a title.' });
  if (!Number.isInteger(plan.durationDays) || plan.durationDays < PLAN_DURATION_DAYS.min || plan.durationDays > PLAN_DURATION_DAYS.max) {
    defects.push({ code: 'duration-implausible', message: `durationDays must be an integer in [${PLAN_DURATION_DAYS.min}, ${PLAN_DURATION_DAYS.max}].` });
  }
  if (!Number.isFinite(plan.dailyMinutesBudget) || plan.dailyMinutesBudget < PLAN_DAILY_MINUTES.min || plan.dailyMinutesBudget > PLAN_DAILY_MINUTES.max) {
    defects.push({ code: 'budget-implausible', message: `dailyMinutesBudget must be in [${PLAN_DAILY_MINUTES.min}, ${PLAN_DAILY_MINUTES.max}] minutes.` });
  }
  if (!plan.outcomes?.length) defects.push({ code: 'no-outcomes', message: 'At least one measurable outcome is required.' });

  const outcomeIds = new Set((plan.outcomes ?? []).map((o) => o.outcomeId));
  for (const o of plan.outcomes ?? []) {
    if (!o.measurableOutcome?.trim() || !o.method?.trim()) {
      defects.push({ code: 'outcome-unmeasurable', message: 'Every outcome needs a measurable statement AND a method.', ref: o.outcomeId });
    }
  }

  const achievementIds = new Set<string>();
  for (const a of plan.achievements ?? []) {
    achievementIds.add(a.achievementId);
    if (!a.outcomeIds?.length || a.outcomeIds.some((id) => !outcomeIds.has(id))) {
      defects.push({ code: 'achievement-orphaned', message: 'Every achievement must trace to existing outcomes.', ref: a.achievementId });
    }
  }
  // Coverage: every outcome is served by at least one achievement.
  for (const o of plan.outcomes ?? []) {
    if (!(plan.achievements ?? []).some((a) => a.outcomeIds?.includes(o.outcomeId))) {
      defects.push({ code: 'outcome-unserved', message: 'Every outcome needs at least one achievement.', ref: o.outcomeId });
    }
  }
  for (const d of plan.days ?? []) {
    if (d.achievementIds.some((id) => !achievementIds.has(id))) {
      defects.push({ code: 'day-untraceable', message: 'Every required action must trace to existing achievements.', ref: d.stableActivityId });
    }
    // ADR 0429 P4 — the substitution parity rule, enforced deterministically at
    // AUTHORING time (not just at publish): an alternative carrying a weaker
    // evidence policy would let a participant lower their own evidence bar.
    for (const alt of d.alternatives ?? []) {
      if (!alt.stableActivityId?.trim() || !alt.title?.trim() || !alt.actionInstruction?.trim()) {
        defects.push({ code: 'alternative-incomplete', message: 'Every alternative needs an id, a title, and an instruction.', ref: d.stableActivityId });
        continue;
      }
      if (alt.stableActivityId === d.stableActivityId) {
        defects.push({ code: 'alternative-id-collision', message: 'An alternative may not reuse its parent action id.', ref: d.stableActivityId });
      }
      if (alt.evidencePolicy !== d.evidencePolicy) {
        defects.push({
          code: 'alternative-evidence-mismatch',
          message: 'An alternative must carry the same evidencePolicy as the action it replaces.',
          ref: d.stableActivityId,
        });
      }
    }
  }
  return defects.concat(validateDays(plan));
}

/** Daily-quality gate (PRD §7.3 W4 design rules). */
export function validateDays(plan: ChallengePlan): PlanDefect[] {
  const defects: PlanDefect[] = [];
  const days = plan.days ?? [];
  if (!days.length) return [{ code: 'no-days', message: 'The plan has no daily actions.' }];

  const seenIds = new Set<string>();
  const byDay = new Map<number, PlanDay[]>();
  for (const d of days) {
    if (seenIds.has(d.stableActivityId)) {
      defects.push({ code: 'duplicate-activity-id', message: 'stableActivityId must be unique.', ref: d.stableActivityId });
    }
    seenIds.add(d.stableActivityId);
    if (d.day < 1 || d.day > plan.durationDays) {
      defects.push({ code: 'day-out-of-range', message: `Day ${d.day} is outside [1, ${plan.durationDays}].`, ref: d.stableActivityId });
    }
    if (!d.title?.trim() || !d.actionInstruction?.trim() || !d.userFacingWhy?.trim()) {
      // GC-9 — `title` was unvalidated, so a titleless day passed and
      // `draftFromPlan` produced an activity with an empty title.
      defects.push({ code: 'day-incomplete', message: 'Every action needs a title, an instruction, AND a user-facing why.', ref: d.stableActivityId });
    }
    byDay.set(d.day, [...(byDay.get(d.day) ?? []), d]);
  }
  for (const [day, list] of byDay) {
    const total = list.reduce((sum, d) => sum + (d.estimatedMinutes || 0), 0);
    if (total > plan.dailyMinutesBudget * 1.2) {
      defects.push({ code: 'workload-stacked', message: `Day ${day} totals ${total}min — over the ${plan.dailyMinutesBudget}min budget (+20% tolerance).` });
    }
    if (list.length > 3) {
      defects.push({ code: 'too-many-actions', message: `Day ${day} has ${list.length} actions — one primary action (max 3 total) per day.` });
    }
  }
  // Day-1 must exist (a useful early win) and spans ≥7 days need a recovery day.
  if (!byDay.has(1)) defects.push({ code: 'no-day-one', message: 'Day 1 must carry a useful first action.' });
  if (plan.durationDays >= 7 && !days.some((d) => d.isRecovery)) {
    defects.push({ code: 'no-recovery', message: 'Every 7-day span needs a recovery/consolidation action (PRD daily design rules).' });
  }
  return defects;
}

export class PlanInvalidError extends Error {
  constructor(public readonly defects: PlanDefect[]) {
    super(`The Challenge Plan failed ${defects.length} deterministic gate(s).`);
  }
}

/**
 * Deterministic transform: VALIDATED plan → `kicktodo-core` draft (the ONE
 * challenge owner). Throws `PlanInvalidError` (typed, defect-listing) on any
 * gate failure — never a partial draft.
 */
export async function draftFromPlan(
  tenantId: string,
  authorSubject: string,
  plan: unknown,
  candidateId?: string,
  opts?: PlanValidationOptions,
): Promise<ChallengeDefinition> {
  const defects = validatePlan(plan, opts);
  if (defects.length) throw new PlanInvalidError(defects);
  // GC-4 — validatePlan returned no defects, so the plan is structurally a
  // ChallengePlan and the `.map`s below cannot throw. The guard narrows the type
  // WITHOUT a cast; it is unreachable in practice (empty defects ⇒ true).
  if (!isChallengePlan(plan)) throw new PlanInvalidError([{ code: 'plan-not-object', message: 'The plan must be an object.' }]);
  return await createDraft({
    tenantId,
    authorSubject,
    // KT-EXP-8 — deterministic id when a candidate context is present (the decompose
    // path always has one); absent ⇒ createDraft mints a fresh random id.
    ...(candidateId ? { id: candidateDraftId(tenantId, candidateId) } : {}),
    ...(plan.depthLevel ? { depthLevel: plan.depthLevel } : {}),
    title: plan.title,
    summary: plan.promise,
    outcome: plan.outcomes.map((o) => o.measurableOutcome).join(' · '),
    durationDays: plan.durationDays,
    activities: plan.days.map((d) => ({
      stableActivityId: d.stableActivityId,
      day: d.day,
      title: d.title,
      instructions: `${d.userFacingWhy}\n\n${d.actionInstruction}`,
      estimatedMinutes: d.estimatedMinutes,
      evidencePolicy: d.evidencePolicy,
      // ADR 0458 §2.2 (correction) — provenance rides onto the activity verbatim.
      ...(d.claimRefs?.length ? { claimRefs: [...d.claimRefs] } : {}),
      ...(d.alternatives?.length
        ? {
            alternatives: d.alternatives.map((alt) => ({
              stableActivityId: alt.stableActivityId,
              title: alt.title,
              instructions: alt.actionInstruction,
              evidencePolicy: alt.evidencePolicy,
            })),
          }
        : {}),
    })),
  });
}
