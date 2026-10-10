import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../../../executor/types.js';
import { applyEditOps, normalizeEditOps, readConfigPath, writeConfigPath } from '../editOps.js';

const head: WorkflowDefinition = {
  workflowId: 'wf.ops',
  nodes: [
    { nodeId: 'a', typeId: 'core.noop', name: 'A', config: { retry: { maxAttempts: 1 } } },
    { nodeId: 'b', typeId: 'core.noop', name: 'B' },
    { nodeId: 'g', typeId: 'core.approvalGate', name: 'Gate' },
  ],
  edges: [{ edgeId: 'ab', sourceNodeId: 'a', targetNodeId: 'b' }, { edgeId: 'bg', sourceNodeId: 'b', targetNodeId: 'g' }],
};
const ok = () => ({ ok: true, errors: [] as string[] });
const norm = (rawOps: unknown) => normalizeEditOps({ suggestionId: 's1', head, rawOps, validate: ok, isKnownTypeId: (t) => t.startsWith('core.') });

describe('ADR 0773 D4 — edit-op normalization', () => {
  it('mints node ids, resolves a FORWARD ref, and records the dependency', () => {
    const r = norm([
      { kind: 'addEdge', source: 'b', target: 'n1' },
      { kind: 'addNode', ref: 'n1', typeId: 'core.noop', name: 'New' },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const add = r.ops[1]!.op;
    expect(add.kind === 'addNode' && add.nodeId).toBe('sg_s1_1');
    expect(r.ops[0]!.dependsOn).toEqual([1]);
    expect(r.ops[0]!.op.kind === 'addEdge' && r.ops[0]!.op.targetNodeId).toBe('sg_s1_1');
  });

  it('records the preimage a keep compares against, and flags gate-touching ops', () => {
    const r = norm([
      { kind: 'setConfig', nodeId: 'a', path: 'retry.maxAttempts', value: 3 },
      { kind: 'removeEdge', edgeId: 'bg' },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.ops[0]!.preimages).toEqual([{ path: 'nodes.a.config.retry.maxAttempts', present: true, value: 1 }]);
    expect(r.ops[0]!.gateSensitive).toBe(false);
    expect(r.ops[1]!.gateSensitive).toBe(true);
  });

  it('refuses unknown ids, a model-chosen collision, a contradiction, and non-wire conditions — per op', () => {
    const r = norm([
      { kind: 'renameNode', nodeId: 'zzz', name: 'x' },
      { kind: 'addNode', ref: 'a', typeId: 'core.noop' },
      { kind: 'removeNode', nodeId: 'b' },
      { kind: 'setConfig', nodeId: 'b', path: 'x', value: 1 },
      { kind: 'setCondition', edgeId: 'ab', condition: { path: 'p', op: 'falsy', value: 1 } },
      { kind: 'addNode', ref: 'q', typeId: 'vendor.unknown' },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.index).sort()).toEqual([0, 1, 3, 4, 5]);
  });

  it('applies ops into a candidate the caller validates; a failing validator fails the whole set', () => {
    const r = normalizeEditOps({ suggestionId: 's2', head, rawOps: [{ kind: 'addEdge', source: 'g', target: 'a' }], validate: () => ({ ok: false, errors: ['cycle_detected'] }), isKnownTypeId: () => true });
    expect(r.ok).toBe(false);
    const applied = applyEditOps(head, [{ kind: 'removeNode', nodeId: 'b' }]);
    expect(applied.edges).toEqual([]);
  });

  it('config paths refuse prototype keys and round-trip nested writes', () => {
    expect(writeConfigPath({}, '__proto__.x', 1)).toEqual({});
    const w = writeConfigPath({ retry: { maxAttempts: 1, backoffMs: 5 } }, 'retry.maxAttempts', 3);
    expect(w).toEqual({ retry: { maxAttempts: 3, backoffMs: 5 } });
    expect(readConfigPath(w, 'retry.backoffMs')).toEqual({ present: true, value: 5 });
  });
});
