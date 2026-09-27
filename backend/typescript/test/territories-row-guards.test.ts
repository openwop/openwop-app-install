/**
 * TERR-DATA-5 — read-side row validators for the territory collections.
 * The load-bearing property: validators must be LENIENT (never skip a valid row,
 * incl. one missing optional fields), and reject only genuinely corrupt rows.
 */
import { describe, expect, it } from 'vitest';
import {
  validateTerritoryType, validateTerritoryModel, validateTerritory,
  validateAssignmentRule, validateAssignment, validateQuota,
} from '../src/features/territories/entities/rowGuards.js';

describe('territories rowGuards — accept valid rows (incl. absent optionals)', () => {
  it('accepts a model and a territory with no optional fields set', () => {
    expect(validateTerritoryModel({ modelId: 'm1', tenantId: 't', orgId: 'o', name: 'FY26', state: 'planning', createdBy: 'u', createdAt: 'x' })).not.toBeNull();
    // territory WITHOUT managerSubjectId / territoryTypeId (optional) still validates
    expect(validateTerritory({ territoryId: 'tr1', tenantId: 't', orgId: 'o', modelId: 'm1', name: 'West', parentTerritoryId: null, memberSubjectIds: [], createdAt: 'x', updatedAt: 'y' })).not.toBeNull();
  });
  it('accepts a quota with no currency, and a rule + assignment', () => {
    expect(validateQuota({ quotaId: 'q', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', period: '2026-Q1', amount: 0, repSplits: [], updatedAt: 'x' })).not.toBeNull();
    expect(validateAssignmentRule({ ruleId: 'r', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', target: 'deal', filter: { all: [] }, priority: 1, createdAt: 'x' })).not.toBeNull();
    expect(validateAssignment({ assignmentId: 'a', tenantId: 't', orgId: 'o', modelId: 'm', territoryId: 'tr', target: 'company', recordId: 'c1', source: 'rule', at: 'x' })).not.toBeNull();
  });
  it('accepts a type', () => {
    expect(validateTerritoryType({ territoryTypeId: 'ty', tenantId: 't', orgId: 'o', name: 'Geo', priority: 5, createdAt: 'x' })).not.toBeNull();
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
    expect(validateTerritoryType([])).toBeNull();
  });
});
