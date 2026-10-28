/**
 * ADR 0942 D3 — the pure campaign-action resolver. No I/O, no clock, no toggle
 * reads: everything it needs is an argument, so a replay that feeds it the same
 * frozen stamp and facts gets the same answer.
 *
 * It returns the MOST SEVERE of five layers:
 *   1. floors (not configurable): content-rules block, client not live, an
 *      unconfigured vendor, product fidelity, the MCP-origin and attended-fork
 *      floors (D10.3/D10.4);
 *   2. the tenant ceiling (ADR 0028 governance, as the chokepoint reads it);
 *   3. the node's bound agent (`never` → blocked, `hitl` → approve; skipped until
 *      ADR 0943 freezes bindings — it only ever tightens, so skipping never loosens);
 *   4. the frozen campaign policy: rule default, then the first matching escalation;
 *   5. the live tighten-only overlay (campaign paused/archived, emergency halt).
 *
 * So the campaign policy can never loosen a ceiling, an agent's explicit rules
 * or a floor. On a severity tie the policy's own decision is kept, because it
 * carries the policy's approvers and notify list.
 */
import { DEFAULT_APPROVER, FALLBACK_PRESET, presetPolicy, presetRules } from './presets.js';
import {
  NON_EXTERNAL_CLASSES, SEVERITY,
  type ActionClass, type ActionRule, type Condition, type Decision, type ResolvedPolicy, type ReviewStage, type RiskFacts,
} from './types.js';

export type ResolutionLayer = 'floor' | 'ceiling' | 'agent' | 'policy' | 'live';

export interface ResolveFloors {
  /** ADR 0933 D5: a `block` finding on the content this effect carries. */
  contentRulesBlock?: boolean;
  /** ADR 0921/0926: the client account the campaign belongs to. `missing` ⇒ not live. */
  client?: { mode: 'preview' | 'live'; status: 'active' | 'paused' | 'archived' } | 'missing';
  /** The owner's vendor (provider) is not configured: its own typed failure, never auto. */
  vendorUnconfigured?: boolean;
  /** ADR 0945: the worst fidelity verdict over the assets this effect carries. */
  fidelity?: 'pass' | 'needs_review' | 'fail';
  /** D10.3: the run was started over the MCP server mount (host-written origin). */
  mcpOrigin?: boolean;
  /** D10.4: a branch fork is attended. */
  forkPosture?: 'attended';
}

export interface ResolveInput {
  /** The frozen policy; `null` ⇒ the fail-closed fallback (`review-everything@1`). */
  policy: ResolvedPolicy | null;
  actionClass: ActionClass;
  stage?: ReviewStage;
  facts: RiskFacts;
  floors?: ResolveFloors;
  /** ADR 0028 ceiling, as the chokepoint reads it. `draft-only` stays the chokepoint's own posture. */
  ceiling?: 'none' | 'approve' | 'blocked';
  /** The frozen agent binding's explicit rules for this class (ADR 0943; absent until it ships). */
  agent?: { never?: boolean; hitl?: boolean } | null;
  /** Read live; may only raise severity. */
  live?: { campaignStatus?: 'draft' | 'active' | 'paused' | 'completed' | 'archived'; emergencyHalt?: boolean };
}

export interface Resolution {
  decision: Decision;
  /** `<class>[:<stage>]#default|#esc<n>|#preset|#fallback`. */
  ruleId: string;
  /** Which D3 input decided. */
  layer: ResolutionLayer;
  reasons: string[];
  policyId: string;
  policyVersion: number;
  policyHash: string;
}

const defaultApprove = (): Decision => ({ outcome: 'approve', approver: { ...DEFAULT_APPROVER, roleRefs: [...(DEFAULT_APPROVER.roleRefs ?? [])] } });
const blocked = (reason: string): Decision => ({ outcome: 'blocked', reason });

/**
 * The effective rule for (class, stage): an exact stage rule, else the class rule
 * with no stage, else the base preset's rule, else `approve` (D2: "a missing class
 * ⇒ preset ⇒ approve").
 */
export function findRule(policy: Pick<ResolvedPolicy, 'rules' | 'basePreset'>, actionClass: ActionClass, stage?: ReviewStage): { rule: ActionRule | null; from: 'policy' | 'preset' | 'none' } {
  const pick = (rules: readonly ActionRule[]): ActionRule | null =>
    (stage ? rules.find((r) => r.actionClass === actionClass && r.stage === stage) : undefined)
    ?? rules.find((r) => r.actionClass === actionClass && r.stage === undefined)
    // A stage-less ask on a staged rule set takes the strictest stage.
    ?? (stage ? null : strictestStageRule(rules.filter((r) => r.actionClass === actionClass)))
    ?? null;
  const own = pick(policy.rules);
  if (own) return { rule: own, from: 'policy' };
  if (policy.basePreset) {
    const base = pick(presetRules(policy.basePreset));
    if (base) return { rule: base, from: 'preset' };
  }
  return { rule: null, from: 'none' };
}

function strictestStageRule(rules: ActionRule[]): ActionRule | null {
  if (rules.length === 0) return null;
  return [...rules].sort((a, b) => maxSeverity(b) - maxSeverity(a) || SEVERITY[b.default.outcome] - SEVERITY[a.default.outcome])[0];
}

/** The most severe outcome a rule can produce (its default or any escalation). */
export function maxSeverity(rule: ActionRule): number {
  return Math.max(SEVERITY[rule.default.outcome], ...(rule.escalations ?? []).map((e) => SEVERITY[e.then.outcome]));
}

/** A condition on a fact the caller did not supply is TRUE: escalations only tighten, so an unknown fails toward review. */
function holds(c: Condition, facts: RiskFacts, reasons: string[]): boolean {
  const actual = facts[c.fact];
  if (actual === undefined) { reasons.push(`fact_missing:${c.fact}`); return true; }
  switch (c.op) {
    case '>=': return typeof actual === 'number' && typeof c.value === 'number' && actual >= c.value;
    case '>': return typeof actual === 'number' && typeof c.value === 'number' && actual > c.value;
    case '<=': return typeof actual === 'number' && typeof c.value === 'number' && actual <= c.value;
    case '<': return typeof actual === 'number' && typeof c.value === 'number' && actual < c.value;
    case '==': return actual === c.value;
    // No string fact exists; the validator refuses `in`. Fail toward review if one slips through.
    case 'in': return true;
  }
}

function ruleKey(actionClass: ActionClass, stage: ReviewStage | undefined): string {
  return stage ? `${actionClass}:${stage}` : actionClass;
}

/** Layer 4: the policy's decision for this class and these facts. */
export function evaluatePolicy(policy: ResolvedPolicy, actionClass: ActionClass, stage: ReviewStage | undefined, facts: RiskFacts): { decision: Decision; ruleId: string; reasons: string[] } {
  const reasons: string[] = [];
  const key = ruleKey(actionClass, stage);
  const { rule, from } = findRule(policy, actionClass, stage);
  if (!rule) return { decision: defaultApprove(), ruleId: `${key}#fallback`, reasons: ['no_rule'] };
  const suffix = from === 'preset' ? '#preset' : '';
  const escalations = rule.escalations ?? [];
  for (let i = 0; i < escalations.length; i++) {
    const local: string[] = [];
    if (escalations[i].when.every((c) => holds(c, facts, local))) {
      reasons.push(...local, `escalation:${i}`);
      return { decision: escalations[i].then, ruleId: `${key}#esc${i}${suffix}`, reasons };
    }
  }
  return { decision: rule.default, ruleId: `${key}#default${suffix}`, reasons };
}

export function resolveCampaignAction(input: ResolveInput): Resolution {
  const policy = input.policy ?? presetPolicy(FALLBACK_PRESET);
  const external = !NON_EXTERNAL_CLASSES.has(input.actionClass);
  const fromPolicy = evaluatePolicy(policy, input.actionClass, input.stage, input.facts);
  const reasons = [...fromPolicy.reasons];
  if (!input.policy) reasons.push('policy_fallback');

  let best: { decision: Decision; layer: ResolutionLayer; ruleId: string } = { decision: fromPolicy.decision, layer: 'policy', ruleId: fromPolicy.ruleId };
  const raise = (decision: Decision, layer: ResolutionLayer, reason: string, ruleId: string): void => {
    reasons.push(reason);
    // Strictly more severe replaces; a tie keeps what is there (the policy's approvers win).
    if (SEVERITY[decision.outcome] > SEVERITY[best.decision.outcome]) best = { decision, layer, ruleId };
  };

  // Layer 1 — floors.
  const f = input.floors ?? {};
  if (f.contentRulesBlock) raise(blocked('content_rules_block'), 'floor', 'floor:content_rules_block', 'floor:content-rules');
  if (external && f.client !== undefined && (f.client === 'missing' || f.client.mode !== 'live' || f.client.status !== 'active')) {
    raise(blocked('client_not_live'), 'floor', 'floor:client_not_live', 'floor:client');
  }
  if (f.vendorUnconfigured) raise(blocked('vendor_unconfigured'), 'floor', 'floor:vendor_unconfigured', 'floor:vendor');
  if (f.fidelity === 'fail') raise(blocked('fidelity_fail'), 'floor', 'floor:fidelity_fail', 'floor:fidelity');
  else if (f.fidelity === 'needs_review') raise(defaultApprove(), 'floor', 'floor:fidelity_needs_review', 'floor:fidelity');
  if (external && f.mcpOrigin) raise(defaultApprove(), 'floor', 'floor:mcp_origin', 'floor:mcp-origin');
  if (external && f.forkPosture === 'attended') raise(defaultApprove(), 'floor', 'floor:attended_fork', 'floor:fork-posture');

  // Layer 2 — tenant ceiling.
  if (input.ceiling === 'blocked') raise(blocked('tenant_policy_disabled'), 'ceiling', 'ceiling:disabled', 'ceiling:governance');
  else if (input.ceiling === 'approve') raise(defaultApprove(), 'ceiling', 'ceiling:approval_required', 'ceiling:governance');

  // Layer 3 — the bound agent's explicit rules.
  if (input.agent?.never) raise(blocked('agent_never'), 'agent', 'agent:never', 'agent:never');
  else if (input.agent?.hitl) raise(defaultApprove(), 'agent', 'agent:hitl', 'agent:hitl');

  // Layer 5 — live tighten-only overlay.
  const live = input.live ?? {};
  if (external && live.emergencyHalt) raise(blocked('emergency_halt'), 'live', 'live:emergency_halt', 'live:halt');
  if (external && (live.campaignStatus === 'paused' || live.campaignStatus === 'archived')) {
    raise(blocked(`campaign_${live.campaignStatus}`), 'live', `live:campaign_${live.campaignStatus}`, 'live:campaign-status');
  }

  return {
    decision: best.decision,
    ruleId: best.ruleId,
    layer: best.layer,
    reasons,
    policyId: policy.policyId,
    policyVersion: policy.version,
    policyHash: policy.hash,
  };
}
