/**
 * ADR 0386 Phase 6 — prompt↔catalog parity for the entities exchange lane.
 * The invariant (CLAUDE.md "AI↔app information exchange"): schema text reaching
 * a model is GENERATED from its SSoT or test-pinned to it — never hand-copied.
 *
 * Entity type schemas are RUNTIME data (the workspace defines them), so the
 * SSoT the tool descriptions may legitimately hand-carry is only the FIELD-KIND
 * vocabulary — which lives in host/customFields (ADR 0257). These pins fail
 * when either side drifts: they read the tool declarations the model is offered and
 * the service's own `QUERY_OPS` (unexported, so parsed from its source), never a copy.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FIELD_TYPES } from '../../../host/customFields/index.js';
import { builtinAgentTool } from '../../../host/agentToolProvider.js';
import { SCHEMA_READ_EXEMPT_TOOLS } from '../../../host/toolResultTransform.js';
import { ENTITIES_DESCRIBE_TYPE_TOOL_ID, ENTITIES_QUERY_TOOL_ID, registerEntitiesAgentTools } from '../agentTools.js';
import { projectType } from '../surface.js';
import type { EntityTypeRecord } from '../entitiesService.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentToolsSrc = readFileSync(join(here, '..', 'agentTools.ts'), 'utf8');
const serviceSrc = readFileSync(join(here, '..', 'entitiesService.ts'), 'utf8');

registerEntitiesAgentTools();

describe('entities prompt↔catalog parity (ADR 0386)', () => {
  it('describe-type tool description derives its field-kind list from the seam SSoT, not a hand-copied string', () => {
    expect(builtinAgentTool(ENTITIES_DESCRIBE_TYPE_TOOL_ID)?.def.description).toContain(`field kinds: ${FIELD_TYPES.join(', ')}`);
    // Sentinel-absent: no hard-coded kind enumeration in the tool description.
    expect(agentToolsSrc).not.toMatch(/string, number, boolean, date, enum/);
  });

  it('query tool teaches the exact filter-op vocabulary the service enforces', () => {
    // The ops enumerated in the tool inputSchema must match the service's closed world.
    const declared = /const QUERY_OPS: QueryOp\[\] = \[([^\]]+)\]/.exec(serviceSrc)?.[1] ?? '';
    const ops = [...declared.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(ops.length).toBeGreaterThan(0);
    const tool = builtinAgentTool(ENTITIES_QUERY_TOOL_ID)?.def;
    expect(tool?.inputSchema).toMatchObject({ properties: { filters: { items: { properties: { op: { enum: ops } } } } } });
    expect(tool?.description).toContain(`op: ${ops.join('|')}`);
  });

  it('projectType is a faithful projection of the stored SSoT record (every field property survives)', () => {
    const rec: EntityTypeRecord = {
      typeId: 't::x',
      tenantId: 't',
      projectId: '',
      name: 'x',
      displayName: 'X',
      description: 'd',
      publicRead: true,
      fields: [
        { key: 'a', label: 'A', type: 'string', required: true, localizable: true },
        { key: 'b', label: 'B', type: 'enum', required: false, options: ['1', '2'] },
        { key: 'c', label: 'C', type: 'reference', required: false, refEntityType: 'y' },
        { key: 'd', label: 'D', type: 'media', required: false },
      ],
      status: 'published',
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(projectType(rec)).toEqual({
      name: 'x',
      displayName: 'X',
      description: 'd',
      projectId: '',
      status: 'published',
      publicRead: true,
      fields: [
        { key: 'a', label: 'A', type: 'string', required: true, localizable: true },
        { key: 'b', label: 'B', type: 'enum', required: false, options: ['1', '2'] },
        { key: 'c', label: 'C', type: 'reference', required: false, refEntityType: 'y' },
        { key: 'd', label: 'D', type: 'media', required: false },
      ],
    });
    // Every declared field kind the projection can carry is a seam kind.
    for (const f of rec.fields) {
      expect(FIELD_TYPES).toContain(f.type);
    }
  });

  it('describe-type output is exempt from tool-result compaction (SCHEMA_READ_EXEMPT)', () => {
    expect(SCHEMA_READ_EXEMPT_TOOLS).toContain('openwop:entities.describe-type');
  });
});
