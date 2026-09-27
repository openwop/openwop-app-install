/**
 * The `challenge-outline` canvas type doc model + coercion (ADR 0458 §2.3).
 *
 * The doc is a WORKING-DRAFT projection of the candidate's validated
 * `ChallengePlan` (backend SSoT `kicktodo-creator/planService.ts`): the plan's
 * scalar header becomes `meta`, its `days[]` become a `tree` of `day` nodes
 * (each carrying its publisher-declared substitutions as `alternative` child
 * nodes), and `outcomes`/`achievements` pass through as doc-level arrays. The
 * candidate's validated plan revision remains the ONLY truth (architect
 * CRITICAL-1) — this canvas is an explicitly-labelled draft, and "Apply" runs
 * the plan validator + persists a new revision through the candidate owner.
 *
 * `coerceDoc` narrows the opaque canvas `state` with safe fallbacks and NEVER
 * launders through `as unknown as` — every recognized facet survives coercion
 * (the app-builder DS-01 lesson: the editor loads THROUGH coerce and saves the
 * result, so a dropped field is permanent data loss on first save).
 */
import { frameOps } from '../../canvas/frameOps.js';
import { treeOps } from '../../canvas/treeOps.js';
import type { TreeNodeBase } from '../../canvas/treeOps.js';
import type { FrameBase } from '../../canvas/frameOps.js';

export type EvidencePolicy = 'attestation' | 'note' | 'photo' | 'measurement';
export const EVIDENCE_POLICIES: readonly EvidencePolicy[] = ['attestation', 'note', 'photo', 'measurement'];

export type DepthLevel = 'beginner' | 'intermediate' | 'advanced';
export const DEPTH_LEVELS: readonly DepthLevel[] = ['beginner', 'intermediate', 'advanced'];

/** Schema bounds mirrored from the backend artifact schema (artifactSchemas.ts)
 *  so a panel edit clamps instead of round-tripping to a validator defect. */
export const DURATION_MIN = 3;
export const DURATION_MAX = 60;
export const MINUTES_MIN = 5;
export const MINUTES_MAX = 120;

/** The single 'outline' frame the tree operates over — the challenge has one
 *  ordered day list, so the frames cap is 1 and there is no home flag. */
export const OUTLINE_FRAME_ID = 'outline';

export interface OutlineMeta {
  title: string;
  promise: string;
  audience: string;
  durationDays: number;
  dailyMinutesBudget: number;
  depthLevel?: DepthLevel;
}

export interface OutlineOutcome {
  outcomeId: string;
  measurableOutcome: string;
  method: string;
}

export interface OutlineAchievement {
  achievementId: string;
  observableEvidence: string;
  outcomeIds: string[];
}

export interface AlternativeNode extends TreeNodeBase {
  type: 'alternative';
  props: {
    stableActivityId: string;
    title: string;
    actionInstruction: string;
    evidencePolicy: EvidencePolicy;
  };
}

export interface DayNode extends TreeNodeBase {
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
  };
  children: AlternativeNode[];
}

export type OutlineNode = DayNode | AlternativeNode;

export interface OutlineFrame extends FrameBase {
  id: string;
  name: string;
  days: DayNode[];
}

export interface OutlineDoc {
  /** The canvas's working-draft label (the toolbar name field; `docNameKey`).
   *  Chassis metadata, NOT a plan facet — the backend Apply projection ignores
   *  it and reads meta/outcomes/achievements/frames. Derived from `meta.title`
   *  when the seeded state omits it, so the toolbar is never blank. */
  name: string;
  meta: OutlineMeta;
  outcomes: OutlineOutcome[];
  achievements: OutlineAchievement[];
  frames: OutlineFrame[];
}

/* ── narrowing helpers (index-signature-free at every call site) ─────────── */

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const evidence = (v: unknown): EvidencePolicy => ((EVIDENCE_POLICIES as readonly string[]).includes(str(v)) ? (v as EvidencePolicy) : 'attestation');

function coerceMeta(v: unknown): OutlineMeta {
  const m = rec(v);
  const depth = str(m.depthLevel);
  return {
    title: str(m.title, 'Untitled challenge'),
    promise: str(m.promise),
    audience: str(m.audience),
    durationDays: num(m.durationDays, DURATION_MIN),
    dailyMinutesBudget: num(m.dailyMinutesBudget, MINUTES_MIN),
    ...((DEPTH_LEVELS as readonly string[]).includes(depth) ? { depthLevel: depth as DepthLevel } : {}),
  };
}

function coerceOutcome(v: unknown, i: number): OutlineOutcome {
  const o = rec(v);
  return {
    outcomeId: str(o.outcomeId) || `outcome-${i + 1}`,
    measurableOutcome: str(o.measurableOutcome),
    method: str(o.method),
  };
}

function coerceAchievement(v: unknown, i: number): OutlineAchievement {
  const a = rec(v);
  return {
    achievementId: str(a.achievementId) || `achievement-${i + 1}`,
    observableEvidence: str(a.observableEvidence),
    outcomeIds: strList(a.outcomeIds),
  };
}

function coerceAlternative(v: unknown, i: number): AlternativeNode {
  const p = rec(rec(v).props);
  return {
    type: 'alternative',
    props: {
      stableActivityId: str(p.stableActivityId) || `alt-${i + 1}`,
      title: str(p.title),
      actionInstruction: str(p.actionInstruction),
      evidencePolicy: evidence(p.evidencePolicy),
    },
  };
}

function coerceDay(v: unknown, i: number): DayNode {
  const node = rec(v);
  const p = rec(node.props);
  const children = Array.isArray(node.children) ? node.children : [];
  const dayNum = num(p.day, i + 1);
  return {
    type: 'day',
    props: {
      day: dayNum,
      stableActivityId: str(p.stableActivityId) || `day-${dayNum}`,
      title: str(p.title),
      actionInstruction: str(p.actionInstruction),
      userFacingWhy: str(p.userFacingWhy),
      estimatedMinutes: num(p.estimatedMinutes, MINUTES_MIN),
      evidencePolicy: evidence(p.evidencePolicy),
      achievementIds: strList(p.achievementIds),
      ...(typeof p.isRecovery === 'boolean' ? { isRecovery: p.isRecovery } : {}),
    },
    children: children.map((c, j) => coerceAlternative(c, j)),
  };
}

/** Narrow the raw frames into exactly ONE 'outline' frame (the type's cap). The
 *  backend seeds the single frame; a malformed/absent frames array still yields
 *  the one editable frame so the tree surface is never blank. */
function coerceFrames(v: unknown): OutlineFrame[] {
  const arr = Array.isArray(v) ? v : [];
  const first = rec(arr[0]);
  const rawDays = Array.isArray(first.days) ? first.days : [];
  return [{
    id: str(first.id) || OUTLINE_FRAME_ID,
    name: str(first.name) || 'Outline',
    days: rawDays.map((d, i) => coerceDay(d, i)),
  }];
}

// Exhaustiveness guard (app-builder DS-01 pattern): if OutlineDoc gains a key
// not narrowed below, this constant fails to typecheck — a dropped field is a
// compile error, not silent data loss on first save.
type CoveredDocKey = 'name' | 'meta' | 'outcomes' | 'achievements' | 'frames';
const _ALL_OUTLINE_DOC_KEYS_COVERED: Exclude<keyof OutlineDoc, CoveredDocKey> extends never ? true : never = true;
void _ALL_OUTLINE_DOC_KEYS_COVERED;

export function coerceOutlineDoc(state: Record<string, unknown>): OutlineDoc {
  const rawOutcomes = Array.isArray(state.outcomes) ? state.outcomes : [];
  const rawAchievements = Array.isArray(state.achievements) ? state.achievements : [];
  const meta = coerceMeta(state.meta);
  return {
    name: str(state.name) || meta.title,
    meta,
    outcomes: rawOutcomes.map((o, i) => coerceOutcome(o, i)),
    achievements: rawAchievements.map((a, i) => coerceAchievement(a, i)),
    frames: coerceFrames(state.frames),
  };
}

export const outlineFrameOps = frameOps<OutlineDoc, OutlineFrame>({
  key: 'frames',
  max: 1,
  slugFallback: OUTLINE_FRAME_ID,
  makeFrame: (id, name) => ({ id, name, days: [] }),
});

export const outlineTreeOps = treeOps<OutlineNode, OutlineFrame>({ rootKey: 'days', childrenKey: 'children' });
