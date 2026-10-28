/**
 * ADR 0942 D9 — is a proposed policy at least as strict as the current one?
 * This decides WHO may save it (tighten: `workspace:write`; loosen:
 * `host:members:manage`), so it is deliberately conservative: anything it cannot
 * PROVE is tighter-or-equal is treated as a loosen. A wrong "loosen" only asks
 * for more authority; a wrong "tighten" would let an editor relax a gate.
 *
 * Rules are compared after expanding the preset fallback, per class and per
 * review stage, so a policy that drops a class (and so falls back to its base
 * preset) is compared by what it actually resolves to.
 */
import { canonicalJSON } from '../jcs.js';
import { findRule } from './resolve.js';
import { DEFAULT_APPROVER } from './presets.js';
import {
  ACTION_CLASSES, REVIEW_STAGES, SEVERITY,
  type ActionClass, type ActionRule, type ApproverSpec, type Decision, type NotifySpec, type ResolvedPolicy, type ReviewStage,
} from './types.js';

const FALLBACK_RULE = (actionClass: ActionClass): ActionRule => ({
  actionClass,
  default: { outcome: 'approve', approver: { ...DEFAULT_APPROVER, roleRefs: [...(DEFAULT_APPROVER.roleRefs ?? [])] } },
});

const same = (a: unknown, b: unknown): boolean => canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
const superset = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => (b ?? []).every((x) => (a ?? []).includes(x));

function notifyDominates(a: NotifySpec | undefined, b: NotifySpec | undefined): boolean {
  if (!b) return true;
  if (!a) return false;
  return superset(a.roleRefs, b.roleRefs)
    && superset(a.subjectRefs, b.subjectRefs)
    && superset(a.channels, b.channels)
    && (a.digest === 'immediate' || b.digest === 'daily')
    && (b.vetoWindowMs === undefined || (a.vetoWindowMs !== undefined && a.vetoWindowMs >= b.vetoWindowMs));
}

function approverDominates(a: ApproverSpec, b: ApproverSpec): boolean {
  if (a.requiredApprovals < b.requiredApprovals) return false;
  if (a.delegation === 'allowed' && b.delegation === 'none') return false;
  // Who approves, how quorum splits, how rejection counts and the SLA must be
  // unchanged: changing any of them can loosen in ways this cannot prove safe.
  const rest = (s: ApproverSpec): unknown => ({
    roleRefs: [...(s.roleRefs ?? [])].sort(), groupRefs: [...(s.groupRefs ?? [])].sort(), subjectRefs: [...(s.subjectRefs ?? [])].sort(),
    clientApprover: s.clientApprover === true, rejectionPolicy: s.rejectionPolicy ?? 'any', perParty: s.perParty ?? null,
    sla: s.sla ?? null, escalateTo: s.escalateTo ?? null,
  });
  return same(rest(a), rest(b));
}

/** `a` is at least as strict as `b`. */
export function decisionDominates(a: Decision, b: Decision): boolean {
  if (SEVERITY[a.outcome] !== SEVERITY[b.outcome]) return SEVERITY[a.outcome] > SEVERITY[b.outcome];
  switch (a.outcome) {
    case 'auto':
    case 'blocked':
      return true;
    case 'notify-after':
      return b.outcome === 'notify-after' && notifyDominates(a.notify, b.notify);
    case 'approve':
      return b.outcome === 'approve' && approverDominates(a.approver, b.approver) && notifyDominates(a.notify, b.notify);
  }
}

function reachable(rule: ActionRule): Decision[] {
  return [rule.default, ...(rule.escalations ?? []).map((e) => e.then)];
}

/**
 * Sound, not complete. True when either
 *  (a) everything `next` can produce dominates everything `prev` can produce, or
 *  (b) `next` keeps `prev`'s escalations as an identical-condition PREFIX with
 *      dominating outcomes, its default dominates `prev`'s, and every extra
 *      escalation it appends dominates `prev`'s default (they fire only where
 *      `prev` would have returned its default).
 */
export function ruleAtLeastAsStrict(next: ActionRule, prev: ActionRule): boolean {
  if (same(next, prev)) return true;
  if (reachable(next).every((n) => reachable(prev).every((p) => decisionDominates(n, p)))) return true;
  const pe = prev.escalations ?? [];
  const ne = next.escalations ?? [];
  if (!decisionDominates(next.default, prev.default) || ne.length < pe.length) return false;
  for (let i = 0; i < pe.length; i++) {
    if (!same(ne[i].when, pe[i].when) || !decisionDominates(ne[i].then, pe[i].then)) return false;
  }
  return ne.slice(pe.length).every((e) => decisionDominates(e.then, prev.default));
}

const STAGES: ReadonlyArray<ReviewStage | undefined> = [undefined, ...REVIEW_STAGES];

/** Per class (and per review stage), the rules that differ in strictness. Empty ⇒ at least as strict. */
export function loosenedClasses(next: Pick<ResolvedPolicy, 'rules' | 'basePreset'>, prev: Pick<ResolvedPolicy, 'rules' | 'basePreset'>): string[] {
  const out: string[] = [];
  for (const c of ACTION_CLASSES) {
    for (const stage of c === 'creative.review' ? STAGES : [undefined]) {
      const n = findRule(next, c, stage).rule ?? FALLBACK_RULE(c);
      const p = findRule(prev, c, stage).rule ?? FALLBACK_RULE(c);
      if (!ruleAtLeastAsStrict(n, p)) out.push(stage ? `${c}:${stage}` : c);
    }
  }
  return out;
}

export function isAtLeastAsStrict(next: Pick<ResolvedPolicy, 'rules' | 'basePreset'>, prev: Pick<ResolvedPolicy, 'rules' | 'basePreset'>): boolean {
  return loosenedClasses(next, prev).length === 0;
}
