/**
 * BLD-1 (CODEBASE-ASSESSMENT.md): the builder's zustand store carries the
 * undo/redo stack, edge dedup/self-loop rejection, and cascade-delete — all
 * safety-critical and previously untested.
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

describe('builderStore — nodes', () => {
  it('addNode appends a node and returns its id', () => {
    const id = s().addNode('noop', { x: 10, y: 20 });
    expect(typeof id).toBe('string');
    expect(s().nodes).toHaveLength(1);
    expect(s().nodes[0]!.id).toBe(id);
  });

  it('removeNode drops the node AND its incident edges', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    expect(s().edges).toHaveLength(1);
    s().removeNode(a);
    expect(s().nodes).toHaveLength(1);
    expect(s().edges).toHaveLength(0); // incident edge cascaded away
  });
});

describe('builderStore — edges', () => {
  it('rejects a self-loop', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: a, targetPort: 'in' });
    expect(s().edges).toHaveLength(0);
  });

  it('rejects a duplicate edge between the same ports', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    expect(s().edges).toHaveLength(1);
  });
});

describe('builderStore — undo/redo', () => {
  it('undo reverses the last mutation; redo re-applies it', () => {
    s().addNode('noop', { x: 0, y: 0 });
    expect(s().nodes).toHaveLength(1);
    s().addNode('uppercase', { x: 100, y: 0 });
    expect(s().nodes).toHaveLength(2);
    s().undo();
    expect(s().nodes).toHaveLength(1);
    s().redo();
    expect(s().nodes).toHaveLength(2);
  });

  it('a new mutation after undo clears the redo (future) stack', () => {
    s().addNode('noop', { x: 0, y: 0 });
    s().addNode('uppercase', { x: 100, y: 0 });
    s().undo(); // back to 1 node, future has the 2-node state
    s().addNode('delay', { x: 200, y: 0 }); // new branch
    expect(s().nodes).toHaveLength(2);
    s().redo(); // nothing to redo — future was cleared
    expect(s().nodes).toHaveLength(2);
  });

  it('group remove + undo restores nodes and edges in one step', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const b = s().addNode('uppercase', { x: 100, y: 0 });
    s().addEdge({ source: a, sourcePort: 'out', target: b, targetPort: 'in' });
    s().removeNodes([a, b]); // one undo entry
    expect(s().nodes).toHaveLength(0);
    expect(s().edges).toHaveLength(0);
    s().undo();
    expect(s().nodes).toHaveLength(2);
    expect(s().edges).toHaveLength(1);
  });
});
