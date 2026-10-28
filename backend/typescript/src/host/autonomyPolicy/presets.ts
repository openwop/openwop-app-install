/**
 * ADR 0942 D2 — the three presets, as versioned code constants. A preset is
 * addressed by a binding as `policyId: 'preset:<name>'`, `version: <n>` and has
 * no stored row; its hash is computed from this constant. Changing a preset's
 * rules means a NEW version (`guarded@2`), never an edit of `@1`: a stamped run
 * names the version it ran under.
 *
 * Thresholds approved by David 2026-10-19 (ADR 0942 Q1): $500 / $2,000 daily
 * spend, 50,000 audience, 10% budget delta. New clients bind to `guarded@1`;
 * `review-everything@1` is the fallback when nothing resolves.
 */
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../jcs.js';
import type { ActionClass, ActionRule, ApproverSpec, Decision, PresetId, ResolvedPolicy } from './types.js';
import { ACTION_CLASSES } from './types.js';

/** Approvers when a preset (or a fail-closed fallback) says `approve`: the client org's admins. */
export const DEFAULT_APPROVER: Readonly<ApproverSpec> = Object.freeze({
  roleRefs: ['owner', 'admin'],
  requiredApprovals: 1,
  delegation: 'allowed',
});

const approve = (): Decision => ({ outcome: 'approve', approver: { ...DEFAULT_APPROVER, roleRefs: [...(DEFAULT_APPROVER.roleRefs ?? [])] } });
const notifyAdmins = (): Decision => ({ outcome: 'notify-after', notify: { roleRefs: ['owner', 'admin'], channels: ['inbox'], digest: 'immediate' } });
const auto = (): Decision => ({ outcome: 'auto' });

/** The seven classes added in program review are `approve` in every preset (D2). */
const ALWAYS_APPROVE: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'lead.grade-adjust', 'journey.publish', 'email.resume-sending', 'report.publish',
  'asset.accept-vendor', 'vendor.engage', 'playbook.rollout',
]);

function reviewEverything(): ActionRule[] {
  return ACTION_CLASSES.map((c) => ({ actionClass: c, default: c === 'creative.generate' ? auto() : approve() }));
}

/** Autopilot's risk escalations (D2): any of these turns an auto/notify step into approve. */
function risk(): NonNullable<ActionRule['escalations']> {
  return [
    { when: [{ fact: 'spendMinor', op: '>=', value: 200_000 }], then: approve() },
    { when: [{ fact: 'audienceSize', op: '>=', value: 50_000 }], then: approve() },
    { when: [{ fact: 'regulatedCategory', op: '==', value: true }], then: approve() },
    { when: [{ fact: 'findingsHigh', op: '>=', value: 1 }], then: approve() },
    { when: [{ fact: 'firstForDestination', op: '==', value: true }], then: approve() },
  ];
}

/**
 * ADR 0941 owner decision 4 (David, 2026-10-19): no preset launches or raises
 * paid spend without approval; pausing and cutting spend stay automatic.
 */
const spendIncrease = (): NonNullable<ActionRule['escalations']>[number] =>
  ({ when: [{ fact: 'spendDeltaPct', op: '>', value: 0 }], then: approve() });

function autopilot(): ActionRule[] {
  const rules: ActionRule[] = [];
  for (const c of ACTION_CLASSES) {
    if (ALWAYS_APPROVE.has(c)) { rules.push({ actionClass: c, default: approve() }); continue; }
    if (c === 'creative.generate') { rules.push({ actionClass: c, default: auto() }); continue; }
    if (c === 'creative.review') {
      rules.push({ actionClass: c, stage: 'internal', default: auto() });
      rules.push({ actionClass: c, stage: 'compliance', default: auto(), escalations: risk() });
      rules.push({ actionClass: c, stage: 'client', default: approve() });
      continue;
    }
    if (c === 'plan.approve') { rules.push({ actionClass: c, default: notifyAdmins() }); continue; }
    if (c === 'ads.launch') { rules.push({ actionClass: c, default: approve() }); continue; }
    if (c === 'ads.budget') { rules.push({ actionClass: c, default: auto(), escalations: [spendIncrease(), ...risk()] }); continue; }
    rules.push({ actionClass: c, default: notifyAdmins(), escalations: risk() });
  }
  return rules;
}

/**
 * Guarded is built ON Autopilot so the ladder is monotonic (review-everything ≥
 * guarded ≥ autopilot, proven per class by `compare.ts` in the preset test).
 * Where Guarded is not plain `approve`, it keeps Autopilot's escalations as a
 * prefix and appends its own tighter thresholds. (ADR 0942 D2 correction
 * 2026-10-20: the ADR's own Guarded list was looser than its Autopilot list on
 * four classes, so "Autopilot → Guarded" would have counted as a loosen.)
 */
function guarded(): ActionRule[] {
  const GUARDED_APPROVE = new Set<ActionClass>(['plan.approve', 'creative.review', 'ads.launch', 'email.campaign-send', 'social.post', 'experiment.promote']);
  const out: ActionRule[] = [];
  for (const r of autopilot()) {
    const c = r.actionClass;
    if (c === 'creative.review') {
      if (r.stage === 'internal') out.push({ actionClass: c, default: approve() });
      continue; // one stage-less approve rule covers every stage
    }
    if (ALWAYS_APPROVE.has(c) || GUARDED_APPROVE.has(c)) { out.push({ actionClass: c, default: approve() }); continue; }
    if (c === 'ads.budget') {
      out.push({ ...r, escalations: [...(r.escalations ?? []), { when: [{ fact: 'spendMinor', op: '>=', value: 50_000 }], then: approve() }] });
      continue;
    }
    out.push(r); // creative.generate auto; content.publish, ads.publish, lead.contact and the rest: notify-after + risk
  }
  return out;
}

const BUILDERS: Record<PresetId, () => ActionRule[]> = {
  'review-everything@1': reviewEverything,
  'guarded@1': guarded,
  'autopilot@1': autopilot,
};

const NAMES: Record<PresetId, string> = {
  'review-everything@1': 'Review everything',
  'guarded@1': 'Guarded',
  'autopilot@1': 'Autopilot',
};

export function policyHash(basePreset: PresetId | undefined, rules: readonly ActionRule[]): string {
  return createHash('sha256').update(canonicalJSON({ basePreset: basePreset ?? null, rules })).digest('hex');
}

/** `preset:guarded` + 1 ⇔ `guarded@1`. */
export function presetPolicyId(preset: PresetId): { policyId: string; version: number } {
  const [name, v] = preset.split('@');
  return { policyId: `preset:${name}`, version: Number(v) };
}
export function presetFromBinding(policyId: string, version: number): PresetId | null {
  if (!policyId.startsWith('preset:')) return null;
  const id = `${policyId.slice('preset:'.length)}@${version}`;
  return (Object.keys(BUILDERS) as PresetId[]).includes(id as PresetId) ? (id as PresetId) : null;
}

export function presetRules(preset: PresetId): ActionRule[] {
  return BUILDERS[preset]();
}

export function presetPolicy(preset: PresetId): ResolvedPolicy {
  const rules = presetRules(preset);
  return { ...presetPolicyId(preset), name: NAMES[preset], rules, hash: policyHash(undefined, rules) };
}

/** The fail-closed fallback (D2/D4): no binding, an unreadable stamp, or a dangling ref. */
export const FALLBACK_PRESET: PresetId = 'review-everything@1';
/** What a new client is bound to (David, 2026-10-19). */
export const NEW_CLIENT_PRESET: PresetId = 'guarded@1';
