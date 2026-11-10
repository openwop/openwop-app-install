/** ADR 0440 §WF-BLD-1 correction (2026-11-05): the shipped Messaging Kernel
 * (three parallel generate→promote field edges) was refused as cyclic at Run.
 * Actual shipped chain expansion/import/serialization; only catalog HTTP is stubbed.
 * No workflow execution, provider, credential or persistence calls.
 * Breaks if: builder Kahn counts parallel port edges as separate dependencies (the
 * incident); serialize drops `targetInput`; import drops `sourceOutput`; a real
 * back-edge stops being refused as a cycle. */
import { afterEach, expect, it, vi } from 'vitest';
import { expandKernelForBuilder } from '../../__tests__/support/builderContractClient.js';
import { loadDynamicCatalog } from '../../palette/catalogRegistry.js';
import { fromCanonicalDefinition } from '../deserialize.js';
import { serializeWorkflow } from '../serialize.js';

afterEach(() => vi.unstubAllGlobals());
it('round-trips the actual messaging kernel DAG with every approval and field edge; rejects a true backedge', async () => {
  const { definition: expanded, order: initialOrder } = await expandKernelForBuilder();
  const expandedEdges = expanded.edges;
  if (!expandedEdges) throw new Error('Messaging kernel must contain edges');
  expect(expandedEdges).toHaveLength(5);
  expect(initialOrder.map(id => id.slice(id.lastIndexOf('_') + 1))).toEqual(['kernel', 'approve', 'promote']);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nodes: expanded.nodes.map(n => ({ typeId: n.typeId, name: n.typeId, category: 'other', source: 'pack', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } })) }), { status: 200 })));
  await loadDynamicCatalog();
  const imported = fromCanonicalDefinition(expanded);
  const saved = { id: 'kernel-roundtrip', name: 'Messaging kernel', version: '1.0.0', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', nodes: imported.nodes, edges: imported.edges };
  const result = serializeWorkflow(saved);
  expect(result.edges).toHaveLength(5);
  const ports = (edges: NonNullable<typeof expanded.edges>) => edges.map(e => [e.sourceNodeId, e.sourceOutput, e.targetNodeId, e.targetInput]);
  expect(ports(result.edges)).toEqual(ports(expandedEdges));
  expect(result.nodes.map(n => n.nodeId)).toEqual(expanded.nodes.map(n => n.nodeId));
  expect(result.nodes.find(n => n.typeId.includes('generate-kernel'))?.inputs).toMatchObject({ briefId: 'local-brief', provider: 'google', model: 'gemini-3.8-flash' });
  const promote = imported.nodes.find(n => n.kind.includes('promote-kernel'));
  const generate = imported.nodes.find(n => n.kind.includes('generate-kernel'));
  if (!promote || !generate) throw new Error('Kernel promotion/generation node missing');
  expect(() => serializeWorkflow({ ...saved, edges: [...saved.edges, { id: 'true-backedge', source: promote.id, sourcePort: 'out', target: generate.id, targetPort: 'in' }] })).toThrow(/cycle/i);
});
