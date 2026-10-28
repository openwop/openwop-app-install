/**
 * ADR 0440 — tripwire for the DEFERRED `validateWorkflowDefinition` whitelist.
 *
 * `validateWorkflowDefinition` returns a node whitelist. The wire's `WorkflowNode`
 * (`schemas/workflow-definition.schema.json`) declares more — so `agent`,
 * `credentialsRef`, `outputSensitivity`, `envelopeContract`, `settings`,
 * `disabled`, `notes`, `groupId`, `artifactType`, and `cardType` are silently
 * dropped by the host's own POST route.
 *
 * §CORRECTION (/grade-tests 8f W5): this said a FIVE-field whitelist. MEASURED at
 * 19d13e682 it keeps NINE (`nodeId`, `typeId`, `name`, `position`, `config`,
 * `inputs`, `outputRole`, `compensation`, `irreversibleEffect` — ADR 0770 D4 and
 * later widened it). The dropped list is no longer hand-copied: it is DERIVED by
 * putting each schema property on a node and asking the validator, so a widened
 * validator shrinks it by itself and a new schema field it drops joins it.
 *
 * ADR 0440 deliberately DEFERS widening that whitelist: it would change what the
 * host persists for every author path, and the executor honors `nodeRef.agent`
 * (`executor.ts`), so persisting it changes run behavior. The deferral is only
 * safe while nothing ships a node carrying a dropped field — verified true when
 * the ADR was written.
 *
 * This test is the forcing function that keeps it true. A bare "we'll do it
 * later" note goes stale invisibly; that is exactly how the CHAINX-5 bug landed
 * (dropping `inputs` silently discarded the RFC 0013 `{{params.*}}`-in-`inputs`
 * substitution, per the safety-fix comment in the validator). When this test
 * fails, the assumption has expired: either widen the whitelist (its own ADR) or
 * record why that pack's field is expendable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readPackManifest } from './helpers/readPackManifest.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';

/** A type-shaped dummy for one schema property (any value: a validated field
 *  that refuses it is, by that refusal, a field the validator handles). */
function dummyFor(prop: unknown): unknown {
  const type = typeof prop === 'object' && prop !== null ? Reflect.get(prop, 'type') : undefined;
  switch (type) {
    case 'string': return 'x';
    case 'boolean': return false;
    case 'number': case 'integer': return 1;
    case 'array': return [];
    default: return {}; // object, or a `$ref` (e.g. `agent`)
  }
}

/** Node fields the wire models but `validateWorkflowDefinition` drops — DERIVED
 *  from the schema (SSoT) and the validator, never copied. */
const DROPPED_BY_VALIDATOR: string[] = (() => {
  const schema: unknown = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'schemas', 'workflow-definition.schema.json'), 'utf8'));
  const defs = typeof schema === 'object' && schema !== null ? (Reflect.get(schema, '$defs') ?? Reflect.get(schema, 'definitions')) : undefined;
  const node = typeof defs === 'object' && defs !== null ? Reflect.get(defs, 'WorkflowNode') : undefined;
  const props = typeof node === 'object' && node !== null ? Reflect.get(node, 'properties') : undefined;
  if (typeof props !== 'object' || props === null) throw new Error('WorkflowNode.properties not found in the vendored schema');
  const dropped: string[] = [];
  for (const [field, prop] of Object.entries(props)) {
    if (field === 'id' || field === 'typeId') continue; // the wire `id` is the host's `nodeId`
    let kept: boolean;
    try {
      const out = validateWorkflowDefinition({ workflowId: 'tripwire.probe', nodes: [{ nodeId: 'n', typeId: 'core.noop', [field]: dummyFor(prop) }], edges: [] });
      kept = Object.prototype.hasOwnProperty.call(out.nodes[0], field);
    } catch {
      kept = true; // the validator inspects (and so owns) this field
    }
    if (!kept) dropped.push(field);
  }
  return dropped.sort();
})();

/**
 * BOTH vendored roots. `packs/` holds NODE packs and contains ZERO chain nodes;
 * every one of the 551 chain nodes lives under `examples/workflow-chain-packs/`.
 * Scanning only `packs/` meant this tripwire read 1407 JSON files and examined
 * NOTHING — for its whole life. Its guard counted FILES, which is why the
 * vacuity was invisible: 1407 > 0 passes while the assertion iterates an empty
 * set. Measuring the wrong artifact, again (ADR 0498 §GRD-8's lesson).
 */
const SCAN_ROOTS = [
  join(process.cwd(), '..', '..', 'packs'),
  join(process.cwd(), '..', '..', 'examples', 'workflow-chain-packs'),
];
const REPO_ROOT = join(process.cwd(), '..', '..');

function jsonFilesUnder(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // packs/ absent in this checkout — the test self-skips below
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) jsonFilesUnder(full, acc);
    else if (name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

/** Every object that looks like a workflow node (has `typeId`), at any depth —
 *  chain packs nest node arrays under `chains[].definition.nodes`. */
function collectNodes(value: unknown, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, acc);
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.typeId === 'string' && (obj.nodeId !== undefined || obj.id !== undefined)) acc.push(obj);
    for (const v of Object.values(obj)) collectNodes(v, acc);
  }
  return acc;
}

describe('ADR 0440 — no shipped pack node carries a field the validator drops', () => {
  const files = SCAN_ROOTS.flatMap((root) => jsonFilesUnder(root));
  // Parse every file ONCE (≈1,600 files, ≈9 MB): both cases read this.
  const nodesByFile = files.map((file) => {
    try { return { file, nodes: collectNodes(readPackManifest(file)) }; } catch { return { file, nodes: [] }; }
  });
  const allNodes = nodesByFile.flatMap((f) => f.nodes);

  it('derives a non-empty dropped-field list from the schema + validator', () => {
    // `agent` is the field the executor honours (ADR 0440's reason to defer).
    expect(DROPPED_BY_VALIDATOR).toContain('agent');
    expect(DROPPED_BY_VALIDATOR).not.toContain('config');
    // MEASURED at 19d13e682: the ten fields the header names (not pinned: a widened
    // validator is meant to shrink this list by itself).
    expect(DROPPED_BY_VALIDATOR.length).toBeGreaterThan(1);
  });

  it('examines a real population of NODES (never a vacuous pass)', () => {
    // The guard must count what the assertion ITERATES. The previous version
    // asserted `files.length > 0` and passed on 1407 files while examining zero
    // nodes — a file count cannot detect a root that holds no nodes.
    expect(files.length, 'no JSON files found — both scan roots are wrong').toBeGreaterThan(0);
    expect(
      allNodes.length,
      'no workflow NODES found — the assertion below would iterate an empty set while this file reports green',
    ).toBeGreaterThanOrEqual(764); // MEASURED 764 at 19d13e682 (/grade-tests 8f W5; 551 at 2026-08-03, floor was 500)
  });

  it('no node declares a validator-dropped field', () => {
    const violations: string[] = [];
    for (const { file, nodes } of nodesByFile) {
      for (const node of nodes) {
        for (const field of DROPPED_BY_VALIDATOR) {
          if (node[field] !== undefined) {
            violations.push(`${file.replace(REPO_ROOT + '/', '')} → node ${String(node.nodeId ?? node.id)} declares "${field}"`);
          }
        }
      }
    }
    expect(
      violations,
      `A pack now ships a node field the host's POST validator DROPS (ADR 0440 deferred widening it).\n`
      + `Either widen validateWorkflowDefinition (needs its own ADR — the executor honors node.agent)\n`
      + `or record why the field is expendable here.\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
