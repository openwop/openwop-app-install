/**
 * BLD-1 (grade-code gap): the deserialize (canonical → builder) layer is the
 * import correctness gate — it resolves typeIds against the installed catalog,
 * inherits default ports, normalizes default inputs, and MUST fail loudly
 * (aggregate error naming the offending typeIds) rather than silently dropping
 * nodes. Pure functions; high-value coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  fromCanonicalDefinition,
  looksCanonical,
  CanonicalParseError,
} from '../deserialize.js';

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

  it('inherits default ports when edges omit them', () => {
    const res = fromCanonicalDefinition({
      nodes: [
        { id: 'a', typeId: 'core.noop' },
        { id: 'b', typeId: 'local.openwop-app.uppercase' },
      ],
      edges: [{ sourceNodeId: 'a', targetNodeId: 'b' }],
    });
    const e = res.edges[0]!;
    expect(typeof e.sourcePort).toBe('string');
    expect(typeof e.targetPort).toBe('string');
    expect(e.sourcePort.length).toBeGreaterThan(0);
    expect(e.targetPort.length).toBeGreaterThan(0);
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

describe('fromCanonicalDefinition — failure modes', () => {
  it('throws on a definition with no nodes', () => {
    expect(() => fromCanonicalDefinition({ nodes: [], edges: [] })).toThrow(CanonicalParseError);
    expect(() => fromCanonicalDefinition({ nodes: [], edges: [] })).toThrow(/no nodes/i);
  });

  it('throws on a node missing id or typeId', () => {
    expect(() => fromCanonicalDefinition({ nodes: [{ typeId: 'core.noop' }], edges: [] }))
      .toThrow(CanonicalParseError);
    expect(() => fromCanonicalDefinition({ nodes: [{ id: 'a' }], edges: [] }))
      .toThrow(CanonicalParseError);
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
