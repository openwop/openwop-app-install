/**
 * Sales Territory Management — assignment engine (ADR 0272 Phase 2).
 *
 * Filter-based auto-assignment: each `AssignmentRule` maps CRM companies/deals
 * to a territory when a record matches its `FilterExpr` (a small, safe
 * field·op·value grammar with all/any composition — NO arbitrary code). Rules
 * are priority-ordered, first-match-wins per model+target. Rules are editable
 * only on a `planning` model (mirrors the territory-edit freeze).
 *
 * Materialization (`materializeAssignments`) evaluates every rule against every
 * org company/deal and writes deterministic `Assignment` rows. It runs on model
 * ACTIVATION and via a manual re-sync route. (There is no in-process CRM-write
 * subscribe seam — `emitHostEvent` feeds only webhooks/triggers — so freshness
 * for records created AFTER activation is handled by re-sync + the P4 resolver's
 * lazy per-record evaluation, NOT an event hook. Recorded correction to the ADR
 * "CRM-write hook".)
 *
 * Reads CRM records via the peer `../crm` service functions — the established
 * feature→crm import pattern (commerce/csm/forms/production all do this).
 *
 * @see docs/adr/0272-sales-territory-management.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { validateAssignmentRule, validateAssignment } from './rowGuards.js';
import { OpenwopError } from '../../../types.js';
import { cleanString, cleanOpaqueToken } from '../../../host/boundedStrings.js';
import { listDeals, type Deal } from '../../crm/entities/deals.js';
import { listCompanies, type Company } from '../../crm/entities/companies.js';
import { getModel, getActiveModelId, getTerritory, listTerritories, bumpAssignVersion } from './territories.js';

export type FilterOp = 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'exists';
export const FILTER_OPS: readonly FilterOp[] = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'];

export type Scalar = string | number | boolean;
export interface Condition {
  field: string;
  op: FilterOp;
  value?: Scalar | Scalar[];
}
export type FilterExpr = { all: FilterExpr[] } | { any: FilterExpr[] } | Condition;
export type AssignTarget = 'company' | 'deal';

export interface AssignmentRule {
  ruleId: string;
  tenantId: string;
  orgId: string;
  modelId: string;
  territoryId: string;
  target: AssignTarget;
  filter: FilterExpr;
  priority: number;
  createdAt: string;
}

export interface Assignment {
  assignmentId: string; // deterministic: `${modelId}:${target}:${recordId}` → idempotent
  tenantId: string;
  orgId: string;
  modelId: string;
  territoryId: string;
  target: AssignTarget;
  recordId: string;
  source: 'rule' | 'manual';
  ruleId?: string;
  at: string;
}

const DEAL_FIELDS = new Set(['title', 'amount', 'currency', 'stageId', 'pipelineId', 'companyId', 'contactId', 'owner', 'status', 'closeDate']);
const COMPANY_FIELDS = new Set(['name', 'domain', 'industry', 'tags']);
const MAX = { conditions: 100, depth: 6, perModelRules: 500, valueLen: 200 };

const rules = new DurableCollection<AssignmentRule>('crm:territory-rule', (r) => r.ruleId, validateAssignmentRule, (r) => r.tenantId);
const assignments = new DurableCollection<Assignment>('crm:territory-assignment', (a) => a.assignmentId, validateAssignment, (a) => a.tenantId);

const nowIso = (): string => new Date().toISOString();
const assignmentId = (modelId: string, target: AssignTarget, recordId: string): string => `${modelId}:${target}:${recordId}`;
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] => rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);

// ── FilterExpr validation (fail-closed, bounded) ─────────────────────────────

// A customFields key is a strict token — excludes dunder/prototype keys
// (`__proto__`, `constructor`, `toString`, …) that would otherwise resolve to
// inherited Object.prototype members and make a rule match every record.
const CUSTOM_FIELD_RE = /^customFields\.[A-Za-z0-9_-]{1,64}$/;
function fieldAllowed(target: AssignTarget, field: string): boolean {
  if (field.startsWith('customFields.')) {
    if (!CUSTOM_FIELD_RE.test(field)) return false;
    const key = field.slice('customFields.'.length);
    // reject any Object.prototype member (`__proto__`, `constructor`, `toString`,
    // `hasOwnProperty`, …) — the charset alone admits underscores so `__proto__`
    // would otherwise pass; these resolve to inherited members, not own data.
    return !(key in Object.prototype);
  }
  return (target === 'deal' ? DEAL_FIELDS : COMPANY_FIELDS).has(field);
}

function validateExpr(expr: unknown, target: AssignTarget, depth: number, counter: { n: number }): FilterExpr {
  if (depth > MAX.depth) throw new OpenwopError('validation_error', 'Filter is nested too deeply.', 400, { maxDepth: MAX.depth });
  if (!expr || typeof expr !== 'object') throw new OpenwopError('validation_error', 'Filter must be an object.', 400, {});
  const e = expr as Record<string, unknown>;

  if (Array.isArray(e.all) || Array.isArray(e.any)) {
    const key = Array.isArray(e.all) ? 'all' : 'any';
    const arr = e[key] as unknown[];
    if (arr.length === 0) throw new OpenwopError('validation_error', `Filter \`${key}\` must be non-empty.`, 400, {});
    return { [key]: arr.map((sub) => validateExpr(sub, target, depth + 1, counter)) } as FilterExpr;
  }

  // a leaf Condition
  if (++counter.n > MAX.conditions) throw new OpenwopError('validation_error', 'Filter has too many conditions.', 400, { max: MAX.conditions });
  const field = cleanString(e.field, 100, '');
  if (!field || !fieldAllowed(target, field)) throw new OpenwopError('validation_error', `Field \`${String(e.field)}\` is not a filterable ${target} field.`, 400, { field: e.field });
  if (typeof e.op !== 'string' || !FILTER_OPS.includes(e.op as FilterOp)) throw new OpenwopError('validation_error', `Unknown filter op \`${String(e.op)}\`.`, 400, { op: e.op });
  const op = e.op as FilterOp;

  const cond: Condition = { field, op };
  if (op !== 'exists') {
    if (op === 'in') {
      if (!Array.isArray(e.value) || e.value.length === 0 || e.value.length > 100) throw new OpenwopError('validation_error', '`in` requires a non-empty value array (≤100).', 400, {});
      cond.value = e.value.map((v) => coerceScalar(v));
    } else {
      cond.value = coerceScalar(e.value);
    }
  }
  return cond;
}

function coerceScalar(v: unknown): Scalar {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, MAX.valueLen);
  throw new OpenwopError('validation_error', 'Filter values must be string, finite number, or boolean.', 400, {});
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function projectDeal(d: Deal): Record<string, Scalar | undefined> {
  return { title: d.title, amount: d.amount, currency: d.currency, stageId: d.stageId, pipelineId: d.pipelineId, companyId: d.companyId, contactId: d.contactId, owner: d.owner, status: d.status ?? 'open', closeDate: d.closeDate };
}
function fieldValue(target: AssignTarget, record: Deal | Company, field: string): Scalar | Scalar[] | undefined {
  if (field.startsWith('customFields.')) {
    const key = field.slice('customFields.'.length);
    const cf = (record as { customFields?: Record<string, Scalar> }).customFields;
    // own-property only — never read inherited prototype members (defence in
    // depth even though CUSTOM_FIELD_RE already excludes dunder keys).
    return cf && Object.hasOwn(cf, key) ? cf[key] : undefined;
  }
  if (target === 'company') {
    if (field === 'tags') return (record as Company).tags;
    return (record as unknown as Record<string, Scalar | undefined>)[field];
  }
  return projectDeal(record as Deal)[field];
}

function cmp(a: Scalar, b: Scalar): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function evalCondition(fv: Scalar | Scalar[] | undefined, c: Condition): boolean {
  switch (c.op) {
    case 'exists':
      return Array.isArray(fv) ? fv.length > 0 : fv !== undefined && fv !== '';
    case 'eq':
      return Array.isArray(fv) ? fv.includes(c.value as Scalar) : fv === c.value;
    case 'ne':
      return Array.isArray(fv) ? !fv.includes(c.value as Scalar) : fv !== c.value;
    case 'contains': {
      const needle = String(c.value).toLowerCase();
      if (Array.isArray(fv)) return fv.some((x) => String(x).toLowerCase().includes(needle));
      return fv !== undefined && String(fv).toLowerCase().includes(needle);
    }
    case 'in':
      if (!Array.isArray(c.value)) return false;
      // symmetric with `eq`: an array field matches if ANY element is in the set
      if (Array.isArray(fv)) return fv.some((x) => (c.value as Scalar[]).includes(x));
      return fv !== undefined && (c.value as Scalar[]).includes(fv);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (fv === undefined || Array.isArray(fv) || c.value === undefined) return false;
      const r = cmp(fv, c.value as Scalar);
      return c.op === 'gt' ? r > 0 : c.op === 'gte' ? r >= 0 : c.op === 'lt' ? r < 0 : r <= 0;
    }
    default:
      return false;
  }
}

function evalExpr(expr: FilterExpr, target: AssignTarget, record: Deal | Company): boolean {
  if ('all' in expr) return expr.all.every((s) => evalExpr(s, target, record));
  if ('any' in expr) return expr.any.some((s) => evalExpr(s, target, record));
  return evalCondition(fieldValue(target, record, expr.field), expr);
}

/** Order rules for a target: priority desc, then createdAt asc (stable). */
export function orderRules(modelRules: AssignmentRule[], target: AssignTarget): AssignmentRule[] {
  return modelRules.filter((r) => r.target === target).sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

/** First matching rule against ALREADY-ordered rules → its territory + ruleId. */
export function firstMatch(orderedRules: AssignmentRule[], target: AssignTarget, record: Deal | Company): { territoryId: string; ruleId: string } | null {
  for (const r of orderedRules) if (evalExpr(r.filter, target, record)) return { territoryId: r.territoryId, ruleId: r.ruleId };
  return null;
}

/** Convenience: order + first-match in one call (single-record callers, e.g. the
 *  P4 lazy resolver). Loop callers should `orderRules` once then `firstMatch`. */
export function evaluateRecord(modelRules: AssignmentRule[], target: AssignTarget, record: Deal | Company): { territoryId: string; ruleId: string } | null {
  return firstMatch(orderRules(modelRules, target), target, record);
}

// ── Rule CRUD (planning-model only) ──────────────────────────────────────────

async function requirePlanningModelId(tenantId: string, orgId: string, modelId: string): Promise<void> {
  const raw = await getModel(tenantId, orgId, modelId); // projected; 'active' if pointer names it
  if (raw.state !== 'planning') throw new OpenwopError('validation_error', `Model is ${raw.state}; rules can only be edited on a planning model.`, 409, { modelId, state: raw.state });
}

export async function listRules(tenantId: string, orgId: string, modelId: string): Promise<AssignmentRule[]> {
  await getModel(tenantId, orgId, modelId); // IDOR + existence
  return scoped(await rules.listForTenantIndexed(tenantId), tenantId, orgId).filter((r) => r.modelId === modelId).sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

export async function createRule(tenantId: string, orgId: string, modelId: string, input: { territoryId?: unknown; target?: unknown; filter?: unknown; priority?: unknown }): Promise<AssignmentRule> {
  await requirePlanningModelId(tenantId, orgId, modelId);
  const existing = scoped(await rules.listForTenantIndexed(tenantId), tenantId, orgId).filter((r) => r.modelId === modelId);
  if (existing.length >= MAX.perModelRules) throw new OpenwopError('validation_error', `This model has the maximum ${MAX.perModelRules} rules.`, 409, { max: MAX.perModelRules });

  const target = input.target === 'company' ? 'company' : input.target === 'deal' ? 'deal' : null;
  if (!target) throw new OpenwopError('validation_error', '`target` must be "company" or "deal".', 400, { target: input.target });
  const territoryId = cleanOpaqueToken(input.territoryId, 200);
  if (!territoryId) throw new OpenwopError('validation_error', '`territoryId` is required.', 400, {});
  await getTerritory(tenantId, orgId, modelId, territoryId); // territory must exist in this model (IDOR)
  const filter = validateExpr(input.filter, target, 0, { n: 0 });
  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== 'number' || !Number.isFinite(input.priority)) throw new OpenwopError('validation_error', '`priority` must be a finite number.', 400, {});
    priority = Math.trunc(input.priority);
  }

  const rule: AssignmentRule = { ruleId: `terrrule:${randomUUID()}`, tenantId, orgId, modelId, territoryId, target, filter, priority, createdAt: nowIso() };
  await rules.put(rule);
  return rule;
}

export async function deleteRule(tenantId: string, orgId: string, modelId: string, ruleId: string): Promise<void> {
  await requirePlanningModelId(tenantId, orgId, modelId);
  const r = await rules.get(ruleId);
  if (!r || r.tenantId !== tenantId || r.orgId !== orgId || r.modelId !== modelId) throw new OpenwopError('not_found', 'Rule not found.', 404, { ruleId });
  await rules.delete(ruleId);
}

/** Purge ALL rules + materialized assignments for a model (TERR-DATA-2 cascade,
 *  invoked before `deleteArchivedModel`). No lifecycle guard here — the caller
 *  (routes.ts purge) already asserted the model is archived. Returns the row
 *  count removed. */
export async function deleteModelAssignmentData(tenantId: string, orgId: string, modelId: string): Promise<number> {
  let removed = 0;
  for (const r of scoped(await rules.listForTenantIndexed(tenantId), tenantId, orgId).filter((r) => r.modelId === modelId)) {
    await rules.delete(r.ruleId);
    removed += 1;
  }
  for (const a of scoped(await assignments.listForTenantIndexed(tenantId), tenantId, orgId).filter((a) => a.modelId === modelId)) {
    await assignments.delete(a.assignmentId);
    removed += 1;
  }
  return removed;
}

// ── Preview (dry-run, no writes) + materialization ───────────────────────────

interface AssignmentSummary {
  perTerritory: Array<{ territoryId: string; name: string; companies: number; deals: number }>;
  unassigned: { companies: number; deals: number };
  totals: { companies: number; deals: number };
}

async function computeAssignments(tenantId: string, orgId: string, modelId: string): Promise<{ rows: Array<{ target: AssignTarget; recordId: string; territoryId: string | null; ruleId: string | null }>; summary: AssignmentSummary }> {
  const [modelRules, territories, deals, companies] = await Promise.all([
    listRules(tenantId, orgId, modelId),
    listTerritories(tenantId, orgId, modelId),
    listDeals(tenantId, orgId),
    listCompanies(tenantId, orgId),
  ]);
  const byTerr = new Map<string, { name: string; companies: number; deals: number }>(territories.map((t) => [t.territoryId, { name: t.name, companies: 0, deals: 0 }]));
  const unassigned = { companies: 0, deals: 0 };
  const rows: Array<{ target: AssignTarget; recordId: string; territoryId: string | null; ruleId: string | null }> = [];

  const run = (target: AssignTarget, records: Array<Deal | Company>, idOf: (r: Deal | Company) => string, bump: (b: { companies: number; deals: number }) => void): void => {
    const ordered = orderRules(modelRules, target); // sort ONCE per target, not per record
    for (const rec of records) {
      const match = firstMatch(ordered, target, rec);
      rows.push({ target, recordId: idOf(rec), territoryId: match?.territoryId ?? null, ruleId: match?.ruleId ?? null });
      if (match && byTerr.has(match.territoryId)) bump(byTerr.get(match.territoryId)!);
      else bump(unassigned);
    }
  };
  run('company', companies as Company[], (r) => (r as Company).companyId, (b) => (b.companies += 1));
  run('deal', deals as Deal[], (r) => (r as Deal).dealId, (b) => (b.deals += 1));

  return {
    rows,
    summary: {
      perTerritory: [...byTerr.entries()].map(([territoryId, v]) => ({ territoryId, ...v })),
      unassigned,
      totals: { companies: companies.length, deals: deals.length },
    },
  };
}

/** Dry-run against any model (typically a planning scenario) — no writes. */
export async function previewModel(tenantId: string, orgId: string, modelId: string): Promise<AssignmentSummary> {
  return (await computeAssignments(tenantId, orgId, modelId)).summary;
}

/** Materialize `Assignment` rows for a model (idempotent, deterministic ids).
 *  Prunes rows for records that no longer match. Runs on activation + re-sync. */
export async function materializeAssignments(tenantId: string, orgId: string, modelId: string): Promise<AssignmentSummary> {
  await getModel(tenantId, orgId, modelId); // IDOR
  const { rows, summary } = await computeAssignments(tenantId, orgId, modelId);
  const at = nowIso();
  const keep = new Set<string>();
  for (const row of rows) {
    if (!row.territoryId) continue;
    const id = assignmentId(modelId, row.target, row.recordId);
    keep.add(id);
    const rec: Assignment = { assignmentId: id, tenantId, orgId, modelId, territoryId: row.territoryId, target: row.target, recordId: row.recordId, source: 'rule', at, ...(row.ruleId ? { ruleId: row.ruleId } : {}) };
    await assignments.put(rec);
  }
  // prune stale rows for this model
  for (const a of scoped(await assignments.listForTenantIndexed(tenantId), tenantId, orgId).filter((a) => a.modelId === modelId)) {
    if (!keep.has(a.assignmentId)) await assignments.delete(a.assignmentId);
  }
  await bumpAssignVersion(tenantId, orgId); // invalidate every instance's visibility index
  return summary;
}

/** Active-model assignments (P3 reports + P4 visibility consume this). */
export async function listAssignmentsForModel(tenantId: string, orgId: string, modelId: string): Promise<Assignment[]> {
  return scoped(await assignments.listForTenantIndexed(tenantId), tenantId, orgId).filter((a) => a.modelId === modelId);
}

/** ADR 0283 / TERR-DATA-1 — drop every assignment row (across ALL models: active,
 *  planning, archived) that points at a deleted CRM record. Bounded: one
 *  tenant-indexed scan + point deletes. Idempotent — a re-fire finds nothing. */
export async function pruneAssignmentsForRecord(tenantId: string, orgId: string, target: AssignTarget, recordId: string): Promise<number> {
  const doomed = scoped(await assignments.listForTenantIndexed(tenantId), tenantId, orgId)
    .filter((a) => a.target === target && a.recordId === recordId);
  for (const a of doomed) await assignments.delete(a.assignmentId);
  return doomed.length;
}

/** Materialize the currently-active model (called on activation + re-sync). */
export async function reassignActiveModel(tenantId: string, orgId: string): Promise<AssignmentSummary | null> {
  const activeId = await getActiveModelId(tenantId, orgId);
  if (!activeId) return null;
  return materializeAssignments(tenantId, orgId, activeId);
}

