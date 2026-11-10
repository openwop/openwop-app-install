/**
 * BLD-1 (grade-code gap): the deserialize (canonical → builder) layer is the
 * import correctness gate — it resolves typeIds against the installed catalog,
 * inherits default ports, normalizes default inputs, and MUST fail loudly
 * (aggregate error naming the offending typeIds) rather than silently dropping
 * nodes. Pure functions; high-value coverage.
 */
import { describe, it, expect } from 'vitest';
import { serializeWorkflow } from '../serialize.js';
import { projectSourceOutput } from '../sourceOutput.js';
import {
  fromCanonicalDefinition,
  looksCanonical,
  CanonicalParseError,
} from '../deserialize.js';

// Twin: serialize.test.ts "recognizes a canonical backend definition…" asserts
// the same predicate on a SERIALIZED definition (the shape the builder emits).
describe('looksCanonical', () => {
  it('is true for nodes carrying typeId (backend shape)', () => {
    expect(looksCanonical({ nodes: [{ typeId: 'core.noop', id: 'n0' }], edges: [] })).toBe(true);
  });
  it('is false for a builder SavedWorkflow shape (nodes carry kind)', () => {
    expect(looksCanonical({ nodes: [{ kind: 'noop' }], edges: [] })).toBe(false);
  });
  it('is false for empty / non-object / no-nodes inputs', () => {
    expect(looksCanonical(null)).toBe(false);
    expect(looksCanonical({})).toBe(false);
    expect(looksCanonical({ nodes: [] })).toBe(false);
    expect(looksCanonical('nope')).toBe(false);
  });
});

describe('fromCanonicalDefinition — happy path', () => {
  it('resolves typeIds to kinds and round-trips a linear graph', () => {
    const def = {
      name: 'My Flow',
      nodes: [
        { id: 'a', typeId: 'core.noop', position: { x: 1, y: 2 } },
        { id: 'b', typeId: 'local.openwop-app.uppercase' },
      ],
      edges: [{ id: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }],
    };
    const res = fromCanonicalDefinition(def);
    expect(res.name).toBe('My Flow');
    expect(res.nodes).toHaveLength(2);
    expect(res.edges).toHaveLength(1);
    const a = res.nodes.find((n) => n.id === 'a')!;
    expect(a.kind).toBe('noop');
    expect(a.position).toEqual({ x: 1, y: 2 });
  });

  it('reads the OpenWOP metadata.name when no top-level name (pack-instantiated templates)', () => {
    // pack-instantiated defs carry the label in metadata.name, not top-level name
    const res = fromCanonicalDefinition({
      metadata: { name: 'Ad Performance Optimization Loop' },
      nodes: [{ id: 'a', typeId: 'core.noop' }],
      edges: [],
    });
    expect(res.name).toBe('Ad Performance Optimization Loop'); // not "Imported workflow"
  });

  it('top-level name wins over metadata.name; falls back to Imported workflow only when both absent', () => {
    expect(fromCanonicalDefinition({ name: 'Top', metadata: { name: 'Meta' }, nodes: [{ id: 'a', typeId: 'core.noop' }], edges: [] }).name).toBe('Top');
    expect(fromCanonicalDefinition({ nodes: [{ id: 'a', typeId: 'core.noop' }], edges: [] }).name).toBe('Imported workflow');
  });

  it('accepts the backend `nodeId` alias for `id`', () => {
    const res = fromCanonicalDefinition({
      nodes: [{ nodeId: 'x', typeId: 'core.noop' }],
      edges: [],
    });
    expect(res.nodes[0]!.id).toBe('x');
  });

  it('auto-positions nodes that arrive without a position (grid layout)', () => {
    const res = fromCanonicalDefinition({
      nodes: [
        { id: 'a', typeId: 'core.noop' },
        { id: 'b', typeId: 'core.noop' },
      ],
      edges: [],
    });
    // Two distinct positions on the grid (first row).
    expect(res.nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(res.nodes[1]!.position).toEqual({ x: 220, y: 0 });
  });

  it('preserves omitted source semantics while keeping the existing inherited target port', () => {
    const nodes = [
      { id: 'a', typeId: 'local.openwop-app.uppercase' },
      { id: 'b', typeId: 'local.openwop-app.uppercase' },
    ];
    const res = fromCanonicalDefinition({ nodes, edges: [{ sourceNodeId: 'a', targetNodeId: 'b' }] });
    const e = res.edges[0];
    if (!e) throw new Error('Imported default edge missing');
    // BUILDER-PORT-1: the previous sourcePort='text' assertion pinned the
    // first-catalog inference that lost wire omission. Literal out is only the
    // compatibility placeholder; null and the separate default handle own meaning.
    expect(e.sourcePort).toBe('out');
    expect(e.targetPort).toBe('text'); // target-port behavior is unchanged.
    expect(e.canonicalSourceOutput).toBeNull();
    const saved = { ...res, id: 'wf.default-source', version: '1.0.0', createdAt: 'now', updatedAt: 'now' };
    expect(serializeWorkflow(saved).edges[0]).not.toHaveProperty('sourceOutput');
    expect(projectSourceOutput(e, [{ name: 'text', type: 'string' }])).toMatchObject({ label: 'Default output', virtual: true, type: 'any' });
    expect(projectSourceOutput(e, [{ name: 'text', type: 'string' }]).handleId).not.toBe('text');
    // An explicit text binding remains text, not omission or the placeholder.
    const named = fromCanonicalDefinition({ nodes, edges: [{ sourceNodeId: 'a', targetNodeId: 'b', sourceOutput: 'text' }] });
    const namedEdge = named.edges[0];
    if (!namedEdge) throw new Error('Imported named edge missing');
    expect(namedEdge.sourcePort).toBe('text');
    expect(namedEdge.canonicalSourceOutput).toBe('text');
    expect(namedEdge.targetPort).toBe('text');
    expect(serializeWorkflow({ ...saved, edges: named.edges }).edges[0]).toHaveProperty('sourceOutput', 'text');
  });

  it('preserves a valid triggerRule and drops an invalid one', () => {
    const res = fromCanonicalDefinition({
      nodes: [
        { id: 'a', typeId: 'core.noop' },
        { id: 'b', typeId: 'local.openwop-app.uppercase' },
        { id: 'c', typeId: 'local.openwop-app.uppercase' },
      ],
      edges: [
        { id: 'e1', sourceNodeId: 'a', targetNodeId: 'b', triggerRule: 'any_success' },
        { id: 'e2', sourceNodeId: 'a', targetNodeId: 'c', triggerRule: 'bogus_rule' },
      ],
    });
    const e1 = res.edges.find((e) => e.id === 'e1')!;
    const e2 = res.edges.find((e) => e.id === 'e2')!;
    expect(e1.triggerRule).toBe('any_success');
    expect(e2.triggerRule).toBeUndefined();
  });

  it('normalizes an object defaultInputs to pretty JSON', () => {
    const res = fromCanonicalDefinition({
      nodes: [{ id: 'a', typeId: 'core.noop' }],
      edges: [],
      defaultInputs: { foo: 'bar' },
    });
    expect(JSON.parse(res.defaultInputs)).toEqual({ foo: 'bar' });
  });
});

describe('fromCanonicalDefinition — ADR 0766 exact node pins', () => {
  it('imports a pinned typeId (`core.noop@1.0.0`, legal in a v2 definition) as its bare kind', () => {
    const res = fromCanonicalDefinition({ nodes: [{ id: 'a', typeId: 'core.noop@1.0.0' }], edges: [] });
    expect(res.nodes).toHaveLength(1);
    expect(res.nodes[0]!.kind).toBe('noop');
  });
});

describe('fromCanonicalDefinition — failure modes', () => {
  // Twin: serialize.test.ts "fromCanonicalDefinition throws on a definition with no nodes".
  it('throws on a definition with no nodes', () => {
    expect(() => fromCanonicalDefinition({ nodes: [], edges: [] })).toThrow(CanonicalParseError);
    expect(() => fromCanonicalDefinition({ nodes: [], edges: [] })).toThrow(/no nodes/i);
  });

  it('throws on a node missing id or typeId', () => {
    // The exact message: an unknown typeId throws the SAME class, so the class
    // alone cannot say which guard refused.
    expect(() => fromCanonicalDefinition({ nodes: [{ typeId: 'core.noop' }], edges: [] }))
      .toThrow(CanonicalParseError);
    expect(() => fromCanonicalDefinition({ nodes: [{ typeId: 'core.noop' }], edges: [] }))
      .toThrow('Node 0 is missing an id or typeId.');
    expect(() => fromCanonicalDefinition({ nodes: [{ id: 'a' }], edges: [] }))
      .toThrow('Node 0 is missing an id or typeId.');
  });

  it('throws an aggregate error naming every unknown typeId (deduped)', () => {
    let err: unknown;
    try {
      fromCanonicalDefinition({
        nodes: [
          { id: 'a', typeId: 'core.noop' },
          { id: 'b', typeId: 'vendor.unknown.alpha' },
          { id: 'c', typeId: 'vendor.unknown.beta' },
          { id: 'd', typeId: 'vendor.unknown.alpha' }, // duplicate of b's type
        ],
        edges: [],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CanonicalParseError);
    const msg = (err as Error).message;
    expect(msg).toContain('vendor.unknown.alpha');
    expect(msg).toContain('vendor.unknown.beta');
    // Deduped: alpha appears once even though two nodes use it.
    expect(msg.match(/vendor\.unknown\.alpha/g)).toHaveLength(1);
  });
});
