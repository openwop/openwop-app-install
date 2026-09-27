/**
 * Read-side row validators (ADR 0280) for the sales-commissions collections.
 * Passed as each DurableCollection's `validate` arg so a corrupt / schema-drifted
 * row is rejected at the persistence boundary instead of trusted via a blind cast.
 *
 * Implemented as user-defined TYPE PREDICATES (`v is T`) so a passing check
 * narrows with NO cast (the lesson from the territories rowGuards review). And
 * DELIBERATELY LENIENT — a validator returning `null` hides the row from reads, so
 * over-strict validation is worse than the drift it guards. Each guard checks only
 * core identity (object + non-empty id/tenantId/orgId) and load-bearing fields
 * (name, currency, the assignment object, the rules array); optional fields are
 * never checked.
 */
import type { CommissionPlan } from './plan.js';
import type { CommissionStatement } from './statement.js';

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNeStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const identified = (v: unknown, idKey: string): v is Rec => isObj(v) && isNeStr(v[idKey]) && isNeStr(v.tenantId) && isNeStr(v.orgId);

function isCommissionPlan(v: unknown): v is CommissionPlan {
  // R2 COM2-M9 — `assignment` is OPTIONAL on the row: subject erasure CLEARS it (an
  // erased person must not remain a payment target), and a validator that still required
  // it made the erased plan fail its own guard — so the row vanished from every read
  // instead of surviving unassigned. A destructive privacy action must not delete the
  // business record as a side effect.
  return identified(v, 'planId') && isNeStr(v.name) && isNeStr(v.currency) && (v.assignment === undefined || isObj(v.assignment)) && Array.isArray(v.rules) && isNeStr(v.effectiveFrom);
}
function isCommissionStatement(v: unknown): v is CommissionStatement {
  return identified(v, 'statementId') && isNeStr(v.subjectId) && isNeStr(v.period) && isNeStr(v.planId) && isNeStr(v.currency)
    && Array.isArray(v.lines) && isNum(v.total) && (v.status === 'draft' || v.status === 'approved' || v.status === 'paid');
}

export const validateCommissionPlan = (v: unknown): CommissionPlan | null => (isCommissionPlan(v) ? v : null);
export const validateCommissionStatement = (v: unknown): CommissionStatement | null => (isCommissionStatement(v) ? v : null);
