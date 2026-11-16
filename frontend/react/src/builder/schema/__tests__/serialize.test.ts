/**
 * BLD-1 (docs/steward/CODEBASE-ASSESSMENT.md): the workflow builder's serialize/deserialize
 * layer is the correctness backbone (cycle detection, edge integrity,
 * id-mapping, round-trip) yet was untested. These are pure functions — cheap,
 * high-value coverage.
 *
 * What breaks without it: a cyclic or dangling graph reaching the server as if
 * runnable; edges re-wired to the wrong endpoints; the run overlay painting the
 * wrong node (a wrong builder↔backend id map); a half-typed run-input schema
 * published over a working one; ADR 0440's parallel port edges between two
 * nodes read as a false cycle (or a real cycle hidden by distinct-upstream counting).
 *
 * Sabotage-witnessed (grade-tests w116): an array draft published, the schema
 * dropped, a non-pretty deserialize, an inverted id map, a fallback id off by
 * one, swapped edge endpoints, indegree counted per EDGE, self-loops skipped,
 * condition or trigger rule dropped, the empty-graph message swapped, the cycle
 * naming the wrong node, and the unknown-target check removed each red a case.
 */
import { describe, it, expect } from 'vitest';
import { serializeWithIdMap, serializeWorkflow, SerializeError } from '../serialize.js';
import { looksCanonical, fromCanonicalDefinition } from '../deserialize.js';
import type { BuilderNode, BuilderEdge, SavedWorkflow } from '../workflow.js';

let seq = 0;
function node(kind: string, name = kind): BuilderNode {
  return { id: `n${seq++}`, kind, name, position: { x: 0, y: 0 }, config: {} };
}
function edge(source: string, target: string): BuilderEdge {
  return { id: `e-${source}-${target}`, source, sourcePort: 'out', target, targetPort: 'in' };
}
function wf(nodes: BuilderNode[], edges: BuilderEdge[]): SavedWorkflow {
  return { id: 'wf1', name: 'Test', version: '1.0.0', nodes, edges, createdAt: 'now', updatedAt: 'now' };
}

describe('inputSchema publishing (ADR 0197 / Deferred Phase E.2)', () => {
  it('emits definition.inputSchema only when the draft parses to an object', () => {
    const a = node('noop', 'Start');
    const schema = '{"type":"object","properties":{"city":{"type":"string"}}}';
    const withSchema = serializeWorkflow({ ...wf([a], []), inputSchema: schema });
    expect(withSchema.inputSchema).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
  });

  it('omits a half-typed / non-object draft (never publishes a broken schema)', () => {
    for (const draft of ['{"type":', '[1,2]', '"just a string"', '', '   ']) {
      const out = serializeWorkflow({ ...wf([node('noop')], []), inputSchema: draft });
      expect(out.inputSchema, `draft=${draft}`).toBeUndefined();
    }
  });

  it('round-trips through the canonical deserializer as a pretty JSON string', () => {
    const res = fromCanonicalDefinition({
      workflowId: 'w', nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], edges: [],
      inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    });
    // Pretty-printed (2-space) — the exact text the author sees in the editor.
    expect(res.inputSchema).toBe('{\n  "type": "object",\n  "properties": {\n    "n": {\n      "type": "number"\n    }\n  }\n}');
  });
});

describe('serializeWithIdMap', () => {
  it('serializes a linear workflow + returns a builder→backend id map', () => {
    const a = node('noop', 'Start');
    // A file-imported id the wire cannot carry, so the map is NOT the identity:
    // with only wire-safe ids an inverted map would read back identically.
    const b: BuilderNode = { ...node('uppercase', 'Upper'), id: 'b node!' };
    const res = serializeWithIdMap(wf([a, b], [edge(a.id, b.id)]));
    expect(res.definition.nodes.map((n) => n.nodeId)).toEqual([a.id, 'uppercase_1']);
    expect(res.builderIdToBackend).toEqual({ [a.id]: a.id, 'b node!': 'uppercase_1' });
    expect(res.backendIdToBuilder).toEqual({ [a.id]: a.id, uppercase_1: 'b node!' });
    expect(res.definition.edges.map((e) => [e.sourceNodeId, e.targetNodeId])).toEqual([[a.id, 'uppercase_1']]);
    for (const n of res.definition.nodes) {
      expect(n.nodeId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/); // wire nodeId pattern
    }
  });

  it('serializes a fan-out (one source, two parallel branches)', () => {
    const a = node('noop', 'Start');
    const b = node('uppercase', 'B');
    const c = node('uppercase', 'C');
    const res = serializeWorkflow(wf([a, b, c], [edge(a.id, b.id), edge(a.id, c.id)]));
    expect(res.nodes.map((n) => n.nodeId)).toEqual([a.id, b.id, c.id]);
    expect(res.edges.map((e) => [e.sourceNodeId, e.targetNodeId])).toEqual([[a.id, b.id], [a.id, c.id]]);
  });

  it('preserves multiple port edges between the same nodes without inventing a cycle', () => {
    const a = node('noop', 'Source');
    const b = node('uppercase', 'Consumer');
    const edges: BuilderEdge[] = [
      { ...edge(a.id, b.id), id: 'artifact-edge', sourcePort: 'artifact', targetPort: 'artifact' },
      { ...edge(a.id, b.id), id: 'warning-edge', sourcePort: 'warning', targetPort: 'warning', condition: { path: 'warning', op: 'truthy' }, triggerRule: 'all_complete' },
    ];
    const result = serializeWorkflow(wf([a, b], edges));
    expect(result.nodes.map(n => n.nodeId)).toEqual([a.id, b.id]);
    // Both edges, EXACTLY: ids, ports, and the second edge's condition + trigger
    // rule, with nothing extra (a parallel edge must not be merged or dropped).
    expect(result.edges).toEqual([
      { edgeId: 'artifact-edge', sourceNodeId: a.id, sourceOutput: 'artifact', targetNodeId: b.id, targetInput: 'artifact' },
      { edgeId: 'warning-edge', sourceNodeId: a.id, sourceOutput: 'warning', targetNodeId: b.id, targetInput: 'warning', triggerRule: 'all_complete', condition: { path: 'warning', op: 'truthy' } },
    ]);
    // Distinct-upstream counting must not hide a REAL cycle: a back edge, and a self-loop.
    expect(() => serializeWorkflow(wf([a, b], [...edges, edge(b.id, a.id)]))).toThrow(/cycle/i);
    expect(() => serializeWorkflow(wf([a], [edge(a.id, a.id)]))).toThrow(/cycle/i);
  });

  // DOUBLE GUARD (recorded, grade-tests w47): `serializeWithIdMap` and
  // `serializeExecutable` both refuse an empty graph with the same message, so
  // removing either one alone stays green here. The probe aims at the first
  // guard's MESSAGE instead, which proves this case reaches it, and a w116 probe
  // removes BOTH guards in one edit (an empty definition is then returned).
  it('throws on an empty workflow', () => {
    expect(() => serializeWorkflow(wf([], []))).toThrow(SerializeError);
    expect(() => serializeWorkflow(wf([], []))).toThrow(/no nodes/i);
  });

  it('detects a 2-node cycle and names the offending node', () => {
    const a = node('noop', 'A');
    const b = node('uppercase', 'B');
    let err: unknown;
    try {
      serializeWorkflow(wf([a, b], [edge(a.id, b.id), edge(b.id, a.id)]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SerializeError);
    expect((err as Error).message).toMatch(/cycle/i);
    // Both nodes are on the cycle; the first stuck node in canvas order is `a`.
    expect((err as SerializeError).nodeId).toBe(a.id);
  });

  it('detects a longer cycle (a→b→c→a)', () => {
    const a = node('noop', 'A');
    const b = node('uppercase', 'B');
    const c = node('uppercase', 'C');
    expect(() =>
      serializeWorkflow(wf([a, b, c], [edge(a.id, b.id), edge(b.id, c.id), edge(c.id, a.id)])),
    ).toThrow(/cycle/i);
  });

  it('rejects an edge that references an unknown node', () => {
    const a = node('noop', 'A');
    expect(() => serializeWorkflow(wf([a], [edge(a.id, 'ghost')]))).toThrow(/unknown (source|target)/i);
  });
});

describe('looksCanonical / fromCanonicalDefinition', () => {
  // Twin: deserialize.test.ts `looksCanonical` asserts the predicate on literal
  // shapes; this one on what `serializeWorkflow` actually EMITS.
  it('recognizes a canonical backend definition vs a partial builder shape', () => {
    const a = node('noop', 'A');
    const b = node('uppercase', 'B');
    const def = serializeWorkflow(wf([a, b], [edge(a.id, b.id)]));
    expect(looksCanonical(def)).toBe(true);
    expect(looksCanonical({ nodes: [{ kind: 'noop' }], edges: [] })).toBe(false);
  });

  // Twin: roundTripFidelity.test.ts covers node ids/edges over a STORED
  // definition; this one starts from a builder-authored graph.
  it('round-trips a serialized definition back to builder nodes/edges', () => {
    const a = node('noop', 'A');
    const b = node('uppercase', 'B');
    const def = serializeWorkflow(wf([a, b], [edge(a.id, b.id)]));
    const back = fromCanonicalDefinition(def);
    expect(back.nodes.map((n) => [n.id, n.kind, n.name])).toEqual([[a.id, 'noop', 'A'], [b.id, 'uppercase', 'B']]);
    expect(back.edges.map((e) => [e.source, e.target])).toEqual([[a.id, b.id]]);
  });

  // Twin: deserialize.test.ts "throws on a definition with no nodes" (same guard).
  it('throws on a definition with no nodes', () => {
    expect(() => fromCanonicalDefinition({ nodes: [], edges: [] })).toThrow('Workflow definition has no nodes.');
  });
});
