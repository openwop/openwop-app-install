/**
 * RFC 0125 — chain-pack `FragmentEdge.triggerRule` expansion carry-through.
 *
 * The spec-normative requirement (RFC 0125 §"Expansion semantics" step 6, edge-field
 * preservation): expansion MUST carry a fragment edge's `triggerRule` VERBATIM onto the
 * resulting `WorkflowEdge`, exactly as `condition` is carried — else the scheduler never
 * honors it and the field is silently a no-op. This is the host-side realization of that
 * MUST, on the same edge-map seam as `condition` (`workflowChainPackLoader.ts`).
 *
 * These are pure-expansion unit assertions: they build a `WorkflowChain` in memory and
 * call `expandChain` directly, so they do NOT depend on the vendored manifest schema
 * carrying `triggerRule` yet (that lands when the upstream RFC 0125 schema PR syncs). The
 * expanded graph is still validated by the shared `validateWorkflowDefinition`, whose
 * `WorkflowEdge.triggerRule` support predates this RFC.
 */

import { describe, expect, it } from 'vitest';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';

/** A minimal two-node chain: a trigger → a terminal, joined by one edge whose
 *  `triggerRule` we vary. typeIds only need to match the id pattern to validate. */
function chainWithEdge(edge: { from: string; to: string; triggerRule?: string }): WorkflowChain {
  return {
    chainId: 'test.triggerrule',
    version: '1.0.0',
    label: 'triggerRule carry test',
    description: 'Fixture exercising RFC 0125 FragmentEdge.triggerRule expansion.',
    parameters: {},
    dag: {
      nodes: [
        { id: 'start', typeId: 'core.trigger.event' },
        { id: 'done', typeId: 'core.flow.noop' },
      ],
      edges: [edge],
    },
  } as unknown as WorkflowChain;
}

describe('RFC 0125 — FragmentEdge.triggerRule expansion carry-through', () => {
  it('carries an explicit triggerRule verbatim onto the expanded WorkflowEdge', () => {
    const def = expandChain(chainWithEdge({ from: 'start', to: 'done', triggerRule: 'all_complete' }));
    expect(def.edges!).toHaveLength(1);
    // The MUST: the value survives expansion unchanged.
    expect(def.edges![0]!.triggerRule).toBe('all_complete');
  });

  it('preserves each of the five fan-in rules', () => {
    for (const rule of ['all_success', 'any_success', 'all_complete', 'none_failed', 'any_failed'] as const) {
      const def = expandChain(chainWithEdge({ from: 'start', to: 'done', triggerRule: rule }));
      expect(def.edges![0]!.triggerRule).toBe(rule);
    }
  });

  it('omits triggerRule when the fragment edge does not declare it (default = all_success behavior)', () => {
    const def = expandChain(chainWithEdge({ from: 'start', to: 'done' }));
    expect(def.edges!).toHaveLength(1);
    // Absent ⇒ not stamped; the executor treats a missing triggerRule as all_success,
    // so the expanded edge is byte-identical to today's output. No spurious default.
    expect(def.edges![0]!.triggerRule).toBeUndefined();
  });
});
