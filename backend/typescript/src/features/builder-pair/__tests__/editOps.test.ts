/**
 * ADR 0773 D4 — the closed edit-op vocabulary of a `WorkflowEditSuggestion` and its pure
 * normalize pipeline (`builder-pair/editOps.ts`): server-minted node ids (a model-chosen id
 * could collide with a peer's node), forward refs with recorded dependencies, per-op
 * preimages (a keep is checked per op, D5), gate-sensitive flags (an op touching an
 * approval gate is never auto-kept, ADR 0582), per-op refusals, and config paths that
 * refuse prototype keys (a model-supplied path must not reach `Object.prototype`).
 *
 * Sabotage-witnessed (grade-tests w74): an off-by-one mint, dropping the forward-ref
 * dependency, the ref/head-node collision check, the contradiction check, the RFC 0134
 * valueless-op check or the closed-world typeId check, a missing preimage, an unflagged
 * gate edge, ignoring the validator, a one-sided edge cascade on removeNode, the
 * `__proto__` refusal, or a nested write that drops siblings each reds its case.
 */
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
    if (r.ok) throw new Error('expected a refusal');
    // Each op refused for ITS reason (an index alone could come from another refusal).
    expect([...r.errors].sort((a, b) => a.index - b.index).map((e) => [e.index, e.message])).toEqual([
      [0, "renameNode.nodeId 'zzz' is neither a node in this workflow nor the ref of a node this suggestion adds"],
      [1, "ref 'a' is already used; give each added node a unique ref"],
      [3, 'this op touches a node the same suggestion removes'],
      [4, "setCondition.condition op 'falsy' takes no value (RFC 0134 wire form)"],
      [5, "typeId 'vendor.unknown' is not in this host's node catalog (closed world)"],
    ]);
  });

  it('applies ops into a candidate the caller validates; a failing validator fails the whole set', () => {
    const r = normalizeEditOps({ suggestionId: 's2', head, rawOps: [{ kind: 'addEdge', source: 'g', target: 'a' }], validate: () => ({ ok: false, errors: ['cycle_detected'] }), isKnownTypeId: () => true });
    expect(r).toEqual({ ok: false, errors: [{ index: -1, message: 'cycle_detected' }] });
    const applied = applyEditOps(head, [{ kind: 'removeNode', nodeId: 'b' }]);
    expect(applied.nodes.map((n) => n.nodeId)).toEqual(['a', 'g']);
    expect(applied.edges).toEqual([]);
  });

  it('config paths refuse prototype keys and round-trip nested writes', () => {
    // `toEqual({})` alone cannot see a polluted prototype: assert the prototype itself.
    const polluted = writeConfigPath({}, '__proto__.x', 1);
    expect(Object.getPrototypeOf(polluted)).toBe(Object.prototype);
    expect((polluted as { x?: unknown }).x).toBeUndefined();
    expect(Object.keys(polluted)).toEqual([]);
    expect(readConfigPath({ a: 1 }, 'constructor')).toEqual({ present: false });
    const w = writeConfigPath({ retry: { maxAttempts: 1, backoffMs: 5 } }, 'retry.maxAttempts', 3);
    expect(w).toEqual({ retry: { maxAttempts: 3, backoffMs: 5 } });
    expect(readConfigPath(w, 'retry.backoffMs')).toEqual({ present: true, value: 5 });
  });
});
