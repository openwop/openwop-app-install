/**
 * ADR 0782 — `x-ports: "single"` keeps one input port whatever `required` says,
 * so restoring an input schema's `required` does not re-route a saved edge.
 *
 * Why it matters: a non-`in` target port is persisted as the edge's
 * `targetInput`, which routes data into that input field. Without the hint, a
 * saved edge with no `targetInput` re-binds to the FIRST required field on the
 * next save — the contrast case below proves that is what the hint prevents.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const MULTI = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] };
const SERVER_ROWS = [
  { typeId: 'vendor.test.hinted', version: '1.0.0', label: 'Hinted', description: '', category: 'data', source: 'pack' as const, inputSchema: MULTI, ports: 'single' as const },
  { typeId: 'vendor.test.plain', version: '1.0.0', label: 'Plain', description: '', category: 'data', source: 'pack' as const, inputSchema: MULTI },
  { typeId: 'vendor.test.src', version: '1.0.0', label: 'Src', description: '', category: 'data', source: 'pack' as const },
];

async function freshModules() {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
    String(url).includes('node-catalog')
      ? new Response(JSON.stringify({ nodes: SERVER_ROWS }), { status: 200 })
      : new Response('{}', { status: 404 })
  )));
  const reg = await import('../catalogRegistry.js');
  await reg.loadDynamicCatalog();
  const { fromCanonicalDefinition } = await import('../../schema/deserialize.js');
  const { serializeWithIdMap } = await import('../../schema/serialize.js');
  return { reg, fromCanonicalDefinition, serializeWithIdMap };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('portsFromSchema (ADR 0782)', () => {
  it('the hint yields one fallback port despite several required fields', async () => {
    const { reg } = await freshModules();
    expect(reg.portsFromSchema(MULTI, 'in', 'single')).toEqual([{ name: 'in', type: 'object' }]);
  });

  it('without the hint the default derivation is unchanged (one port per required field)', async () => {
    const { reg } = await freshModules();
    expect(reg.portsFromSchema(MULTI, 'in').map((p) => p.name)).toEqual(['a', 'b']);
    expect(reg.portsFromSchema({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, 'in').map((p) => p.name)).toEqual(['x']);
    expect(reg.portsFromSchema({ type: 'object', properties: { x: {} } }, 'in').map((p) => p.name)).toEqual(['in']);
  });
});

describe('a saved edge keeps its routing across a load/save round trip (ADR 0782)', () => {
  const def = (target: string) => ({
    workflowId: 'wf.ports', name: 'Ports',
    nodes: [{ nodeId: 's', typeId: 'vendor.test.src' }, { nodeId: 't', typeId: target }],
    edges: [{ id: 'e1', sourceNodeId: 's', targetNodeId: 't' }],
  });

  it('into a HINTED node, the edge stays on `in` and saves with no targetInput', async () => {
    const { fromCanonicalDefinition, serializeWithIdMap } = await freshModules();
    const loaded = fromCanonicalDefinition(def('vendor.test.hinted'));
    expect(loaded.edges[0]?.targetPort).toBe('in');
    const { definition } = serializeWithIdMap({ id: 'wf.ports', name: 'Ports', version: '1', nodes: loaded.nodes, edges: loaded.edges, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(definition.edges?.[0]).not.toHaveProperty('targetInput');
  });

  it('contrast: into an UNHINTED multi-required node, the same edge re-binds to the first required field', async () => {
    const { fromCanonicalDefinition, serializeWithIdMap } = await freshModules();
    const loaded = fromCanonicalDefinition(def('vendor.test.plain'));
    const { definition } = serializeWithIdMap({ id: 'wf.ports', name: 'Ports', version: '1', nodes: loaded.nodes, edges: loaded.edges, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(definition.edges?.[0]).toHaveProperty('targetInput', 'a');
  });
});
