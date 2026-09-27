/**
 * `challenge-outline` canvas ⇄ ChallengePlan mapping (ADR 0458 §2.3 / Phase 3).
 *
 * The canvas is a WORKING DRAFT for structured editing between chat turns. It is
 * NEVER a second plan store: the candidate's validated plan revision is the ONLY
 * truth (`decompose` reads nothing else). This module is the pure, LOSSLESS
 * bridge between the two shapes —
 *
 *   `planToOutlineDoc`  — seed the canvas from a validated plan revision;
 *   `outlineDocToPlan`  — read the edited canvas back into a plan candidate that
 *                         the apply route re-validates with `validatePlan` (the
 *                         draft→validate→persist workflow-author law);
 *   `validateOutlineDoc`— the canvas save/validate hook: STRUCTURE-only (shape),
 *                         because plan-LAW (measurable outcomes, traceability,
 *                         recovery, load) stays with `validatePlan` at apply.
 *
 * `planToOutlineDoc`∘`outlineDocToPlan` round-trips a plan back to itself
 * (deep-equal) for representative plans — the drift-pin the tests hold. The one
 * documented normalization: an EMPTY `alternatives: []` array collapses to
 * absent (a day with no alternatives), matching `draftFromPlan`'s own
 * `d.alternatives?.length` treatment; real generation emits alternatives either
 * absent or non-empty, never `[]`.
 */

import { createHash } from 'node:crypto';
import type { ChallengePlan, PlanDay } from './planService.js';
import type { ComponentDef } from '../../host/canvasComponentCatalog.js';

/** The single collab-capable canvas type + its host-ext root (ADR 0359/0310). */
export const CHALLENGE_OUTLINE_CANVAS_TYPE = 'canvas.challenge-outline';
export const CHALLENGE_OUTLINE_BASE_PATH = '/v1/host/openwop-app/challenge-outline';

/** ADR 0359 Phase 6 — the doc↔Y shape: `frames[].days[].children[]`. Mirrors the
 *  FE `elements` trait (drift-pinned on both sides), the same nested-tree pattern
 *  the app-builder (`screens[].components[]`) and slides (`slides[].blocks[]`) use. */
export const CHALLENGE_OUTLINE_COLLAB_SHAPE = {
  collections: [{ key: 'frames', nested: { field: 'days', childrenKey: 'children' } }],
};

type EvidencePolicy = PlanDay['evidencePolicy'];
type DepthLevel = NonNullable<ChallengePlan['depthLevel']>;
type Alternative = NonNullable<PlanDay['alternatives']>[number];

const EVIDENCE_POLICIES: readonly EvidencePolicy[] = ['attestation', 'note', 'photo', 'measurement'];
const DEPTH_LEVELS: readonly DepthLevel[] = ['beginner', 'intermediate', 'advanced'];

/**
 * ADR 0458 §2.3 — the closed component catalog the FE reads via the canvas
 * `/catalog` route: the outline-tree palette (`day` under the single frame,
 * `alternative` under a day), the property panel (every served prop), and the
 * toolbar quick cluster (its boolean/enum/number props). The served prop NAMES,
 * TYPES, and enum OPTION values are drift-pinned against the FE definition's
 * `quickPropsByType` + `prop_*` / `opt_*` i18n keys — a rename here silently
 * no-ops the FE cluster, so both sides pin the same set. Category `outline`
 * matches the FE palette group's `cat_outline` label.
 */
export const CHALLENGE_OUTLINE_COMPONENTS: readonly ComponentDef[] = [
  {
    type: 'day',
    label: 'Day',
    description: 'One day of the challenge — a single primary action, its rationale, and evidence policy.',
    category: 'outline',
    acceptsChildren: true,
    allowedChildTypes: ['alternative'],
    props: [
      { name: 'title', type: 'string' },
      { name: 'day', type: 'number' },
      { name: 'stableActivityId', type: 'string' },
      { name: 'actionInstruction', type: 'longtext' },
      { name: 'userFacingWhy', type: 'longtext' },
      { name: 'estimatedMinutes', type: 'number' },
      { name: 'evidencePolicy', type: 'enum', options: EVIDENCE_POLICIES },
      { name: 'isRecovery', type: 'boolean' },
      { name: 'achievementIds', type: 'stringlist' },
    ],
  },
  {
    type: 'alternative',
    label: 'Alternative',
    description: 'An accessibility/substitution alternative for its parent day.',
    category: 'outline',
    props: [
      { name: 'title', type: 'string' },
      { name: 'stableActivityId', type: 'string' },
      { name: 'actionInstruction', type: 'longtext' },
      { name: 'evidencePolicy', type: 'enum', options: EVIDENCE_POLICIES },
    ],
  },
];

export interface OutlineAlternativeNode {
  type: 'alternative';
  props: { stableActivityId: string; title: string; actionInstruction: string; evidencePolicy: EvidencePolicy };
}

export interface OutlineDayNode {
  type: 'day';
  props: {
    day: number;
    stableActivityId: string;
    title: string;
    actionInstruction: string;
    userFacingWhy: string;
    estimatedMinutes: number;
    evidencePolicy: EvidencePolicy;
    achievementIds: string[];
    isRecovery?: boolean;
    /** ADR 0458 §2.2 (correction) — dossier claim ids the day relies on. Carried
     *  through the doc so an outline Apply never strips provenance; deliberately
     *  NOT a catalog prop (the property panel is a creator-editing surface and
     *  the FE prop set is drift-pinned) — it is read-only provenance. */
    claimRefs?: string[];
  };
  children: OutlineAlternativeNode[];
}

/** A `type` (not `interface`) so the whole doc is assignable to the canvas
 *  `Json` (`Record<string, unknown>`) initial-state parameter. */
export type OutlineDoc = {
  meta: {
    title: string;
    promise: string;
    audience: string;
    durationDays: number;
    dailyMinutesBudget: number;
    depthLevel?: DepthLevel;
  };
  outcomes: Array<{ outcomeId: string; measurableOutcome: string; method: string }>;
  achievements: Array<{ achievementId: string; observableEvidence: string; outcomeIds: string[] }>;
  /** Exactly ONE frame (`id:'outline'`) — the days tree. The single-frame array
   *  is the collab collection root; multi-frame is not a challenge-outline shape. */
  frames: [{ id: 'outline'; name: string; days: OutlineDayNode[] }];
}

/** Deterministic, tenant-scoped canvas id for a candidate's outline — one canvas
 *  per (tenant, candidate), so the ensure route is idempotent by construction. */
export function outlineCanvasId(tenantId: string, candidateId: string): string {
  return `canvas-outline-${createHash('sha256').update(`${tenantId}|${candidateId}`).digest('hex').slice(0, 32)}`;
}

/** VALIDATED plan → working-draft doc (seed the canvas). */
export function planToOutlineDoc(plan: ChallengePlan): OutlineDoc {
  return {
    meta: {
      title: plan.title,
      promise: plan.promise,
      audience: plan.audience,
      durationDays: plan.durationDays,
      dailyMinutesBudget: plan.dailyMinutesBudget,
      ...(plan.depthLevel !== undefined ? { depthLevel: plan.depthLevel } : {}),
    },
    outcomes: plan.outcomes.map((o) => ({ outcomeId: o.outcomeId, measurableOutcome: o.measurableOutcome, method: o.method })),
    achievements: plan.achievements.map((a) => ({ achievementId: a.achievementId, observableEvidence: a.observableEvidence, outcomeIds: [...a.outcomeIds] })),
    frames: [
      {
        id: 'outline',
        name: plan.title,
        days: plan.days.map((d) => ({
          type: 'day',
          props: {
            day: d.day,
            stableActivityId: d.stableActivityId,
            title: d.title,
            actionInstruction: d.actionInstruction,
            userFacingWhy: d.userFacingWhy,
            estimatedMinutes: d.estimatedMinutes,
            evidencePolicy: d.evidencePolicy,
            achievementIds: [...d.achievementIds],
            ...(d.isRecovery !== undefined ? { isRecovery: d.isRecovery } : {}),
            ...(d.claimRefs?.length ? { claimRefs: [...d.claimRefs] } : {}),
          },
          children: (d.alternatives ?? []).map((alt) => ({
            type: 'alternative' as const,
            props: { stableActivityId: alt.stableActivityId, title: alt.title, actionInstruction: alt.actionInstruction, evidencePolicy: alt.evidencePolicy },
          })),
        })),
      },
    ],
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}
function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}
function strArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
}
function evidence(x: unknown): EvidencePolicy {
  return (EVIDENCE_POLICIES as readonly string[]).includes(str(x)) ? (x as EvidencePolicy) : 'attestation';
}

/**
 * Edited doc → plan candidate (the apply route re-validates it with
 * `validatePlan`). DEFENSIVE by contract: the canvas save hook keeps stored
 * docs structurally valid, but a collab derive can land an off-shape state, so
 * every access is guarded and a broken container degrades to empty — the plan
 * that comes out then fails `validatePlan` with defects (a typed 422 the human
 * edits away), never a 500.
 */
export function outlineDocToPlan(state: Record<string, unknown>): ChallengePlan {
  const meta = isRecord(state.meta) ? state.meta : {};
  const frame = Array.isArray(state.frames) && isRecord(state.frames[0]) ? state.frames[0] : {};
  const dayNodes = Array.isArray((frame as { days?: unknown }).days) ? ((frame as { days: unknown[] }).days) : [];
  const depth = str(meta.depthLevel);
  return {
    title: str(meta.title),
    promise: str(meta.promise),
    audience: str(meta.audience),
    durationDays: num(meta.durationDays),
    dailyMinutesBudget: num(meta.dailyMinutesBudget),
    ...((DEPTH_LEVELS as readonly string[]).includes(depth) ? { depthLevel: depth as DepthLevel } : {}),
    outcomes: (Array.isArray(state.outcomes) ? state.outcomes : []).filter(isRecord).map((o) => ({
      outcomeId: str(o.outcomeId), measurableOutcome: str(o.measurableOutcome), method: str(o.method),
    })),
    achievements: (Array.isArray(state.achievements) ? state.achievements : []).filter(isRecord).map((a) => ({
      achievementId: str(a.achievementId), observableEvidence: str(a.observableEvidence), outcomeIds: strArray(a.outcomeIds),
    })),
    days: dayNodes.filter(isRecord).map((node) => {
      const props = isRecord(node.props) ? node.props : {};
      const children = Array.isArray(node.children) ? node.children.filter(isRecord) : [];
      const alternatives: Alternative[] = children.map((c) => {
        const p = isRecord(c.props) ? c.props : {};
        return { stableActivityId: str(p.stableActivityId), title: str(p.title), actionInstruction: str(p.actionInstruction), evidencePolicy: evidence(p.evidencePolicy) };
      });
      const day: PlanDay = {
        day: num(props.day),
        stableActivityId: str(props.stableActivityId),
        title: str(props.title),
        actionInstruction: str(props.actionInstruction),
        userFacingWhy: str(props.userFacingWhy),
        estimatedMinutes: num(props.estimatedMinutes),
        achievementIds: strArray(props.achievementIds),
        evidencePolicy: evidence(props.evidencePolicy),
        ...(typeof props.isRecovery === 'boolean' ? { isRecovery: props.isRecovery } : {}),
        // Provenance round-trips untouched; an empty list collapses to absent
        // (the same normalization as `alternatives`).
        ...(strArray(props.claimRefs).length ? { claimRefs: strArray(props.claimRefs) } : {}),
        // Empty children ⇒ no `alternatives` key (mirrors draftFromPlan's
        // `d.alternatives?.length`); a lossless round-trip of a non-empty set.
        ...(alternatives.length ? { alternatives } : {}),
      };
      return day;
    }),
  };
}

export interface OutlineValidation {
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

/**
 * STRUCTURE-only canvas validation (the `registerCanvasEditorRoutes` validate
 * hook): errors reject the save/blank (422); plan-LAW is deliberately NOT here
 * (it stays `validatePlan`, run at apply against the derived plan). Empty
 * outcome/achievement/day arrays are structurally fine — a working draft is
 * saveable while incomplete; apply is where completeness is enforced.
 */
export function validateOutlineDoc(state: Record<string, unknown>): OutlineValidation {
  const errors: { path: string; message: string }[] = [];
  const warnings: { path: string; message: string }[] = [];
  const bad = (path: string, message: string) => errors.push({ path, message });

  const meta = state.meta;
  if (!isRecord(meta)) bad('meta', '`meta` must be an object.');
  else {
    for (const k of ['title', 'promise', 'audience'] as const) if (typeof meta[k] !== 'string') bad(`meta.${k}`, `\`meta.${k}\` must be a string.`);
    for (const k of ['durationDays', 'dailyMinutesBudget'] as const) if (typeof meta[k] !== 'number') bad(`meta.${k}`, `\`meta.${k}\` must be a number.`);
    if (meta.depthLevel !== undefined && !(DEPTH_LEVELS as readonly string[]).includes(meta.depthLevel as string)) bad('meta.depthLevel', '`meta.depthLevel` must be beginner, intermediate, or advanced.');
  }

  if (!Array.isArray(state.outcomes)) bad('outcomes', '`outcomes` must be an array.');
  else state.outcomes.forEach((o, i) => {
    if (!isRecord(o)) { bad(`outcomes[${i}]`, 'must be an object.'); return; }
    for (const k of ['outcomeId', 'measurableOutcome', 'method'] as const) if (typeof o[k] !== 'string') bad(`outcomes[${i}].${k}`, 'must be a string.');
  });

  if (!Array.isArray(state.achievements)) bad('achievements', '`achievements` must be an array.');
  else state.achievements.forEach((a, i) => {
    if (!isRecord(a)) { bad(`achievements[${i}]`, 'must be an object.'); return; }
    for (const k of ['achievementId', 'observableEvidence'] as const) if (typeof a[k] !== 'string') bad(`achievements[${i}].${k}`, 'must be a string.');
    if (!Array.isArray(a.outcomeIds) || !a.outcomeIds.every((s) => typeof s === 'string')) bad(`achievements[${i}].outcomeIds`, 'must be a string array.');
  });

  const frames = state.frames;
  if (!Array.isArray(frames) || frames.length !== 1) bad('frames', '`frames` must contain exactly one outline frame.');
  else {
    const f = frames[0];
    if (!isRecord(f)) bad('frames[0]', 'must be an object.');
    else {
      if (f.id !== 'outline') bad('frames[0].id', "the single frame's `id` must be 'outline'.");
      if (typeof f.name !== 'string') bad('frames[0].name', 'must be a string.');
      if (!Array.isArray(f.days)) bad('frames[0].days', 'must be an array.');
      else f.days.forEach((d, i) => validateDayNode(d, `frames[0].days[${i}]`, bad));
    }
  }
  return { errors, warnings };
}

function validateDayNode(node: unknown, path: string, bad: (p: string, m: string) => void): void {
  if (!isRecord(node)) { bad(path, 'must be an object.'); return; }
  if (node.type !== 'day') bad(`${path}.type`, "must be 'day'.");
  const props = node.props;
  if (!isRecord(props)) { bad(`${path}.props`, 'must be an object.'); return; }
  for (const k of ['stableActivityId', 'title', 'actionInstruction', 'userFacingWhy'] as const) if (typeof props[k] !== 'string') bad(`${path}.props.${k}`, 'must be a string.');
  for (const k of ['day', 'estimatedMinutes'] as const) if (typeof props[k] !== 'number') bad(`${path}.props.${k}`, 'must be a number.');
  if (!(EVIDENCE_POLICIES as readonly string[]).includes(props.evidencePolicy as string)) bad(`${path}.props.evidencePolicy`, 'must be attestation, note, photo, or measurement.');
  if (!Array.isArray(props.achievementIds) || !props.achievementIds.every((s) => typeof s === 'string')) bad(`${path}.props.achievementIds`, 'must be a string array.');
  if (props.isRecovery !== undefined && typeof props.isRecovery !== 'boolean') bad(`${path}.props.isRecovery`, 'must be a boolean.');
  if (props.claimRefs !== undefined && (!Array.isArray(props.claimRefs) || !props.claimRefs.every((s) => typeof s === 'string'))) bad(`${path}.props.claimRefs`, 'must be a string array.');
  const children = node.children;
  if (!Array.isArray(children)) bad(`${path}.children`, 'must be an array.');
  else children.forEach((c, i) => validateAlternativeNode(c, `${path}.children[${i}]`, bad));
}

function validateAlternativeNode(node: unknown, path: string, bad: (p: string, m: string) => void): void {
  if (!isRecord(node)) { bad(path, 'must be an object.'); return; }
  if (node.type !== 'alternative') bad(`${path}.type`, "must be 'alternative'.");
  const props = node.props;
  if (!isRecord(props)) { bad(`${path}.props`, 'must be an object.'); return; }
  for (const k of ['stableActivityId', 'title', 'actionInstruction'] as const) if (typeof props[k] !== 'string') bad(`${path}.props.${k}`, 'must be a string.');
  if (!(EVIDENCE_POLICIES as readonly string[]).includes(props.evidencePolicy as string)) bad(`${path}.props.evidencePolicy`, 'must be attestation, note, photo, or measurement.');
}
