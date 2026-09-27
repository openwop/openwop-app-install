/**
 * BLD-1 (docs/steward/CODEBASE-ASSESSMENT.md): the builder's zustand store carries the
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

  it('addConnectedNode lands node + edge as ONE undo entry (§7 one gesture, CT-CV-3)', () => {
    const a = s().addNode('noop', { x: 0, y: 0 });
    const id = s().addConnectedNode('uppercase', { x: 200, y: 0 }, { source: a, sourcePort: 'out', targetPort: 'in' });
    expect(s().nodes).toHaveLength(2);
    expect(s().edges).toHaveLength(1);
    expect(s().edges[0]).toMatchObject({ source: a, target: id });
    expect(s().selectedNodeId).toBe(id);
    s().undo(); // a SINGLE undo removes both the node and its pre-wired edge
    expect(s().nodes).toHaveLength(1);
    expect(s().edges).toHaveLength(0);
    s().redo();
    expect(s().nodes).toHaveLength(2);
    expect(s().edges).toHaveLength(1);
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

describe('builderStore — definition metadata carry (ADR 0440 P1)', () => {
  it('holds the loaded metadata so the autosave cannot erase it', () => {
    // The seam that actually broke: backendStore captured metadata correctly,
    // but the store dropped it between load and persist — so the debounced
    // autosave rewrote the definition WITHOUT `walkthrough: true`, silently
    // un-registering the walkthrough from ctx.features.walkthroughs.
    s().loadFromSaved({ ...emptyWf, metadata: { walkthrough: true, showcase: true } });
    expect(s().metadata).toEqual({ walkthrough: true, showcase: true });
  });

  it('leaves metadata undefined for a workflow that has none', () => {
    s().loadFromSaved(emptyWf);
    expect(s().metadata).toBeUndefined();
  });

  it('keeps metadata across an edit (the autosave reads it from the store)', () => {
    s().loadFromSaved({ ...emptyWf, metadata: { walkthrough: true } });
    s().addNode('noop', { x: 0, y: 0 });
    expect(s().metadata).toEqual({ walkthrough: true });
  });
});

describe('builderStore — removed-node disclosure hygiene (ADR 0440 P2, grade-pass)', () => {
  it('clears the disclosure when a DIFFERENT workflow loads', () => {
    useBuilderStore.setState({ removedReferencedNodeIds: ['Fetch the brief'] });
    s().loadFromSaved({ ...emptyWf, id: 'other-wf' });
    // Otherwise the notice follows you and attributes workflow A's removed
    // steps to workflow B.
    expect(s().removedReferencedNodeIds).toEqual([]);
  });

  it('snapshot() carries metadata and lifecycle (the Run path registers from it)', () => {
    // snapshot() is typed SavedWorkflow but omitted both, so pressing Run
    // registered a definition with NO metadata — and the route replaces
    // wholesale, erasing it. That silently undid the P1 fix.
    s().loadFromSaved({ ...emptyWf, metadata: { walkthrough: true }, lifecycle: { transient: true } });
    const snap = s().snapshot();
    expect(snap.metadata).toEqual({ walkthrough: true });
    expect(snap.lifecycle).toEqual({ transient: true });
  });
});
