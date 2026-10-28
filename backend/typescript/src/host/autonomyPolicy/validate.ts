/**
 * ADR 0942 D2 + D10.1 — the closed-world policy validator. Every value is
 * checked against a closed vocabulary; unknown keys are refused, never dropped
 * (the validator-allowlist lesson: a silently dropped field is a lie to the
 * caller). The output is a fresh object built only from validated values.
 *
 * Refusals are typed `validation_error` (400) naming the JSON path.
 */
import { OpenwopError } from '../../types.js';
import {
  ACTION_CLASSES, APPROVE_FLOOR_CLASSES, CLIENT_APPROVER_CLASSES, CONDITION_OPS, FACT_TYPES, NOTIFY_CHANNELS,
  OUTCOMES, PRESET_IDS, REVIEW_STAGES, SEVERITY,
  type ActionClass, type ActionRule, type ApproverSpec, type Condition, type Decision, type NotifySpec,
  type PerPartyQuorum, type PresetId, type ReviewStage, type RiskFact,
} from './types.js';

const MAX_RULES = 64;
const MAX_ESCALATIONS = 8;
const MAX_CONDITIONS = 6;
const MAX_REFS = 16;
const MAX_REF_LEN = 200;
const MAX_REASON_LEN = 280;
const HOUR_MS = 3_600_000;
const MAX_MS = 90 * 24 * HOUR_MS;

function fail(path: string, message: string): never {
  throw new OpenwopError('validation_error', `${path}: ${message}`, 400, { field: path });
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'unknown field.');
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) fail(path, `must be one of ${allowed.join(', ')}.`);
  return v as T;
}
function refs(v: unknown, path: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_REFS) fail(path, `must be an array of at most ${MAX_REFS} ids.`);
  const out = v.map((r, i) => {
    if (typeof r !== 'string' || r.trim().length === 0 || r.length > MAX_REF_LEN) fail(`${path}[${i}]`, 'must be a non-empty id.');
    return r.trim();
  });
  return [...new Set(out)];
}
function ms(v: unknown, path: string, min = 1): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > MAX_MS) fail(path, `must be an integer number of milliseconds between ${min} and ${MAX_MS}.`);
  return v;
}

function validateNotify(v: unknown, path: string): NotifySpec {
  if (!isObj(v)) fail(path, 'must be an object.');
  onlyKeys(v, ['roleRefs', 'subjectRefs', 'channels', 'digest', 'vetoWindowMs'], path);
  const roleRefs = refs(v.roleRefs, `${path}.roleRefs`);
  const subjectRefs = refs(v.subjectRefs, `${path}.subjectRefs`);
  if (!roleRefs?.length && !subjectRefs?.length) fail(path, 'must name roleRefs or subjectRefs to notify.');
  if (!Array.isArray(v.channels) || v.channels.length === 0) fail(`${path}.channels`, 'must list at least one channel.');
  const channels = [...new Set(v.channels.map((c, i) => oneOf(c, NOTIFY_CHANNELS, `${path}.channels[${i}]`)))];
  const digest = oneOf(v.digest, ['immediate', 'daily'] as const, `${path}.digest`);
  const vetoWindowMs = ms(v.vetoWindowMs, `${path}.vetoWindowMs`, HOUR_MS);
  return {
    ...(roleRefs?.length ? { roleRefs } : {}),
    ...(subjectRefs?.length ? { subjectRefs } : {}),
    channels, digest,
    ...(vetoWindowMs !== undefined ? { vetoWindowMs } : {}),
  };
}

/**
 * D10.1 — every `approve` names role-based approvers (role or group refs);
 * subject refs alone are refused. An approval naming nobody is decidable by any
 * holder of its token, and the MCP MRTR lane resolves exactly those.
 */
export function validateApprover(v: unknown, path: string, actionClass: ActionClass): ApproverSpec {
  if (!isObj(v)) fail(path, 'must be an object.');
  onlyKeys(v, ['roleRefs', 'groupRefs', 'subjectRefs', 'clientApprover', 'requiredApprovals', 'rejectionPolicy', 'perParty', 'delegation', 'sla', 'escalateTo'], path);
  const roleRefs = refs(v.roleRefs, `${path}.roleRefs`);
  const groupRefs = refs(v.groupRefs, `${path}.groupRefs`);
  const subjectRefs = refs(v.subjectRefs, `${path}.subjectRefs`);
  if (v.clientApprover !== undefined && typeof v.clientApprover !== 'boolean') fail(`${path}.clientApprover`, 'must be a boolean.');
  const clientApprover = v.clientApprover === true;
  if (clientApprover && !CLIENT_APPROVER_CLASSES.has(actionClass)) {
    fail(`${path}.clientApprover`, `client approvers are accepted only on ${[...CLIENT_APPROVER_CLASSES].join(', ')} until the client portal covers other classes (ADR 0942 Q4).`);
  }
  const hasRoleBased = (roleRefs?.length ?? 0) > 0 || (groupRefs?.length ?? 0) > 0;
  if (!hasRoleBased && !clientApprover) fail(path, 'an approval must name roleRefs or groupRefs (subjectRefs alone are not enough, ADR 0942 D10.1).');
  if (v.requiredApprovals !== 1 && v.requiredApprovals !== 2 && v.requiredApprovals !== 3) fail(`${path}.requiredApprovals`, 'must be 1, 2 or 3.');
  const requiredApprovals = v.requiredApprovals;
  const rejectionPolicy = v.rejectionPolicy === undefined ? undefined : oneOf(v.rejectionPolicy, ['any', 'majority'] as const, `${path}.rejectionPolicy`);
  const delegation = oneOf(v.delegation, ['allowed', 'none'] as const, `${path}.delegation`);

  let perParty: PerPartyQuorum[] | undefined;
  if (v.perParty !== undefined) {
    if (!Array.isArray(v.perParty) || v.perParty.length === 0 || v.perParty.length > 2) fail(`${path}.perParty`, 'must list one or two parties.');
    perParty = v.perParty.map((p, i): PerPartyQuorum => {
      const pp = `${path}.perParty[${i}]`;
      if (!isObj(p)) fail(pp, 'must be an object.');
      onlyKeys(p, ['party', 'refs', 'min'], pp);
      const party = oneOf(p.party, ['agency', 'client'] as const, `${pp}.party`);
      const r = oneOf(p.refs, ['roleRefs', 'clientApprover'] as const, `${pp}.refs`);
      if ((party === 'client') !== (r === 'clientApprover')) fail(pp, 'the client party counts clientApprover votes; the agency party counts roleRefs votes.');
      if (p.min !== 1 && p.min !== 2) fail(`${pp}.min`, 'must be 1 or 2.');
      return { party, refs: r, min: p.min };
    });
    if (new Set(perParty.map((p) => p.party)).size !== perParty.length) fail(`${path}.perParty`, 'lists a party twice.');
    if (perParty.reduce((n, p) => n + p.min, 0) > requiredApprovals) fail(`${path}.perParty`, 'the per-party minimums exceed requiredApprovals.');
    if (perParty.some((p) => p.refs === 'clientApprover') && !clientApprover) fail(`${path}.perParty`, 'counts client votes but clientApprover is not set.');
  }
  // ADR 0942 D9 correction (2026-10-19): mixing client approvers with role refs
  // needs a per-party quorum. Two agency votes must never satisfy "client and agency".
  if (clientApprover && hasRoleBased && !(perParty?.some((p) => p.party === 'client') && perParty.some((p) => p.party === 'agency'))) {
    fail(`${path}.perParty`, 'an approval mixing clientApprover with role or group refs must set a per-party quorum for both parties.');
  }

  let sla: ApproverSpec['sla'];
  if (v.sla !== undefined) {
    if (!isObj(v.sla)) fail(`${path}.sla`, 'must be an object.');
    onlyKeys(v.sla, ['remindAfterMs', 'escalateAfterMs', 'expireAfterMs'], `${path}.sla`);
    const remindAfterMs = ms(v.sla.remindAfterMs, `${path}.sla.remindAfterMs`, 60_000);
    const escalateAfterMs = ms(v.sla.escalateAfterMs, `${path}.sla.escalateAfterMs`, 60_000);
    const expireAfterMs = ms(v.sla.expireAfterMs, `${path}.sla.expireAfterMs`, 60_000);
    const ordered = [remindAfterMs, escalateAfterMs, expireAfterMs].filter((x): x is number => x !== undefined);
    if (ordered.some((x, i) => i > 0 && x <= ordered[i - 1])) fail(`${path}.sla`, 'remind, escalate and expire must come in that order.');
    sla = { ...(remindAfterMs !== undefined ? { remindAfterMs } : {}), ...(escalateAfterMs !== undefined ? { escalateAfterMs } : {}), ...(expireAfterMs !== undefined ? { expireAfterMs } : {}) };
  }
  let escalateTo: ApproverSpec['escalateTo'];
  if (v.escalateTo !== undefined) {
    if (!isObj(v.escalateTo)) fail(`${path}.escalateTo`, 'must be an object.');
    onlyKeys(v.escalateTo, ['roleRefs'], `${path}.escalateTo`);
    const r = refs(v.escalateTo.roleRefs, `${path}.escalateTo.roleRefs`);
    if (!r?.length) fail(`${path}.escalateTo.roleRefs`, 'must name at least one role.');
    escalateTo = { roleRefs: r };
  }
  return {
    ...(roleRefs?.length ? { roleRefs } : {}),
    ...(groupRefs?.length ? { groupRefs } : {}),
    ...(subjectRefs?.length ? { subjectRefs } : {}),
    ...(clientApprover ? { clientApprover: true } : {}),
    requiredApprovals,
    ...(rejectionPolicy ? { rejectionPolicy } : {}),
    ...(perParty ? { perParty } : {}),
    delegation,
    ...(sla && Object.keys(sla).length ? { sla } : {}),
    ...(escalateTo ? { escalateTo } : {}),
  };
}

export function validateDecision(v: unknown, path: string, actionClass: ActionClass): Decision {
  if (!isObj(v)) fail(path, 'must be an object.');
  const outcome = oneOf(v.outcome, OUTCOMES, `${path}.outcome`);
  if (APPROVE_FLOOR_CLASSES.has(actionClass) && SEVERITY[outcome] < SEVERITY.approve) {
    fail(`${path}.outcome`, `${actionClass} can never be looser than approve.`);
  }
  switch (outcome) {
    case 'auto':
      onlyKeys(v, ['outcome'], path);
      return { outcome };
    case 'notify-after':
      onlyKeys(v, ['outcome', 'notify'], path);
      return { outcome, notify: validateNotify(v.notify, `${path}.notify`) };
    case 'approve':
      onlyKeys(v, ['outcome', 'approver', 'notify'], path);
      return {
        outcome,
        approver: validateApprover(v.approver, `${path}.approver`, actionClass),
        ...(v.notify !== undefined ? { notify: validateNotify(v.notify, `${path}.notify`) } : {}),
      };
    case 'blocked': {
      onlyKeys(v, ['outcome', 'reason'], path);
      if (typeof v.reason !== 'string' || v.reason.trim().length === 0 || v.reason.length > MAX_REASON_LEN) fail(`${path}.reason`, `must be a non-empty string of at most ${MAX_REASON_LEN} characters.`);
      return { outcome, reason: v.reason.trim() };
    }
  }
}

/**
 * A condition's operator must be legal for its fact's type. No fact is string-typed
 * today, so `in` is refused for every fact (ADR 0942 D2 correction, 2026-10-20).
 */
function validateCondition(v: unknown, path: string): Condition {
  if (!isObj(v)) fail(path, 'must be an object.');
  onlyKeys(v, ['fact', 'op', 'value'], path);
  const fact = oneOf(v.fact, Object.keys(FACT_TYPES) as RiskFact[], `${path}.fact`);
  const op = oneOf(v.op, CONDITION_OPS, `${path}.op`);
  const type = FACT_TYPES[fact];
  if (type === 'number') {
    if (op === 'in') fail(`${path}.op`, `${fact} is a number; use >=, >, <=, < or ==.`);
    if (typeof v.value !== 'number' || !Number.isFinite(v.value)) fail(`${path}.value`, `${fact} compares against a number.`);
    if (fact === 'confidence' && (v.value < 0 || v.value > 1)) fail(`${path}.value`, 'confidence is between 0 and 1.');
    return { fact, op, value: v.value };
  }
  if (op !== '==') fail(`${path}.op`, `${fact} is true or false; use ==.`);
  if (typeof v.value !== 'boolean') fail(`${path}.value`, `${fact} compares against true or false.`);
  return { fact, op, value: v.value };
}

export function validateRule(v: unknown, path: string): ActionRule {
  if (!isObj(v)) fail(path, 'must be an object.');
  onlyKeys(v, ['actionClass', 'stage', 'default', 'escalations'], path);
  const actionClass = oneOf(v.actionClass, ACTION_CLASSES, `${path}.actionClass`);
  let stage: ReviewStage | undefined;
  if (v.stage !== undefined) {
    if (actionClass !== 'creative.review') fail(`${path}.stage`, 'only creative.review rules have a stage.');
    stage = oneOf(v.stage, REVIEW_STAGES, `${path}.stage`);
  }
  const def = validateDecision(v.default, `${path}.default`, actionClass);
  let escalations: ActionRule['escalations'];
  if (v.escalations !== undefined) {
    if (!Array.isArray(v.escalations) || v.escalations.length > MAX_ESCALATIONS) fail(`${path}.escalations`, `must be an array of at most ${MAX_ESCALATIONS}.`);
    escalations = v.escalations.map((e, i) => {
      const ep = `${path}.escalations[${i}]`;
      if (!isObj(e)) fail(ep, 'must be an object.');
      onlyKeys(e, ['when', 'then'], ep);
      if (!Array.isArray(e.when) || e.when.length === 0 || e.when.length > MAX_CONDITIONS) fail(`${ep}.when`, `must list 1 to ${MAX_CONDITIONS} conditions.`);
      const when = e.when.map((c, j) => validateCondition(c, `${ep}.when[${j}]`));
      const then = validateDecision(e.then, `${ep}.then`, actionClass);
      // D2: thresholds tighten, never loosen.
      if (SEVERITY[then.outcome] < SEVERITY[def.outcome]) {
        fail(`${ep}.then.outcome`, `an escalation may only be at least as strict as the rule's default (${def.outcome}).`);
      }
      return { when, then };
    });
  }
  return { actionClass, ...(stage ? { stage } : {}), default: def, ...(escalations?.length ? { escalations } : {}) };
}

/** Validate a full rule set: one rule per (class, stage). */
export function validateRules(v: unknown, path = 'rules'): ActionRule[] {
  if (!Array.isArray(v) || v.length > MAX_RULES) fail(path, `must be an array of at most ${MAX_RULES} rules.`);
  const rules = v.map((r, i) => validateRule(r, `${path}[${i}]`));
  const seen = new Set<string>();
  rules.forEach((r, i) => {
    const k = `${r.actionClass}:${r.stage ?? '*'}`;
    if (seen.has(k)) fail(`${path}[${i}]`, `a second rule for ${r.actionClass}${r.stage ? ` (${r.stage})` : ''}.`);
    seen.add(k);
  });
  return rules;
}

export function validatePresetId(v: unknown, path = 'preset'): PresetId {
  return oneOf(v, PRESET_IDS, path);
}
