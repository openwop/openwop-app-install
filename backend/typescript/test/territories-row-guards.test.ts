/**
 * TERR-DATA-5 — read-side row validators for the territory collections.
 * The load-bearing property: validators must be LENIENT (never skip a valid row,
 * incl. one missing optional fields), and reject only genuinely corrupt rows.
 * An accepted row is asserted to come back as the SAME object (the guard narrows,
 * it does not rebuild), so a guard that returns a stripped copy fails too.
 */
import { describe, expect, it } from 'vitest';
import {
  validateTerritoryType, validateTerritoryModel, validateTerritory,
  validateAssignmentRule, validateAssignment, validateQuota,
} from '../src/features/territories/entities/rowGuards.js';

describe('territories rowGuards — accept valid rows (incl. absent optionals)', () => {
  it('accepts a model and a territory with no optional fields set', () => {
    { const row = { modelId: 'm1', tenantId: 't', orgId: 'o', name: 'FY26', state: 'planning', createdBy: 'u', createdAt: 'x' }; expect(validateTerritoryModel(row)).toBe(row); }
    // territory WITHOUT managerSubjectId / territoryTypeId (optional) still validates
    { const row = { territoryId: 'tr1', tenantId: 't', orgId: 'o', modelId: 'm1', name: 'West', parentTerritoryId: null, memberSubjectIds: [], createdAt: 'x', updatedAt: 'y' }; expect(validateTerritory(row)).toBe(row); }
  });
  it('accepts a quota with no currency, and a rule + assignment', () => {
    { const row = { quotaId: 'q', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', period: '2026-Q1', amount: 0, repSplits: [], updatedAt: 'x' }; expect(validateQuota(row)).toBe(row); }
    { const row = { ruleId: 'r', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', target: 'deal', filter: { all: [] }, priority: 1, createdAt: 'x' }; expect(validateAssignmentRule(row)).toBe(row); }
    { const row = { assignmentId: 'a', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', target: 'company', recordId: 'c1', source: 'rule', at: 'x' }; expect(validateAssignment(row)).toBe(row); }
  });
  it('accepts a type', () => {
    { const row = { territoryTypeId: 'ty', tenantId: 't', orgId: 'o', name: 'Geo', priority: 5, createdAt: 'x' }; expect(validateTerritoryType(row)).toBe(row); }
  });
});

describe('territories rowGuards — reject corrupt rows', () => {
  it('rejects missing identity, wrong-typed discriminants, and non-objects', () => {
    expect(validateTerritoryModel({ modelId: 'm', tenantId: 't', orgId: 'o', name: 'X', state: 'bogus' })).toBeNull(); // bad enum
    expect(validateTerritoryModel({ tenantId: 't', orgId: 'o', name: 'X', state: 'planning' })).toBeNull(); // no modelId
    expect(validateQuota({ quotaId: 'q', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', period: '2026-Q1', amount: 'lots', repSplits: [], updatedAt: 'x' })).toBeNull(); // amount not a number
    expect(validateAssignment({ assignmentId: 'a', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', target: 'lead', recordId: 'c', source: 'rule', at: 'x' })).toBeNull(); // bad target
    expect(validateTerritory({ territoryId: 'tr', tenantId: 't', orgId: 'o', modelId: 'm', name: 'W', parentTerritoryId: null, memberSubjectIds: 'nope', createdAt: 'x', updatedAt: 'y' })).toBeNull(); // members not array
    expect(validateTerritoryType(null)).toBeNull();
    // An array carrying every id field, so only the `!Array.isArray` check can
    // refuse it (a bare `[]` also fails the identity check: probe
    // 8fw3g3-trg-array was vacuous on it).
    expect(validateTerritoryType(Object.assign([], { territoryTypeId: 'ty', tenantId: 't', orgId: 'o', name: 'Geo', priority: 5, createdAt: 'x' }))).toBeNull();
    expect(validateTerritoryType([])).toBeNull();
  });
});
