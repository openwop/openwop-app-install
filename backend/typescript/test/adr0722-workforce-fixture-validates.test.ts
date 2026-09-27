/**
 * ADR 0722 / corpus 2.3.2 — the Workforce synthetic-history fixture writes SEATED
 * payload shapes. Every event it generates, projected onto the major-2 wire the
 * way `eventEraAdapter.listEvents` projects it, validates against its corpus def.
 *
 * Why: the fixture used to write `{prompt}` on `approval.requested` (the wrong
 * MODEL — the def IS `suspend-request`), `principal` on `approval.granted`,
 * `outcome` on `run.completed`, and omitted `typeId` / `interruptId`. Those were
 * a third of the wire-seam residue and none of them was a host feature.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { projectV2Payload } from '../src/storage/v2PayloadProjection.js';
import { projectV2RunIds } from '../src/host/v2Ids.js';
import { generateWorkforceHistory } from '../src/host/workforceHistory.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = locateRepoSchemasDir(here, 'run-event.schema.json');
const payloads = JSON.parse(readFileSync(join(schemasDir, 'v2', 'run-event-payloads.schema.json'), 'utf8')) as {
  $defs: Record<string, { properties?: Record<string, unknown>; $ref?: string }> & { _typeIndex: { properties: Record<string, { $ref: string }> } };
};

/** Ajv over the vendored corpus, siblings registered by walking `$ref`s (ADR 0702). */
function validatorFor(defName: string) {
  const req = createRequire(join(here, '..', 'package.json'));
  const Ajv = (req('ajv/dist/2020.js').default ?? req('ajv/dist/2020.js')) as new (o: object) => { addSchema: (s: unknown, k: string) => void; getSchema: (k: string) => ((d: unknown) => boolean) | undefined };
  const ajv = new Ajv({ strict: false, allErrors: true });
  (req('ajv-formats').default ?? req('ajv-formats'))(ajv);
  const registered = new Set(['run-event-payloads.schema.json']);
  ajv.addSchema(payloads, 'run-event-payloads.schema.json');
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        const file = v.split('#')[0]?.split('/').pop() ?? '';
        if (file.endsWith('.schema.json') && !registered.has(file)) {
          registered.add(file);
          const doc = JSON.parse(readFileSync(join(schemasDir, 'v2', file), 'utf8')) as { $id?: string };
          ajv.addSchema(doc, file);
          if (typeof doc.$id === 'string') { try { ajv.addSchema(doc, doc.$id); } catch { /* dup */ } }
          walk(doc);
        }
      } else walk(v);
    }
  };
  walk(payloads);
  const v = ajv.getSchema(`run-event-payloads.schema.json#/$defs/${defName}`);
  if (!v) throw new Error(`def ${defName} did not compile`);
  return v;
}


const BASE = {
  workforceId: 'workforce.finance.invoice-exception',
  tenantId: 'demo',
  workflowId: 'openwop-app.agents.invoice-exception',
  seed: 'ep0-fixed-seed',
  epochMs: 1_700_000_000_000, // fixed logical epoch — never the wall clock
  runCount: 240,
  weeks: 6,
};

describe('workforce history fixture — every event validates on the major-2 wire (corpus 2.3.2)', () => {
  it('projects clean: zero validation errors across every generated event that has a v2 def', () => {
    const h = generateWorkforceHistory(BASE);
    const validators = new Map<string, ReturnType<typeof validatorFor>>();
    const failures: string[] = []; const covered = new Set<string>(); let checked = 0;
    for (const run of h.runs) {
      for (const e of run.events) {
        const ref = payloads.$defs._typeIndex.properties[e.type]?.$ref;
        if (!ref) continue; // no v2 def (e.g. host-ext `provider.usage`) — not this test's claim
        const defName = ref.replace(/^#\/\$defs\//, '');
        let v = validators.get(defName);
        if (!v) { v = validatorFor(defName); validators.set(defName, v); }
        // The full major-2 wire: the storage projection (envelope ids, aliases,
        // owner echo) THEN the transport's bound-id projection (ADR 0723) — the
        // order every egress channel applies.
        const wire = projectV2RunIds(projectV2Payload(e.type, e.payload, { runId: e.runId, ...(e.nodeId ? { nodeId: e.nodeId } : {}) }, BASE.tenantId), BASE.tenantId);
        checked++; covered.add(e.type);
        if (!v(wire)) failures.push(`${e.type}: ${JSON.stringify((v as { errors?: unknown }).errors)} ← ${JSON.stringify(wire).slice(0, 200)}`);
      }
    }
    expect(checked, 'non-vacuous: the fixture produced events with v2 defs').toBeGreaterThan(100);
    for (const t of ['run.started', 'node.started', 'node.suspended', 'approval.requested', 'approval.granted', 'approval.overridden', 'run.completed', 'run.failed', 'node.failed']) {
      expect(covered.has(t), `${t} must be exercised by the fixture`).toBe(true);
    }
    expect(failures.slice(0, 12), `${failures.length} of ${checked} events failed`).toEqual([]);
  });
});
