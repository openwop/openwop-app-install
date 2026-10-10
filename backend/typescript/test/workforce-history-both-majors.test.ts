/**
 * openwop#1742 (#1770) — the Workforce synthetic history wrote the v2 shapes of
 * `approval.requested` / `approval.granted` / `approval.overridden`. Those are
 * INVALID on the v1 wire: v1 requires `gateId` + `principal` (and for the
 * request `nodeId`/`artifactId`/…), while the closed v2 defs forbid them, so no
 * single stored payload could be legal on both majors. The fixture now records
 * the protocol pair the executor itself emits — `interrupt.requested` (built by
 * the SAME projector, #4212) and `interrupt.resolved` — which validate on both.
 *
 * The REAL path: `seedWorkforceHistory` persists into storage, and every event is
 * read back through `listEvents` at contract 1 AND contract 2 (the era adapter),
 * then validated against that major's vendored `$defs`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { seedWorkforceHistory } from '../src/host/workforceService.js';
import { projectV2RunIds } from '../src/host/v2Ids.js';

const req = createRequire(`${process.cwd()}/`);
const SCHEMAS = join(req.resolve('@openwop/spec-artifacts/package.json'), '..', 'schemas');

/** Ajv over one major's package schemas, siblings registered by walking `$ref`s. */
function defsFor(major: 1 | 2): (type: string) => ((d: unknown) => boolean) & { errors?: unknown } {
  const dir = major === 1 ? SCHEMAS : join(SCHEMAS, 'v2');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (req('ajv-formats').default ?? req('ajv-formats'))(ajv);
  const root = JSON.parse(readFileSync(join(dir, 'run-event-payloads.schema.json'), 'utf8')) as { $defs: Record<string, unknown> & { _typeIndex: { properties: Record<string, { $ref: string }> } } };
  const registered = new Set<string>(['run-event-payloads.schema.json']);
  ajv.addSchema(root, 'run-event-payloads.schema.json');
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        const file = v.split('#')[0]?.split('/').pop() ?? '';
        if (file.endsWith('.schema.json') && !registered.has(file)) {
          registered.add(file);
          const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { $id?: string };
          ajv.addSchema(doc, file);
          if (typeof doc.$id === 'string') { try { ajv.addSchema(doc, doc.$id); } catch { /* dup */ } }
          walk(doc);
        }
      } else walk(v);
    }
  };
  walk(root);
  return (type) => {
    const ref = root.$defs._typeIndex.properties[type]?.$ref;
    const v = ref ? ajv.getSchema(`run-event-payloads.schema.json${ref}`) : undefined;
    if (!v) throw new Error(`major ${major}: no def for ${type}`);
    return v as ((d: unknown) => boolean) & { errors?: unknown };
  };
}

const GATE_TYPES = ['node.suspended', 'interrupt.requested', 'interrupt.resolved'] as const;

describe('openwop#1742 — the Workforce gate events validate on BOTH majors, read back through storage', () => {
  it('seeded, then read at contract 1 and contract 2: every gate event validates, and no approval.* type is written', async () => {
    const storage = await openStorage('memory://');
    setEventLogBackend(storage);
    const tenant = 'wf-both-majors';
    const seeded = await seedWorkforceHistory(storage, tenant, { runCount: 60, nowMs: 1_800_000_000_000 });
    expect(seeded.runs, 'non-vacuous: history was seeded').toBeGreaterThan(0);
    const v1 = defsFor(1); const v2 = defsFor(2);
    const runs = await storage.listRuns({ tenantId: tenant, limit: 1000 });
    const failures: string[] = [];
    const seen = new Map<string, number>();
    for (const run of runs) {
      const e1 = await storage.listEvents(run.runId, { fromSeq: -1, limit: 1000, contract: 1 });
      const e2 = await storage.listEvents(run.runId, { fromSeq: -1, limit: 1000, contract: 2 });
      for (const e of e1) {
        expect(e.type.startsWith('approval.'), `${e.type} written: the v1-invalid kind-specific shape is back`).toBe(false);
        if (!(GATE_TYPES as readonly string[]).includes(e.type)) continue;
        seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
        const v = v1(e.type);
        if (!v(e.payload)) failures.push(`v1 ${e.type}: ${JSON.stringify(v.errors)}`);
      }
      for (const e of e2) {
        if (!(GATE_TYPES as readonly string[]).includes(e.type)) continue;
        const v = v2(e.type);
        const wire = projectV2RunIds(e.payload, tenant);
        if (!v(wire)) failures.push(`v2 ${e.type}: ${JSON.stringify(v.errors)}`);
      }
    }
    for (const t of GATE_TYPES) expect(seen.get(t) ?? 0, `${t} must be exercised`).toBeGreaterThan(0);
    expect(failures.slice(0, 8), `${failures.length} failures`).toEqual([]);
  });
});
