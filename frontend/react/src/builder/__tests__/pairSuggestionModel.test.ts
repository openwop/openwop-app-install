/**
 * ADR 0773 D5 — the per-op keep contract, against the LIVE canvas:
 *   - a pending op whose preimage still holds applies; one a peer's edit moved
 *     is `stale` even though other ops still apply (per-op, never "the whole
 *     revision moved");
 *   - an op that needs a DROPPED addNode is `inapplicable`, never a dangling edge;
 *   - keeping an op keeps its pending dependencies first;
 *   - auto-keep never takes a structural or gate-sensitive op.
 */
import { describe, expect, it } from 'vitest';
import type { BuilderEdge, BuilderNode } from '../schema/workflow.js';
import {
  applyEditOpsToGraph, autoKeepable, keepOrder, liveOpStatuses, projectGhosts,
  type WorkflowEditSuggestion,
} from '../pair/suggestionModel.js';

const nodes: BuilderNode[] = [
  { id: 'a', kind: 'noop', name: 'Score lead', position: { x: 0, y: 0 }, config: { threshold: 40 } },
  { id: 'b', kind: 'noop', name: 'Write to CRM', position: { x: 0, y: 140 }, config: {} },
];
const edges: BuilderEdge[] = [{ id: 'ab', source: 'a', sourcePort: 'out', target: 'b', targetPort: 'in' }];

const suggestion: WorkflowEditSuggestion = {
  id: 's1', workflowId: 'wf', conversationId: 'c', requestedBy: 'u', baseRevision: 'r', summary: '',
  visibility: 'private', createdAt: '', updatedAt: '',
  opState: ['pending', 'pending', 'pending', 'pending'],
  ops: [
    { op: { kind: 'addNode', nodeId: 'sg_s1_1', typeId: 'core.noop', name: 'Nurture' }, dependsOn: [], preimages: [{ path: 'nodes.sg_s1_1', present: false }], gateSensitive: false, summary: 'Add Nurture' },
    { op: { kind: 'addEdge', edgeId: 'sge_s1_2', sourceNodeId: 'a', targetNodeId: 'sg_s1_1' }, dependsOn: [0], preimages: [{ path: 'nodes.a', present: true, value: { exists: true } }], gateSensitive: false, summary: 'Connect' },
    { op: { kind: 'setConfig', nodeId: 'a', path: 'threshold', value: 50 }, dependsOn: [], preimages: [{ path: 'nodes.a.config.threshold', present: true, value: 40 }], gateSensitive: false, summary: 'threshold' },
    { op: { kind: 'setCondition', edgeId: 'ab', condition: { path: 'ok', op: 'truthy' } }, dependsOn: [], preimages: [{ path: 'edges.ab.condition', present: false }], gateSensitive: true, summary: 'gate edge' },
  ],
};

describe('ADR 0773 D5 — per-op live status', () => {
  it('all pending when the canvas still holds every preimage', () => {
    expect(liveOpStatuses(suggestion, { nodes, edges })).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('a peer edit to ONE touched path makes only that op stale', () => {
    const moved = nodes.map((n) => (n.id === 'a' ? { ...n, config: { threshold: 45 } } : n));
    expect(liveOpStatuses(suggestion, { nodes: moved, edges })).toEqual(['pending', 'pending', 'stale', 'pending']);
  });

  it('an op needing a DROPPED node is inapplicable, not a dangling edge', () => {
    expect(liveOpStatuses(suggestion, { nodes, edges }, ['dropped', 'pending', 'pending', 'pending'])[1]).toBe('inapplicable');
  });
});

describe('ADR 0773 D5 — keep applies dependencies first, as one graph change', () => {
  it('keeping the edge alone pulls in the node it needs, in order', () => {
    expect(keepOrder(suggestion, [1], suggestion.opState)).toEqual([0, 1]);
  });

  it('applies ops to the builder graph with minted ids and resolved ports', () => {
    const out = applyEditOpsToGraph({ nodes, edges }, [suggestion.ops[0]!.op, suggestion.ops[1]!.op, suggestion.ops[2]!.op]);
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b', 'sg_s1_1']);
    expect(out.nodes.find((n) => n.id === 'a')?.config).toEqual({ threshold: 50 });
    const e = out.edges.find((x) => x.id === 'sge_s1_2');
    expect(e && { source: e.source, target: e.target }).toEqual({ source: 'a', target: 'sg_s1_1' });
  });

  it('projects ghosts for pending ops only', () => {
    const g = projectGhosts(suggestion, { nodes, edges }, ['kept', 'pending', 'pending', 'pending']);
    expect(g.ghostNodes).toHaveLength(0);
    expect(g.ghostEdges.map((x) => x.id)).toEqual(['sge_s1_2']);
    expect(g.marksByNode.get('a')).toEqual([2]);
    expect(g.changedEdgeIds.get('ab')).toBe(3);
  });
});

describe('ADR 0773 D5 — auto-keep is narrow by construction', () => {
  it('takes only config/rename ops on the selection that are not gate-sensitive and have no dependencies', () => {
    const statuses = liveOpStatuses(suggestion, { nodes, edges });
    expect(autoKeepable(suggestion, statuses, ['a'])).toEqual([2]);
    expect(autoKeepable(suggestion, statuses, [])).toEqual([]);
  });
});

describe('ADR 0773 review fixes', () => {
  it('CR-5: an edit to a node the suggestion ADDS is pending, not stale, while its add is pending', () => {
    const s: WorkflowEditSuggestion = {
      ...suggestion,
      opState: ['pending', 'pending'],
      ops: [
        suggestion.ops[0]!,
        { op: { kind: 'setConfig', nodeId: 'sg_s1_1', path: 'ms', value: 5 }, dependsOn: [0], preimages: [{ path: 'nodes.sg_s1_1.config.ms', present: false }], gateSensitive: false, summary: 'delay' },
      ],
    };
    expect(liveOpStatuses(s, { nodes, edges })).toEqual(['pending', 'pending']);
    const out = applyEditOpsToGraph({ nodes, edges }, [s.ops[0]!.op, s.ops[1]!.op]);
    expect(out.applied).toEqual([true, true]);
    expect(out.nodes.find((n) => n.id === 'sg_s1_1')?.config).toMatchObject({ ms: 5 });
  });

  it('CR-7: an op the builder cannot apply is reported, not silently kept; an unknown port falls back to a real one', () => {
    const out = applyEditOpsToGraph({ nodes, edges }, [
      { kind: 'addNode', nodeId: 'sg_x_1', typeId: 'vendor.not.in.this.catalog' },
      { kind: 'addEdge', edgeId: 'sge_x_2', sourceNodeId: 'a', targetNodeId: 'sg_x_1' },
      { kind: 'addEdge', edgeId: 'sge_x_3', sourceNodeId: 'a', targetNodeId: 'b', sourceOutput: 'no-such-port' },
    ]);
    expect(out.applied).toEqual([false, false, true]);
    const e = out.edges.find((x) => x.id === 'sge_x_3');
    expect(e?.sourcePort).not.toBe('no-such-port');
  });
});
