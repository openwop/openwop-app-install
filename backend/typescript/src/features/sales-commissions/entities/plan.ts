/**
 * Sales Commissions — the CommissionPlan model (ADR 0280 Phase 1).
 *
 * A plan pays a rep (the deal's `owner`, RFC 0048 subject — no new people store)
 * for won deals, at a `percentage` or `fixed` rate, with optional accelerators
 * that boost the rate past a quota-attainment threshold (ADR 0272 attainment,
 * composed in P2) and an optional cap. `assignment` decides WHO the plan pays:
 * a territory, a role, or a single rep. One active plan per assignment (overlap
 * is an open question — ADR 0280 §8).
 *
 * Host-extension only — no OpenWOP wire (rides Accepted RFC 0049 scopes). Every
 * accessor verifies `tenantId` + `orgId` (the CRM IDOR guard). Rows carry a
 * read-side `validate` (rowGuards) so a drifted row is skipped, not trusted.
 *
 * @see docs/adr/0280-sales-commissions.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString, cleanOpaqueToken } from '../../../host/boundedStrings.js';
import { validateCommissionPlan } from './rowGuards.js';
import { subjectKeyForms, ERASED } from '../../../host/subjectErasureRedaction.js';

export type CommissionType = 'percentage' | 'fixed';
export type RuleBasis = 'deal-won';
export type AssignmentKind = 'territory' | 'role' | 'rep';

/** WHO a plan pays. `ref` is a territoryId / roleId / subject id per `kind`. */
export interface PlanAssignment {
  kind: AssignmentKind;
  ref: string;
}

/** A boosted rate that applies once the rep's quota attainment ≥ `attainmentGte`
 *  (a percent, e.g. 100 = at-quota). `rate` is in the rule's `type` units. */
export interface CommissionAccelerator {
  attainmentGte: number;
  rate: number;
}

export interface CommissionRule {
  basis: RuleBasis;
  /** `percentage` ⇒ commission = dealAmount × rate/100; `fixed` ⇒ flat `rate` per won deal. */
  type: CommissionType;
  rate: number;
  /** Applied highest-matching-threshold-first (P2). */
  accelerators?: CommissionAccelerator[];
  /** Max total commission (currency) this rule may accrue in a period. */
  cap?: number;
}

export interface CommissionPlan {
  planId: string;
  tenantId: string;
  orgId: string;
  name: string;
  /** 3-letter ISO-4217. */
  currency: string;
  /** R2 COM2-M9 — OPTIONAL because subject erasure CLEARS it: an erased person must not
   *  remain someone the system will pay, and a sentinel `ref` would still satisfy the
   *  COM2-B5 assignment check. An unassigned plan pays nobody until it is re-assigned. */
  assignment?: PlanAssignment;
  rules: CommissionRule[];
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
  effectiveTo?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// R3 — a percentage rate had NO upper bound, so `rate: 500` was a valid plan and a
// fat-fingered 15 → 150 paid 1.5× the deal with no tripwire before the approval card.
const MAX = { name: 160, perOrgPlans: 200, perPlanRules: 50, perRuleAccelerators: 20, percentageRate: 100 } as const;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ASSIGNMENT_KINDS: readonly AssignmentKind[] = ['territory', 'role', 'rep'];

const plans = new DurableCollection<CommissionPlan>('commissions:commission-plan', (p) => p.planId, validateCommissionPlan, (p) => p.tenantId);

const nowIso = (): string => new Date().toISOString();
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] =>
  rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);

function requireName(raw: unknown): string {
  const name = cleanString(raw, MAX.name, '');
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required and MUST be a non-empty string.', 400, { field: 'name' });
  return name;
}

/** A non-negative finite number for a rate/cap/threshold field. */
function num(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new OpenwopError('validation_error', `\`${field}\` must be a non-negative finite number.`, 400, { field });
  return raw;
}

function requireCurrency(raw: unknown): string {
  const cur = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (!CURRENCY_RE.test(cur)) throw new OpenwopError('validation_error', '`currency` must be a 3-letter ISO-4217 code.', 400, { currency: raw });
  return cur;
}

function requireDate(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) throw new OpenwopError('validation_error', `\`${field}\` must be a YYYY-MM-DD date.`, 400, { field });
  return raw;
}

function cleanAssignment(raw: unknown): PlanAssignment {
  if (typeof raw !== 'object' || raw === null) throw new OpenwopError('validation_error', '`assignment` is required.', 400, { field: 'assignment' });
  const a = raw as { kind?: unknown; ref?: unknown };
  const kind = a.kind;
  if (kind !== 'territory' && kind !== 'role' && kind !== 'rep') throw new OpenwopError('validation_error', '`assignment.kind` must be one of territory|role|rep.', 400, { field: 'assignment.kind', allowed: ASSIGNMENT_KINDS });
  const ref = cleanOpaqueToken(a.ref, MAX.name) || '';
  if (!ref) throw new OpenwopError('validation_error', '`assignment.ref` is required (the territory/role/rep id the plan pays).', 400, { field: 'assignment.ref' });
  return { kind, ref };
}

/** Validate + normalize the `rules[]` array (basis, type, rate, accelerators, cap). */
function cleanRules(raw: unknown): CommissionRule[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new OpenwopError('validation_error', '`rules` must be a non-empty array.', 400, { field: 'rules' });
  if (raw.length > MAX.perPlanRules) throw new OpenwopError('validation_error', `A plan may have at most ${MAX.perPlanRules} rules.`, 400, { max: MAX.perPlanRules });
  return raw.map((r, i) => {
    if (typeof r !== 'object' || r === null) throw new OpenwopError('validation_error', `\`rules[${i}]\` must be an object.`, 400, { index: i });
    const rule = r as { basis?: unknown; type?: unknown; rate?: unknown; accelerators?: unknown; cap?: unknown };
    if (rule.basis !== 'deal-won') throw new OpenwopError('validation_error', `\`rules[${i}].basis\` must be 'deal-won'.`, 400, { index: i });
    if (rule.type !== 'percentage' && rule.type !== 'fixed') throw new OpenwopError('validation_error', `\`rules[${i}].type\` must be percentage|fixed.`, 400, { index: i });
    const type: CommissionType = rule.type;
    const rate = num(rule.rate, `rules[${i}].rate`);
    if (type === 'percentage' && rate > MAX.percentageRate) throw new OpenwopError('validation_error', `\`rules[${i}].rate\` is a percentage and must be ≤ ${MAX.percentageRate} (got ${rate}).`, 400, { index: i, max: MAX.percentageRate });
    const out: CommissionRule = { basis: 'deal-won', type, rate };
    if (rule.accelerators !== undefined) {
      if (!Array.isArray(rule.accelerators)) throw new OpenwopError('validation_error', `\`rules[${i}].accelerators\` must be an array.`, 400, { index: i });
      if (rule.accelerators.length > MAX.perRuleAccelerators) throw new OpenwopError('validation_error', `A rule may have at most ${MAX.perRuleAccelerators} accelerators.`, 400, { max: MAX.perRuleAccelerators });
      const accelerators = rule.accelerators.map((a, j) => {
        if (typeof a !== 'object' || a === null) throw new OpenwopError('validation_error', `\`rules[${i}].accelerators[${j}]\` must be an object.`, 400, { index: i, accel: j });
        const acc = a as { attainmentGte?: unknown; rate?: unknown };
        const accRate = num(acc.rate, `rules[${i}].accelerators[${j}].rate`);
        if (type === 'percentage' && accRate > MAX.percentageRate) throw new OpenwopError('validation_error', `\`rules[${i}].accelerators[${j}].rate\` is a percentage and must be ≤ ${MAX.percentageRate} (got ${accRate}).`, 400, { index: i, accel: j, max: MAX.percentageRate });
        return { attainmentGte: num(acc.attainmentGte, `rules[${i}].accelerators[${j}].attainmentGte`), rate: accRate };
      });
      if (accelerators.length > 0) out.accelerators = accelerators;
    }
    if (rule.cap !== undefined) out.cap = num(rule.cap, `rules[${i}].cap`);
    return out;
  });
}

export async function createPlan(tenantId: string, orgId: string, input: Record<string, unknown>, actor: string): Promise<CommissionPlan> {
  const count = scoped(await plans.listForTenantIndexed(tenantId), tenantId, orgId).length;
  if (count >= MAX.perOrgPlans) throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgPlans} commission plans.`, 409, { max: MAX.perOrgPlans });
  const effectiveFrom = requireDate(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = input.effectiveTo !== undefined ? requireDate(input.effectiveTo, 'effectiveTo') : undefined;
  if (effectiveTo && effectiveTo < effectiveFrom) throw new OpenwopError('validation_error', '`effectiveTo` must not precede `effectiveFrom`.', 400, { effectiveFrom, effectiveTo });
  const now = nowIso();
  const plan: CommissionPlan = {
    planId: `commplan:${randomUUID()}`,
    tenantId,
    orgId,
    name: requireName(input.name),
    currency: requireCurrency(input.currency),
    assignment: cleanAssignment(input.assignment),
    rules: cleanRules(input.rules),
    effectiveFrom,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
    ...(effectiveTo ? { effectiveTo } : {}),
  };
  await plans.put(plan);
  return plan;
}

export async function listPlans(tenantId: string, orgId: string): Promise<CommissionPlan[]> {
  return scoped(await plans.listForTenantIndexed(tenantId), tenantId, orgId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getPlan(tenantId: string, orgId: string, planId: string): Promise<CommissionPlan> {
  const p = await plans.get(planId);
  if (!p || p.tenantId !== tenantId || p.orgId !== orgId) throw new OpenwopError('not_found', 'Commission plan not found.', 404, { planId });
  return p;
}

export async function updatePlan(tenantId: string, orgId: string, planId: string, patch: Record<string, unknown>, actor: string): Promise<CommissionPlan> {
  void actor;
  const existing = await getPlan(tenantId, orgId, planId);
  const next: CommissionPlan = { ...existing };
  if (patch.name !== undefined) next.name = requireName(patch.name);
  if (patch.currency !== undefined) next.currency = requireCurrency(patch.currency);
  if (patch.assignment !== undefined) next.assignment = cleanAssignment(patch.assignment);
  if (patch.rules !== undefined) next.rules = cleanRules(patch.rules);
  if (patch.effectiveFrom !== undefined) next.effectiveFrom = requireDate(patch.effectiveFrom, 'effectiveFrom');
  if (patch.effectiveTo !== undefined) next.effectiveTo = requireDate(patch.effectiveTo, 'effectiveTo');
  if (next.effectiveTo && next.effectiveTo < next.effectiveFrom) throw new OpenwopError('validation_error', '`effectiveTo` must not precede `effectiveFrom`.', 400, { effectiveFrom: next.effectiveFrom, effectiveTo: next.effectiveTo });
  next.updatedAt = nowIso();
  await plans.put(next);
  return next;
}

export async function deletePlan(tenantId: string, orgId: string, planId: string): Promise<void> {
  await getPlan(tenantId, orgId, planId); // 404 + IDOR before delete
  await plans.delete(planId);
}

/**
 * R2 COM2-M9 — the plan half of subject erasure. `assignment.ref` holds a SUBJECT ID
 * when `kind === 'rep'` — under a field name no ratchet inspects — and it is the field
 * that decides who a plan pays.
 *
 * CORRECTION (review): this docblock used to claim the grant is "removed … so the next
 * `computeStatement` refuses on the assignment check", while the code wrote a SENTINEL —
 * which passes that check and returns a 0-total draft, and collapses two erased reps
 * onto one `ref`. The prose and the test disagreed, and the prose was the wrong one. The
 * assignment is now genuinely CLEARED (`assignment` is optional), so B5 refuses every
 * subject for an unassigned plan and an operator has to re-assign it deliberately.
 * `createdBy` is authorship on a business record and is anonymized in place.
 */
export async function erasePlanSubject(tenantId: string, subjectKey: string): Promise<void> {
  const forms = subjectKeyForms(subjectKey).forms;
  for (const p of await plans.listForTenantIndexed(tenantId)) {
    if (p.tenantId !== tenantId) continue;
    const next = { ...p };
    let touched = false;
    if (p.assignment !== undefined && p.assignment.kind === 'rep' && forms.has(p.assignment.ref)) {
      delete next.assignment;
      touched = true;
    }
    if (forms.has(p.createdBy)) { next.createdBy = ERASED; touched = true; }
    if (touched) await plans.put(next);
  }
}

