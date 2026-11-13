/**
 * ADR 1058 / RFC 0258 §A/§B — admission of a declared loopback edge, and the
 * byte-identity of every interrupt key at visit 0.
 *
 * Admission runs through `validateWorkflowDefinition`, the one ingest every
 * authoring lane (register, from-chain, builder autosave) passes. The flag-off
 * leg is the wire-honesty half: an unadvertised `loopback` is refused with
 * `capability_required`, never dropped (dropping it leaves a plain cycle the
 * author did not ask for) and never run as a plain cycle.
 *
 * The key legs pin the exact strings stored runs carry, so a change to the
 * derivation that moved visit 0 goes red here before it strands a replay.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { buildGraph } from '../src/executor/scheduler.js';
import { interruptRequestKey, buildInterruptRequestedPayload } from '../src/executor/interruptRequestedPayload.js';
import { LoopbackVisits, nodeResumeKey, qualifyResumeKey, planLoopbacks } from '../src/executor/loopback.js';
import { loopbackInterruptData, snapshotFromEventPrefix } from '../src/executor/executor.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const node = (nodeId: string, typeId = 'core.noop') => ({ nodeId, typeId, config: {} });
const gate = { nodeId: 'gate', typeId: 'core.approvalGate', config: { actions: ['accept', 'reject', 'refine'] } };
const LOOP = { on: 'refine', maxIterations: 3 };
function wf(edges: unknown[], extra: unknown[] = []): unknown {
  return { workflowId: 'wf.adr1058.admit', nodes: [node('start'), node('draft'), gate, node('apply'), ...extra], edges };
}
const base = [
  { id: 's-d', sourceNodeId: 'start', targetNodeId: 'draft' },
  { id: 'd-g', sourceNodeId: 'draft', targetNodeId: 'gate' },
  { id: 'g-a', sourceNodeId: 'gate', targetNodeId: 'apply' },
];
function refusal(raw: unknown): { code?: string; details?: Record<string, unknown> } {
  try { validateWorkflowDefinition(raw); } catch (err) { return err as { code?: string; details?: Record<string, unknown> }; }
  throw new Error('expected a refusal');
}

describe('RFC 0258 §B — admission (flag on)', () => {
  beforeEach(() => { process.env.OPENWOP_BOUNDED_LOOPBACK = 'true'; });
  afterEach(() => { delete process.env.OPENWOP_BOUNDED_LOOPBACK; });

  it('admits a loopback to an ancestor, keeps it on the edge, and excludes it from the forward graph', () => {
    const def = validateWorkflowDefinition(wf([...base, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback: LOOP }]));
    expect(def.edges?.find((e) => e.edgeId === 'again')?.loopback).toEqual({ on: 'refine', maxIterations: 3 });
    const plan = planLoopbacks(def);
    expect(plan.get('gate')?.nodes).toEqual(['draft', 'gate']);
    const g = buildGraph(def);
    expect((g.incoming.get('draft') ?? []).map((e) => e.sourceNodeId)).toEqual(['start']);
    // §E.1: a gate whose only other edge is forward keeps it; the loopback is not counted.
    expect((g.outgoing.get('gate') ?? []).map((e) => e.targetNodeId)).toEqual(['apply']);
  });

  it.each([
    ['maxIterations missing (no unlimited)', { on: 'refine' }, 'validation_error'],
    ['maxIterations 0', { on: 'refine', maxIterations: 0 }, 'validation_error'],
    ['maxIterations above the host ceiling', { on: 'refine', maxIterations: 11 }, 'validation_error'],
    ['on other than refine', { on: 'reject', maxIterations: 2 }, 'validation_error'],
    ['an unknown loopback key', { on: 'refine', maxIterations: 2, forever: true }, 'validation_error'],
  ])('refuses %s', (_label, loopback, code) => {
    expect(refusal(wf([...base, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback }])).code).toBe(code);
  });

  it('refuses a loopback edge that also carries a condition (§A)', () => {
    const e = refusal(wf([...base, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback: LOOP, condition: { type: 'truthy', left: 'x' } }]));
    expect(e.code).toBe('validation_error');
  });

  it('refuses a target that is not an ancestor of the gate (§B.2)', () => {
    const e = refusal(wf([...base, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'apply', loopback: LOOP }]));
    expect(e.details?.['reason']).toBe('loopback_not_ancestor');
  });

  it('refuses an open region: a region node with an edge leaving it (§B.3)', () => {
    const e = refusal(wf([...base, { id: 'd-n', sourceNodeId: 'draft', targetNodeId: 'notify' }, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback: LOOP }], [node('notify')]));
    expect(e.details?.['reason']).toBe('loopback_region_open');
  });

  it('refuses two loopback edges from one gate (§B.4)', () => {
    const e = refusal(wf([...base, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback: LOOP }, { id: 'again2', sourceNodeId: 'gate', targetNodeId: 'start', loopback: LOOP }]));
    expect(e.details?.['reason']).toBe('loopback_overlap');
  });
});

describe('RFC 0258 §B — a host that does not run loopbacks refuses the field (flag off)', () => {
  it('capability_required, not dropped', () => {
    delete process.env.OPENWOP_BOUNDED_LOOPBACK;
    const e = refusal(wf([...base, { id: 'again', sourceNodeId: 'gate', targetNodeId: 'draft', loopback: LOOP }]));
    expect(e.code).toBe('capability_required');
    expect(e.details?.['requiredCapability']).toBe('loopback');
  });
});

describe('ADR 1058 D1 — interrupt keys: visit 0 is byte-identical, later visits differ', () => {
  it('pins the stored key forms', () => {
    expect(interruptRequestKey('r1', 'gate', { prompt: 'x' })).toBe('r1:gate:0');
    expect(interruptRequestKey('r1', 'gate', { __resumeKey: 'gate' })).toBe('r1:gate:gate');
    expect(interruptRequestKey('r1', 'gate', { prompt: 'x' }, 2)).toBe('r1:gate:2');
    expect(interruptRequestKey('r1', 'gate', { __resumeKey: qualifyResumeKey('gate', 1) })).toBe('r1:gate:gate#v1');
    const p = buildInterruptRequestedPayload({ runId: 'r1', nodeId: 'gate', kind: 'approval', data: { prompt: 'x', actions: ['approve', 'reject'] } });
    expect(p.key).toBe('r1:gate:0');
  });

  it('qualifies only past visit 0, and serves a seeded key only to its own visit', () => {
    expect(qualifyResumeKey('q', 0)).toBe('q');
    expect(qualifyResumeKey('q', 3)).toBe('q#v3');
    expect(nodeResumeKey('q', 0)).toBe('q');
    expect(nodeResumeKey('q#v2', 2)).toBe('q');
    expect(nodeResumeKey('q#v1', 2)).toBeUndefined();
    expect(nodeResumeKey('q', 1)).toBeUndefined();
  });

  it('folds visits and rounds from markers only', () => {
    const v = LoopbackVisits.fold([
      { type: 'node.completed', nodeId: 'draft', payload: { nodeId: 'draft', outputs: {} } },
      { type: 'node.failed', nodeId: 'draft', payload: { nodeId: 'draft' } },
      { type: 'node.completed', nodeId: 'gate', payload: { nodeId: 'gate', 'openwop-loopback': { edgeId: 'again', targetNodeId: 'draft', round: 1, rearmed: ['draft', 'gate'] } } },
    ]);
    expect([v.visitOf('draft'), v.visitOf('gate'), v.visitOf('apply'), v.roundsTaken('again')]).toEqual([1, 1, 0, 1]);
  });

  it('withdraws refine on an exhausted withdraw visit, keeps it under fail', () => {
    const region = (onExhausted?: 'withdraw' | 'fail') => ({ edge: { edgeId: 'again', loopback: { maxIterations: 1, ...(onExhausted ? { onExhausted } : {}) } } });
    const spent = { roundsTaken: () => 1 };
    const data = { actions: ['accept', 'reject', 'refine'] };
    expect(loopbackInterruptData(data, 1, region(), spent)).toMatchObject({ actions: ['accept', 'reject'], loopback: { round: 1, maxIterations: 1, exhausted: true } });
    expect(loopbackInterruptData(data, 1, region('fail'), spent)).toMatchObject({ actions: ['accept', 'reject', 'refine'] });
    expect(loopbackInterruptData({ actions: ['refine'] }, 1, region(), spent)).toMatchObject({ actions: ['refine'] });
  });
});

describe('RFC 0258 §C.6 — the fold re-arms the region from the marker', () => {
  it('a prefix ending after a marked completion restores the region as unsettled', () => {
    const snap = snapshotFromEventPrefix([
      { type: 'node.started', nodeId: 'draft', payload: {} },
      { type: 'node.completed', nodeId: 'draft', payload: { outputs: { draft: 'd1' } } },
      { type: 'node.started', nodeId: 'gate', payload: {} },
      { type: 'node.suspended', nodeId: 'gate', payload: { kind: 'approval' } },
      { type: 'node.completed', nodeId: 'gate', payload: { outputs: {}, loopback: { edgeId: 'again', targetNodeId: 'draft', round: 1, rearmed: ['draft', 'gate'] } } },
    ]);
    expect(snap.nodeState).toEqual([]);
    expect(snap.suspendedKinds).toBeUndefined();
  });

  it('without a marker the same prefix restores the gate completed (unchanged)', () => {
    const snap = snapshotFromEventPrefix([
      { type: 'node.started', nodeId: 'gate', payload: {} },
      { type: 'node.completed', nodeId: 'gate', payload: { outputs: {} } },
    ]);
    expect(snap.nodeState).toEqual([['gate', 'completed']]);
  });

  it('planLoopbacks is empty for a definition with no loopback edge', () => {
    process.env.OPENWOP_BOUNDED_LOOPBACK = 'true';
    try {
      expect(planLoopbacks(validateWorkflowDefinition(wf(base)) as WorkflowDefinition).size).toBe(0);
    } finally { delete process.env.OPENWOP_BOUNDED_LOOPBACK; }
  });
});
