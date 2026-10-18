/**
 * §7 canvas convergence — Phase 3 builder behaviors:
 * - CV-17: applyRunEvent folds per-node drawer detail (payload sticks from
 *   terminal events; transition timestamps update).
 * - CV-2: the extracted node clipboard verbs drive the store (registry-run).
 *
 * Sabotage that turns it red: dropping the sticky-payload arm or the
 * `node.failed` payload arm, freezing `at` at the first transition, not
 * updating nodeStatus, zeroing a clipboard offset, anchoring paste anywhere but
 * primary + 32px, or dropping cloneNodes. Fixtures are asymmetric (x ≠ y,
 * distinct timestamps) so an axis swap or a frozen value cannot pass.
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
  const T1 = '2026-07-12T20:00:00Z';
  const T2 = '2026-07-12T20:00:05Z';
  const T3 = '2026-07-12T20:00:09Z';
  const ev = (type: string, nodeId?: string, payload?: unknown, timestamp = T1) => ({
    eventId: 'e1', runId: 'r1', type, timestamp, sequence: 1, payload, schemaVersion: 3,
    ...(nodeId ? { nodeId } : {}),
  });

  it('captures status + timestamp per node; payload sticks from terminal events', () => {
    st().startOverlay('r1', { b1: 'n1' });
    st().applyRunEvent(ev('node.started', 'b1', undefined, T1));
    expect(st().overlay?.nodeDetail['n1']).toMatchObject({ status: 'running', at: T1 });
    expect(st().overlay?.nodeDetail['n1']?.payload).toBeUndefined();
    st().applyRunEvent(ev('node.completed', 'b1', { out: 42 }, T2));
    expect(st().overlay?.nodeDetail['n1']).toMatchObject({ status: 'completed', at: T2, payload: { out: 42 } });
    // A later non-terminal transition keeps the terminal payload; `at` moves on.
    st().applyRunEvent(ev('node.started', 'b1', undefined, T3));
    expect(st().overlay?.nodeDetail['n1']).toMatchObject({ status: 'running', at: T3 });
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
    seedNode('a', 100, 60);
    seedNode('b', 180, 100);
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
    // Anchored at the primary node + the 32px paste offset (literal, not imported).
    expect(pasted[0]!.position).toEqual({ x: 132, y: 92 });
    expect(pasted[1]!.position).toEqual({ x: 212, y: 132 });
  });

  it('copy/paste/duplicate no-op safely on empty selection/clipboard', () => {
    // An UNSELECTED node is on the sheet, so an "empty selection means all
    // nodes" regression in copy or duplicate has something to act on. (Pasting
    // an EMPTY clipboard is double-guarded — copy never stores an empty list,
    // and pasteNodes([]) is a no-op — so that arm has no single observable edit.)
    seedNode('a', 10, 20);
    expect(copySelection()).toBe(0);
    expect(hasClipboard()).toBe(false);
    expect(pasteClipboard()).toBe(0);
    expect(duplicateSelection()).toBe(0);
    expect(st().nodes.map((n) => n.id)).toEqual(['a']);
    expect(st().past).toHaveLength(0);
  });

  it('duplicate clones the selection', () => {
    seedNode('a', 0, 0);
    useBuilderStore.setState({ selectedNodeIds: ['a'], selectedNodeId: 'a' });
    expect(duplicateSelection()).toBe(1);
    expect(st().nodes.length).toBe(2);
  });
});
