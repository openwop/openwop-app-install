/**
 * ADR 0440 — tripwire for the DEFERRED `validateWorkflowDefinition` whitelist.
 *
 * `validateWorkflowDefinition` returns a FIVE-field node whitelist (`nodeId`,
 * `typeId`, `config`, `inputs`, `outputRole`). The wire's `WorkflowNode`
 * (`schemas/workflow-definition.schema.json`) declares eighteen — so `agent`,
 * `credentialsRef`, `outputSensitivity`, `envelopeContract`, `settings`,
 * `disabled`, `notes`, `groupId`, `artifactType`, and `cardType` are silently
 * dropped by the host's own POST route.
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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Node fields the wire models but `validateWorkflowDefinition` drops. */
const DROPPED_BY_VALIDATOR = [
  'agent',
  'credentialsRef',
  'outputSensitivity',
  'envelopeContract',
  'settings',
  'disabled',
  'notes',
  'groupId',
  'artifactType',
  'cardType',
] as const;

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
  const allNodes = files.flatMap((file) => {
    try { return collectNodes(JSON.parse(readFileSync(file, 'utf8'))); } catch { return []; }
  });

  it('examines a real population of NODES (never a vacuous pass)', () => {
    // The guard must count what the assertion ITERATES. The previous version
    // asserted `files.length > 0` and passed on 1407 files while examining zero
    // nodes — a file count cannot detect a root that holds no nodes.
    expect(files.length, 'no JSON files found — both scan roots are wrong').toBeGreaterThan(0);
    expect(
      allNodes.length,
      'no workflow NODES found — the assertion below would iterate an empty set while this file reports green',
    ).toBeGreaterThan(500); // 551 at 2026-08-03
  });

  it('no node declares a validator-dropped field', () => {
    const violations: string[] = [];
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue; // not valid JSON — other gates cover that
      }
      for (const node of collectNodes(parsed)) {
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
