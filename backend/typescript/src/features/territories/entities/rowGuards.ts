/**
 * Read-side row validators (TERR-DATA-5) for the seven `crm:territory-*`
 * DurableCollections. Passed as each collection's `validate` arg so a corrupt or
 * schema-drifted persisted row is REJECTED (skipped) at the persistence boundary
 * instead of flowing into the app as a malformed `T` via a blind `as T` cast.
 *
 * DELIBERATELY LENIENT. A validator that returns `null` makes the row disappear
 * from reads — so over-strict validation is WORSE than the drift it guards
 * against (it deletes-by-hiding valid data). Each guard therefore checks only:
 *   (1) core identity — an object with a non-empty primary id + tenantId + orgId
 *       (rows missing these can't be scoped/keyed anyway), and
 *   (2) genuinely load-bearing fields — enum discriminants read by control flow
 *       (`state`, `target`), numerics used in math (`priority`, `amount`), and
 *       arrays that are iterated (`memberSubjectIds`, `repSplits`).
 * OPTIONAL fields (`assignVersion?`, `currency?`, `activatedAt?`, `ruleId?`, …)
 * are never checked — their absence is normal drift the reads already tolerate.
 */
import type { TerritoryType, TerritoryModel, Territory } from './territories.js';
import type { AssignmentRule, Assignment } from './assignment.js';
import type { Quota } from './quota.js';

type Rec = Record<string, unknown>;
export const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isNeStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v); // internal only (isObj/isStr/isNeStr are shared with territories.ts)
/** Object with a non-empty primary id + tenantId + orgId — the minimum to scope + key a row. */
const identified = (v: unknown, idKey: string): v is Rec => isObj(v) && isNeStr(v[idKey]) && isNeStr(v.tenantId) && isNeStr(v.orgId);

// Each validator is a user-defined TYPE PREDICATE (`v is T`), so a passing check
// narrows `v` to the row type with NO cast — no double-cast escape hatch needed
// (the value never needs asserting; the predicate carries the type). The exported
// `validateX` wraps the predicate to the `T | null` shape DurableCollection expects.
function isTerritoryType(v: unknown): v is TerritoryType {
  return identified(v, 'territoryTypeId') && isNeStr(v.name) && isNum(v.priority);
}
function isTerritoryModel(v: unknown): v is TerritoryModel {
  return identified(v, 'modelId') && isNeStr(v.name) && (v.state === 'planning' || v.state === 'active' || v.state === 'archived');
}
function isTerritory(v: unknown): v is Territory {
  return identified(v, 'territoryId') && isNeStr(v.modelId) && isNeStr(v.name) && (v.parentTerritoryId === null || isStr(v.parentTerritoryId)) && Array.isArray(v.memberSubjectIds);
}
function isAssignmentRule(v: unknown): v is AssignmentRule {
  return identified(v, 'ruleId') && isNeStr(v.modelId) && isNeStr(v.territoryId) && (v.target === 'deal' || v.target === 'company') && isObj(v.filter) && isNum(v.priority);
}
function isAssignment(v: unknown): v is Assignment {
  return identified(v, 'assignmentId') && isNeStr(v.modelId) && isNeStr(v.recordId) && (v.target === 'deal' || v.target === 'company');
}
function isQuota(v: unknown): v is Quota {
  return identified(v, 'quotaId') && isNeStr(v.modelId) && isNeStr(v.territoryId) && isNeStr(v.period) && isNum(v.amount) && Array.isArray(v.repSplits);
}

export const validateTerritoryType = (v: unknown): TerritoryType | null => (isTerritoryType(v) ? v : null);
export const validateTerritoryModel = (v: unknown): TerritoryModel | null => (isTerritoryModel(v) ? v : null);
export const validateTerritory = (v: unknown): Territory | null => (isTerritory(v) ? v : null);
export const validateAssignmentRule = (v: unknown): AssignmentRule | null => (isAssignmentRule(v) ? v : null);
export const validateAssignment = (v: unknown): Assignment | null => (isAssignment(v) ? v : null);
export const validateQuota = (v: unknown): Quota | null => (isQuota(v) ? v : null);
