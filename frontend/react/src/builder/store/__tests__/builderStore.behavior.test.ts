/**
 * BLD-1 (grade-code gap): additional builderStore coverage beyond
 * builderStore.test.ts — exercises moveNodes, multi-select (setSelection /
 * selectEdge), group clone, alignNodes, edge add/update/remove, and the
 * ephemeral run-overlay reducer. Drives the zustand store directly via
 * `.getState()` (stores expose getState outside React).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useBuilderStore } from '../builderStore.js';
import type { SavedWorkflow } from '../../schema/workflow.js';

const emptyWf: SavedWorkflow = {
  id: 'wf-test', name: 'Test', version: '1.0.0', nodes: [], edges: [], createdAt: 'now', updatedAt: 'now',
};
const s = () => useBuilderStore.getState();

beforeEach(() => {
  s().loadFromSaved(emptyWf);
});

describe('builderStore — moveNodes', () => {
  it('commits final positions for several nodes in one undo entry', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().moveNodes([
      { id: a, position: { x: 5, y: 5 } },
      { id: b, position: { x: 200, y: 50 } },
    ]);
    const byId = new Map(s().nodes.map((n) => [n.id, n.position]));
    expect(byId.get(a)).toEqual({ x: 5, y: 5 });
    expect(byId.get(b)).toEqual({ x: 200, y: 50 });
    // One undo reverts the whole move.
    s().undo();
    const after = new Map(s().nodes.map((n) => [n.id, n.position]));
    expect(after.get(a)).toEqual({ x: 0, y: 0 });
    expect(after.get(b)).toEqual({ x: 100, y: 0 });
  });

  it('is a no-op (no history push) for an empty move list', () => {
    s().addNode('noop', { x: 0, y: 0 });
    const pastLen = s().past.length;
    s().moveNodes([]);
    expect(s().past.length).toBe(pastLen);
  });
});

describe('builderStore — selection', () => {
  it('setSelection with one id sets the primary selectedNodeId', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().setSelection([a, b]);
    expect(s().selectedNodeIds).toEqual([a, b]);
    expect(s().selectedNodeId).toBeNull(); // multi-select → no single primary
    s().setSelection([a]);
    expect(s().selectedNodeId).toBe(a);
  });

  it('selectEdge clears node selection and vice versa', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    const edgeId = s().edges[0]!.id;
    s().selectEdge(edgeId);
    expect(s().selectedEdgeId).toBe(edgeId);
    expect(s().selectedNodeId).toBeNull();
    expect(s().selectedNodeIds).toEqual([]);
    s().selectNode(a);
    expect(s().selectedEdgeId).toBeNull();
    expect(s().selectedNodeId).toBe(a);
  });
});

describe('builderStore — group clone', () => {
  it('cloneNodes duplicates the selected nodes at an offset and selects the clones', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().cloneNodes([a, b]);
    expect(s().nodes).toHaveLength(4);
    // The new selection is exactly the two clones (not the sources).
    expect(s().selectedNodeIds).toHaveLength(2);
    expect(s().selectedNodeIds).not.toContain(a);
    expect(s().selectedNodeIds).not.toContain(b);
    // One undo removes both clones.
    s().undo();
    expect(s().nodes).toHaveLength(2);
  });

  it('cloneNodes on an empty selection is a no-op', () => {
    s().addNode('noop', { x: 0, y: 0 });
    const pastLen = s().past.length;
    s().cloneNodes([]);
    expect(s().nodes).toHaveLength(1);
    expect(s().past.length).toBe(pastLen);
  });
});

describe('builderStore — alignNodes', () => {
  it('aligns left edges to the minimum x', () => {
    const a = s().addNode('noop', { x: 10, y: 0 });
    const b = s().addNode('uppercase', { x: 80, y: 40 });
    const c = s().addNode('delay', { x: 200, y: 90 });
    s().alignNodes([a, b, c], 'left');
    const xs = s().nodes.map((n) => n.position.x);
    expect(new Set(xs)).toEqual(new Set([10]));
    // y untouched.
    const byId = new Map(s().nodes.map((n) => [n.id, n.position.y]));
    expect(byId.get(b)).toBe(40);
  });

  it('distribute-h evenly spaces nodes by x between the extremes', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 30, y: 0 });
    const c = s().addNode('delay', { x: 120, y: 0 });
    s().alignNodes([a, b, c], 'distribute-h');
    const byId = new Map(s().nodes.map((n) => [n.id, n.position.x]));
    expect(byId.get(a)).toBe(0);
    expect(byId.get(b)).toBe(60); // midpoint of 0..120
    expect(byId.get(c)).toBe(120);
  });

  it('does nothing with fewer than two nodes', () => {
    const a = s().addNode('noop', { x: 10, y: 10 });
    const pastLen = s().past.length;
    s().alignNodes([a], 'left');
    expect(s().past.length).toBe(pastLen);
  });
});

describe('builderStore — edges', () => {
  it('addEdge assigns an id; updateEdge patches a label; removeEdge drops it', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    const e = s().edges[0]!;
    expect(e.id).toMatch(/^e_/);
    s().updateEdge(e.id, { label: 'go' });
    expect(s().edges[0]!.label).toBe('go');
    s().removeEdge(e.id);
    expect(s().edges).toHaveLength(0);
  });

  it('removeEdge clears the selection if the removed edge was selected', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    const id = s().edges[0]!.id;
    s().selectEdge(id);
    s().removeEdge(id);
    expect(s().selectedEdgeId).toBeNull();
  });
});

describe('builderStore — run overlay', () => {
  it('startOverlay then applyRunEvent paints per-node + run status; ignores foreign runIds', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    s().startOverlay('run-1', { be_a: a });
    expect(s().overlay?.runId).toBe('run-1');
    expect(s().overlay?.runStatus).toBe('running');

    // node.started → 'running' on the mapped builder node.
    s().applyRunEvent({ runId: 'run-1', type: 'node.started', nodeId: 'be_a' } as never);
    expect(s().overlay?.nodeStatus[a]).toBe('running');
    s().applyRunEvent({ runId: 'run-1', type: 'node.completed', nodeId: 'be_a' } as never);
    expect(s().overlay?.nodeStatus[a]).toBe('completed');

    // run.completed updates the banner status.
    s().applyRunEvent({ runId: 'run-1', type: 'run.completed' } as never);
    expect(s().overlay?.runStatus).toBe('completed');

    // An event for a different run is ignored.
    s().applyRunEvent({ runId: 'other', type: 'run.failed' } as never);
    expect(s().overlay?.runStatus).toBe('completed');
  });

  it('clearOverlay removes the overlay entirely', () => {
    s().startOverlay('run-1', {});
    s().clearOverlay();
    expect(s().overlay).toBeNull();
  });

  it('overlay is not affected by undo (ephemeral, never snapshotted)', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    s().startOverlay('run-1', { be_a: a });
    s().addNode('uppercase', { x: 100, y: 0 });
    s().undo();
    // The graph reverted but the overlay survives.
    expect(s().nodes).toHaveLength(1);
    expect(s().overlay?.runId).toBe('run-1');
  });
});
