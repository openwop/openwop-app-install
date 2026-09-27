/**
 * §7 canvas convergence — Phase 3 builder behaviors:
 * - CV-17: applyRunEvent folds per-node drawer detail (payload sticks from
 *   terminal events; transition timestamps update).
 * - CV-2: the extracted node clipboard verbs drive the store (registry-run).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useBuilderStore } from '../store/builderStore.js';
import { copySelection, pasteClipboard, duplicateSelection, hasClipboard, clearClipboardForTest } from '../nodeClipboard.js';

const st = () => useBuilderStore.getState();

function seedNode(id: string, x = 0, y = 0): void {
  useBuilderStore.setState((s) => ({
    nodes: [...s.nodes, { id, kind: 'transform', name: `n-${id}`, position: { x, y }, config: {} }],
  }));
}

beforeEach(() => {
  useBuilderStore.setState({ nodes: [], edges: [], selectedNodeIds: [], selectedNodeId: null, past: [], future: [], overlay: null });
  clearClipboardForTest();
});

describe('CV-17 — run-drawer detail fold', () => {
  const ev = (type: string, nodeId?: string, payload?: unknown) => ({
    eventId: 'e1', runId: 'r1', type, timestamp: '2026-07-12T20:00:00Z', sequence: 1, payload, schemaVersion: 3,
    ...(nodeId ? { nodeId } : {}),
  });

  it('captures status + timestamp per node; payload sticks from terminal events', () => {
    st().startOverlay('r1', { b1: 'n1' });
    st().applyRunEvent(ev('node.started', 'b1'));
    expect(st().overlay?.nodeDetail['n1']).toMatchObject({ status: 'running', at: '2026-07-12T20:00:00Z' });
    expect(st().overlay?.nodeDetail['n1']?.payload).toBeUndefined();
    st().applyRunEvent(ev('node.completed', 'b1', { out: 42 }));
    expect(st().overlay?.nodeDetail['n1']).toMatchObject({ status: 'completed', payload: { out: 42 } });
    // A later non-terminal transition keeps the terminal payload.
    st().applyRunEvent(ev('node.started', 'b1'));
    expect(st().overlay?.nodeDetail['n1']?.payload).toEqual({ out: 42 });
  });

  it('canvas nodeStatus stays in lockstep (paint path untouched)', () => {
    st().startOverlay('r1', { b1: 'n1' });
    st().applyRunEvent(ev('node.failed', 'b1', { error: 'boom' }));
    expect(st().overlay?.nodeStatus['n1']).toBe('failed');
    expect(st().overlay?.nodeDetail['n1']?.payload).toEqual({ error: 'boom' });
  });
});

describe('CV-2 — registry-driven node clipboard', () => {
  it('copy → paste reconstructs relative layout near the primary node', () => {
    seedNode('a', 100, 100);
    seedNode('b', 180, 140);
    useBuilderStore.setState({ selectedNodeIds: ['a', 'b'], selectedNodeId: 'a' });
    expect(copySelection()).toBe(2);
    expect(hasClipboard()).toBe(true);
    const before = st().nodes.length;
    expect(pasteClipboard()).toBe(2);
    const nodes = st().nodes;
    expect(nodes.length).toBe(before + 2);
    // Relative offset (80, 40) preserved between the pasted pair.
    const pasted = nodes.slice(-2);
    expect(pasted[1]!.position.x - pasted[0]!.position.x).toBe(80);
    expect(pasted[1]!.position.y - pasted[0]!.position.y).toBe(40);
  });

  it('copy/paste/duplicate no-op safely on empty selection/clipboard', () => {
    expect(copySelection()).toBe(0);
    expect(pasteClipboard()).toBe(0);
    expect(duplicateSelection()).toBe(0);
  });

  it('duplicate clones the selection', () => {
    seedNode('a', 0, 0);
    useBuilderStore.setState({ selectedNodeIds: ['a'], selectedNodeId: 'a' });
    expect(duplicateSelection()).toBe(1);
    expect(st().nodes.length).toBe(2);
  });
});
