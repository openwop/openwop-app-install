/**
 * BLD-1 (CODEBASE-ASSESSMENT.md): the workflow builder's serialize/deserialize
 * layer is the correctness backbone (cycle detection, edge integrity,
 * id-mapping, round-trip) yet was untested. These are pure functions — cheap,
 * high-value coverage.
 */
import { describe, it, expect } from 'vitest';
import { serializeWithIdMap, serializeWorkflow, SerializeError } from '../serialize.js';
import { looksCanonical, fromCanonicalDefinition } from '../deserialize.js';
import type { BuilderNode, BuilderEdge, SavedWorkflow } from '../workflow.js';

let seq = 0;
function node(kind: string, name = kind): BuilderNode {
  return { id: `n${seq++}`, kind: kind as BuilderNode['kind'], name, position: { x: 0, y: 0 }, config: {} };
}
function edge(source: string, target: string): BuilderEdge {
  return { id: `e-${source}-${target}`, source, sourcePort: 'out', target, targetPort: 'in' };
}
function wf(nodes: BuilderNode[], edges: BuilderEdge[]): SavedWorkflow {
  return { id: 'wf1', name: 'Test', version: '1.0.0', nodes, edges, createdAt: 'now', updatedAt: 'now' };
}

describe('serializeWithIdMap', () => {
  it('serializes a linear workflow + returns a builder→backend id map', () => {
    const a = node('noop', 'Start');
    const b = node('uppercase', 'Upper');
    const res = serializeWithIdMap(wf([a, b], [edge(a.id, b.id)]));
    expect(res.definition.nodes).toHaveLength(2);
    expect(res.definition.edges).toHaveLength(1);
    expect(Object.keys(res.builderIdToBackend)).toEqual(expect.arrayContaining([a.id, b.id]));
    // The inverse map round-trips.
    for (const [builderId, backendId] of Object.entries(res.builderIdToBackend)) {
      expect(res.backendIdToBuilder[backendId]).toBe(builderId);
    }
    for (const n of res.definition.nodes) {
      expect(n.nodeId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/); // wire nodeId pattern
    }
  });

  it('serializes a fan-out (one source, two parallel branches)', () => {
    const a = node('noop', 'Start');
    const b = node('uppercase', 'B');
    const c = node('uppercase', 'C');
    const res = serializeWorkflow(wf([a, b, c], [edge(a.id, b.id), edge(a.id, c.id)]));
    expect(res.nodes).toHaveLength(3);
    expect(res.edges).toHaveLength(2);
  });

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
    expect((err as SerializeError).nodeId).toBeDefined();
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
  it('recognizes a canonical backend definition vs a partial builder shape', () => {
    const a = node('noop', 'A');
    const b = node('uppercase', 'B');
    const def = serializeWorkflow(wf([a, b], [edge(a.id, b.id)]));
    expect(looksCanonical(def)).toBe(true);
    expect(looksCanonical({ nodes: [{ kind: 'noop' }], edges: [] })).toBe(false);
  });

  it('round-trips a serialized definition back to builder nodes/edges', () => {
    const a = node('noop', 'A');
    const b = node('uppercase', 'B');
    const def = serializeWorkflow(wf([a, b], [edge(a.id, b.id)]));
    const back = fromCanonicalDefinition(def);
    expect(back.nodes).toHaveLength(2);
    expect(back.edges).toHaveLength(1);
  });

  it('throws on a definition with no nodes', () => {
    expect(() => fromCanonicalDefinition({ nodes: [], edges: [] })).toThrow(/no nodes/i);
  });
});
