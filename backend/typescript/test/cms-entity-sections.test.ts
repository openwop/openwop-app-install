/**
 * ADR 0407 Phase 2 — the entity-backed section builders (`entityList` /
 * `entityDetail`): structural validation only (reference-not-copy — the
 * productGrid model), bounded/clamped config, partial-mode tolerance.
 */
import { describe, expect, it } from 'vitest';
import { validateSections } from '../src/features/cms/cmsService.js';

const sec = (type: string, data: Record<string, unknown>) => [{ sectionId: 's1', type, data }];

describe('ADR 0407 entity-backed sections — validation', () => {
  it('accepts a full entityList config and clamps limit to 24', () => {
    const [s] = validateSections(sec('entityList', {
      eyebrow: 'Team', heading: 'Meet the team',
      tenantId: 'tenant-1', typeName: 'team-member',
      titleField: 'name', bodyField: 'role',
      limit: 500, sortKey: 'name', sortDir: 'asc',
    }));
    expect(s?.data).toMatchObject({
      tenantId: 'tenant-1', typeName: 'team-member', titleField: 'name',
      bodyField: 'role', limit: 24, sortKey: 'name', sortDir: 'asc',
    });
  });

  it('rejects an entityList missing its reference triplet (tenantId/typeName/titleField)', () => {
    expect(() => validateSections(sec('entityList', { typeName: 't', titleField: 'x' }))).toThrow(/tenantId/);
    expect(() => validateSections(sec('entityList', { tenantId: 'a', titleField: 'x' }))).toThrow(/typeName/);
    expect(() => validateSections(sec('entityList', { tenantId: 'a', typeName: 't' }))).toThrow(/titleField/);
  });

  it('stores a bounded termId and drops a malformed one (ADR 0407 Phase 3)', () => {
    const [ok] = validateSections(sec('entityList', {
      tenantId: 'a', typeName: 't', titleField: 'n', termId: 'term-abc_123',
    }));
    expect(ok?.data.termId).toBe('term-abc_123');
    const [bad] = validateSections(sec('entityList', {
      tenantId: 'a', typeName: 't', titleField: 'n', termId: 'nope nope!',
    }));
    expect(bad?.data.termId).toBeUndefined();
  });

  it('drops an invalid sortDir and non-numeric limit instead of storing them', () => {
    const [s] = validateSections(sec('entityList', {
      tenantId: 'a', typeName: 't', titleField: 'n', sortDir: 'sideways', limit: 'many',
    }));
    expect(s?.data.sortDir).toBeUndefined();
    expect(s?.data.limit).toBeUndefined();
  });

  it('accepts entityDetail and requires its entityId', () => {
    const [s] = validateSections(sec('entityDetail', {
      tenantId: 'a', typeName: 'team-member', entityId: 'e-42', titleField: 'name',
    }));
    expect(s?.data).toMatchObject({ tenantId: 'a', typeName: 'team-member', entityId: 'e-42', titleField: 'name' });
    expect(() => validateSections(sec('entityDetail', { tenantId: 'a', typeName: 't', titleField: 'n' }))).toThrow(/entityId/);
  });
});
