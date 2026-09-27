/**
 * ADR 0386 Phase 6 — prompt↔catalog parity for the entities exchange lane.
 * The invariant (CLAUDE.md "AI↔app information exchange"): schema text reaching
 * a model is GENERATED from its SSoT or test-pinned to it — never hand-copied.
 *
 * Entity type schemas are RUNTIME data (the workspace defines them), so the
 * SSoT the tool descriptions may legitimately hand-carry is only the FIELD-KIND
 * vocabulary — which lives in host/customFields (ADR 0257). These pins fail
 * when either side drifts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FIELD_TYPES } from '../../../host/customFields/index.js';
import { projectType } from '../surface.js';
import type { EntityTypeRecord } from '../entitiesService.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentToolsSrc = readFileSync(join(here, '..', 'agentTools.ts'), 'utf8');

describe('entities prompt↔catalog parity (ADR 0386)', () => {
  it('describe-type tool description derives its field-kind list from the seam SSoT, not a hand-copied string', () => {
    // The description is built with a template over FIELD_TYPES.join — assert the
    // source interpolates the SSoT rather than enumerating kinds literally.
    expect(agentToolsSrc).toContain('FIELD_TYPES.join');
    // Sentinel-absent: no hard-coded kind enumeration in the tool description.
    expect(agentToolsSrc).not.toMatch(/string, number, boolean, date, enum/);
  });

  it('query tool teaches the exact filter-op vocabulary the service enforces', () => {
    // The ops enumerated in the tool inputSchema must match the service's closed world.
    const OPS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains'];
    for (const op of OPS) {
      expect(agentToolsSrc).toContain(`'${op}'`);
    }
  });

  it('projectType is a faithful projection of the stored SSoT record (every field property survives)', () => {
    const rec: EntityTypeRecord = {
      typeId: 't::x',
      tenantId: 't',
      projectId: '',
      name: 'x',
      displayName: 'X',
      description: 'd',
      fields: [
        { key: 'a', label: 'A', type: 'string', required: true },
        { key: 'b', label: 'B', type: 'enum', required: false, options: ['1', '2'] },
        { key: 'c', label: 'C', type: 'reference', required: false, refEntityType: 'y' },
        { key: 'd', label: 'D', type: 'media', required: false },
      ],
      status: 'published',
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const projected = projectType(rec) as {
      name: string; status: string; fields: Array<Record<string, unknown>>;
    };
    expect(projected.name).toBe('x');
    expect(projected.status).toBe('published');
    expect(projected.fields).toHaveLength(4);
    expect(projected.fields[1]).toMatchObject({ key: 'b', type: 'enum', options: ['1', '2'] });
    expect(projected.fields[2]).toMatchObject({ key: 'c', type: 'reference', refEntityType: 'y' });
    // Every declared field kind the projection can carry is a seam kind.
    for (const f of projected.fields) {
      expect(FIELD_TYPES).toContain(f.type);
    }
  });

  it('describe-type output is exempt from tool-result compaction (SCHEMA_READ_EXEMPT)', async () => {
    const { SCHEMA_READ_EXEMPT_TOOLS } = await import('../../../host/toolResultTransform.js');
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain('openwop:entities.describe-type');
  });
});
