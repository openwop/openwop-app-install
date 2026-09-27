/**
 * ADR 0483 — the B5 canvas performance budget (200-node ratchet).
 *
 * "An audit is a snapshot, a test is a ratchet": the two disciplines that
 * keep a 200-node canvas responsive already exist — this suite PINS them so
 * a refactor can't silently regress the one failure mode the competitive
 * assessment left untested (B5, "scale cliffs").
 *
 *  1. IDENTITY STABILITY — single-node store mutations preserve every other
 *     node's object identity (deterministic reference assertions — zero
 *     timing flake). HONESTY (review F1): this pins the STORE half of the
 *     render discipline. BuilderCanvas's rfNodes useMemo currently re-mints
 *     every node's `data` object per edit, so the end-to-end O(1) render is
 *     NOT yet harvested — the per-node data-mapping memoization is the
 *     recorded ADR 0483 follow-on this pin makes possible.
 *  2. MEMOIZATION — BaseNode stays a memo component.
 *  3. OP CEILINGS — serialize / snapshot / single-node update on a
 *     200-node/300-edge graph stay under DELIBERATELY GENEROUS absolute
 *     ceilings (≥10× local headroom, absorbing CI variance): the ratchet
 *     catches accidental O(n²) regressions, not millisecond drift.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useBuilderStore } from '../store/builderStore.js';
import type { BuilderNode, BuilderEdge } from '../schema/workflow.js';
import { serializeWithIdMap } from '../schema/serialize.js';
import { BaseNode } from '../canvas/nodes/BaseNode.js';
import { CANVAS_NODE_BUDGET } from '../perfBudget.js';

export const CANVAS_PERF_BUDGET = {
  nodes: CANVAS_NODE_BUDGET,
  edges: 300,
  /** ms — full definition serialization of the 200-node graph. */
  serializeMs: 250,
  /** ms — one single-node update (includes the history snapshot push). */
  updateMs: 120,
  /** ms — 20 consecutive single-node updates (amortized history churn). */
  update20Ms: 800,
} as const;

function bigGraph(): { nodes: BuilderNode[]; edges: BuilderEdge[] } {
  const nodes: BuilderNode[] = [];
  const edges: BuilderEdge[] = [];
  for (let i = 0; i < CANVAS_PERF_BUDGET.nodes; i += 1) {
    nodes.push({
      id: `n_${i}`,
      kind: 'noop',
      name: `Step ${i}`,
      position: { x: (i % 20) * 180, y: Math.floor(i / 20) * 120 },
      config: { index: i, note: `node ${i}` },
    } as BuilderNode);
  }
  // Acyclic by construction (serialize topo-sorts): a forward chain plus
  // forward skip edges.
  for (let i = 0; i < CANVAS_PERF_BUDGET.edges; i += 1) {
    const from = i < CANVAS_PERF_BUDGET.nodes - 1 ? i : (i - (CANVAS_PERF_BUDGET.nodes - 1)) % (CANVAS_PERF_BUDGET.nodes - 2);
    const to = i < CANVAS_PERF_BUDGET.nodes - 1 ? i + 1 : from + 2;
    edges.push({ id: `e_${i}`, source: `n_${from}`, sourcePort: 'out', target: `n_${to}`, targetPort: 'in' } as BuilderEdge);
  }
  return { nodes, edges };
}

function loadBigGraph(): void {
  const { nodes, edges } = bigGraph();
  useBuilderStore.setState({ nodes, edges, past: [], future: [] });
}

describe('canvas perf budget (ADR 0483 / B5)', () => {
  beforeEach(() => {
    loadBigGraph();
  });

  it('IDENTITY: a single-node update preserves every other node\'s object identity (the memo discipline)', () => {
    const before = useBuilderStore.getState().nodes;
    useBuilderStore.getState().updateNode('n_42', { name: 'renamed' });
    const after = useBuilderStore.getState().nodes;
    let changed = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) changed += 1;
    }
    expect(changed).toBe(1); // exactly the edited node — memo'd peers skip render
    expect(after.find((n) => n.id === 'n_42')?.name).toBe('renamed');
  });

  it('IDENTITY: a multi-move preserves identity for unmoved nodes', () => {
    const before = useBuilderStore.getState().nodes;
    useBuilderStore.getState().moveNodes([
      { id: 'n_1', position: { x: 1, y: 1 } },
      { id: 'n_2', position: { x: 2, y: 2 } },
    ]);
    const after = useBuilderStore.getState().nodes;
    let changed = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) changed += 1;
    }
    expect(changed).toBe(2);
    // Review nit — assert the patch LANDED (a clone-without-applying rewrite
    // must not pass on identity counting alone).
    expect(after.find((n) => n.id === 'n_1')?.position).toEqual({ x: 1, y: 1 });
    expect(after.find((n) => n.id === 'n_2')?.position).toEqual({ x: 2, y: 2 });
  });

  it('MEMO: BaseNode stays a memoized component', () => {
    // React.memo components carry the react.memo symbol — a refactor that
    // unwraps the memo re-renders all 200 nodes per keystroke.
    expect((BaseNode as unknown as { $$typeof?: symbol }).$$typeof?.toString()).toContain('react.memo');
  });

  it(`CEILING: serializing ${CANVAS_PERF_BUDGET.nodes} nodes stays under ${CANVAS_PERF_BUDGET.serializeMs}ms`, () => {
    const snap = useBuilderStore.getState().snapshot();
    const t0 = performance.now();
    serializeWithIdMap(snap);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(CANVAS_PERF_BUDGET.serializeMs);
  });

  it(`CEILING: one single-node update stays under ${CANVAS_PERF_BUDGET.updateMs}ms`, () => {
    const t0 = performance.now();
    useBuilderStore.getState().updateNode('n_7', { name: 'timed' });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(CANVAS_PERF_BUDGET.updateMs);
  });

  it(`CEILING: 20 consecutive updates stay under ${CANVAS_PERF_BUDGET.update20Ms}ms (no O(n²) history churn)`, () => {
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) {
      useBuilderStore.getState().updateNode(`n_${i}`, { position: { x: i, y: i } });
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(CANVAS_PERF_BUDGET.update20Ms);
  });
});
