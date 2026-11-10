/** BUILDER-PORT-1 (ADR 0440 correction, 2026-11-07; incident witness): importing
 * a real catalog workflow rewrote omitted HTTP/KV source outputs to the first
 * catalog field (`status`, `found`). This file pins the lossless canonical
 * roundtrip against the shipped pack schemas, the collision-safe fixed-width
 * UTF-16 virtual handle ids, and the actual backend scheduler projection over
 * bounded IPC (no node execution).
 *
 * Sabotage, each witnessed red (wave 97): `sourceOutputForWire(null)` returning the
 * placeholder; deserialize dropping `canonicalSourceOutput`; the legacy `output`
 * alias no longer omitted; `sameSourceBinding` comparing `sourcePort`; the `:`
 * collision suffix removed; `padStart(4)` removed; `codePointAt` for
 * `charCodeAt`; the default type taken from the first output; the scheduler
 * ignoring `e.sourceOutput`. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { loadDynamicCatalog, catalogEntryByTypeId } from '../../palette/catalogRegistry.js';
import { fromCanonicalDefinition } from '../deserialize.js';
import { serializeWorkflow } from '../serialize.js';
import { sourceOutputForWire, projectSourceOutput, sameSourceBinding, virtualSourceOutputs } from '../sourceOutput.js';
import type { SavedWorkflow } from '../workflow.js';
import { projectBuilderInputs } from '../../__tests__/support/builderContractClient.js';

interface ManifestNode { typeId: string; label: string; category: string; inputSchemaRef: string; outputSchemaRef: string; configSchemaRef: string }
interface Manifest { name: string; nodes: ManifestNode[] }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isManifestNode(value: unknown): value is ManifestNode {
  return isRecord(value) && ['typeId', 'label', 'category', 'inputSchemaRef', 'outputSchemaRef', 'configSchemaRef'].every(k => typeof value[k] === 'string');
}
function isManifest(value: unknown): value is Manifest {
  return isRecord(value) && typeof value.name === 'string' && Array.isArray(value.nodes) && value.nodes.every(isManifestNode);
}
function catalogNode(pack: string, typeId: string) {
  const root = resolve(process.cwd(), '../../packs', pack);
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'pack.json'), 'utf8'));
  if (!isManifest(manifest)) throw new Error('Unexpected pack manifest shape: ' + pack);
  const node = manifest.nodes.find(row => row.typeId === typeId);
  if (!node) throw new Error('Shipped node missing: ' + typeId);
  const schema = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  return { typeId, label: node.label, name: node.label, category: node.category, source: 'pack', packName: manifest.name,
    inputSchema: schema(node.inputSchemaRef), outputSchema: schema(node.outputSchemaRef), configSchema: schema(node.configSchemaRef) };
}
const rows = [catalogNode('core.openwop.http', 'core.openwop.http.fetch'), catalogNode('core.openwop.storage', 'core.storage.kv-get'), catalogNode('core.openwop.ai', 'core.ai.chatCompletion')];
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith('/host/openwop-app/node-catalog')) throw new Error('Unexpected network: ' + String(input));
    return new Response(JSON.stringify({ nodes: rows }), { status: 200 });
  }));
  await loadDynamicCatalog();
});
afterAll(() => vi.unstubAllGlobals());
function canonical(sourceOutput?: string) {
  return { workflowId: 'wf.port-preservation', version: '1.0.0', nodes: [
    { nodeId: 'fetch', typeId: 'core.openwop.http.fetch', inputs: {}, config: { url: 'https://example.invalid/' } },
    { nodeId: 'snapshot', typeId: 'core.storage.kv-get', inputs: {}, config: { namespace: 'synthetic', key: 'synthetic' } },
    { nodeId: 'diff', typeId: 'core.ai.chatCompletion', inputs: {}, config: {} },
  ], edges: [
    { edgeId: 'http', sourceNodeId: 'fetch', targetNodeId: 'diff', targetInput: 'fetch', ...(sourceOutput !== undefined ? { sourceOutput } : {}) },
    { edgeId: 'kv', sourceNodeId: 'snapshot', targetNodeId: 'diff', targetInput: 'snapshot' },
  ] };
}
function saved(def = canonical()): SavedWorkflow {
  const parsed = fromCanonicalDefinition(def);
  return { id: def.workflowId, name: 'Synthetic port preservation', version: '1.0.0', nodes: parsed.nodes, edges: parsed.edges, createdAt: '2026-11-07T00:00:00Z', updatedAt: '2026-11-07T00:00:00Z' };
}
it('preserves omitted HTTP and KV outputs through real catalog import, without selecting status/found', () => {
  // Premise, asserted in the case (a failing beforeAll would skip, not fail):
  // the shipped catalog lists the scalars the old import inferred.
  expect(catalogEntryByTypeId('core.openwop.http.fetch')?.outputs.map(p => p.name)).toEqual(['status', 'headers', 'body', 'durationMs', 'attempts']);
  expect(catalogEntryByTypeId('core.storage.kv-get')?.outputs.map(p => p.name)).toEqual(['found']);
  const wf = saved();
  // Canonical omission uses the literal compatibility placeholder, never an
  // inferred catalog scalar. The null binding owns canonical intent/geometry.
  expect(wf.edges.map(e => e.sourcePort)).toEqual(['out', 'out']);
  expect(wf.edges.map(e => e.canonicalSourceOutput)).toEqual([null, null]);
  const result = serializeWorkflow(wf);
  expect(result.edges).toEqual(canonical().edges);
  expect(JSON.stringify(result)).not.toContain('canonicalSourceOutput');
  expect(JSON.stringify(result)).not.toContain('__openwop_');
});
it.each(['status', 'out', 'output'])('preserves exact explicitly named %s rather than converting it to omission', name => {
  const result = serializeWorkflow(saved(canonical(name)));
  expect(result.edges[0]).toEqual(canonical(name).edges[0]);
  expect(result.edges[0]).toHaveProperty('sourceOutput', name);
});
it('preserves legacy cache aliases while distinguishing newly explicit aliases and default equality', () => {
  expect(sourceOutputForWire({ sourcePort: 'out' })).toBeUndefined();
  expect(sourceOutputForWire({ sourcePort: 'output' })).toBeUndefined();
  expect(sourceOutputForWire({ sourcePort: 'status' })).toBe('status');
  expect(sameSourceBinding({ sourcePort: 'status', canonicalSourceOutput: null }, { sourcePort: 'status', canonicalSourceOutput: 'status' })).toBe(false);
});
it('projects a collision-safe default separately from named scalar and unresolved explicit output', () => {
  const outputs = [{ name: 'status', type: 'number' as const }, { name: '__openwop_default_output', type: 'string' as const }];
  const p = projectSourceOutput({ sourcePort: 'status', canonicalSourceOutput: null }, outputs);
  expect(p).toMatchObject({ handleId: '__openwop_default_output:', label: 'Default output', type: 'any', virtual: true, missing: false });
  expect(projectSourceOutput({ sourcePort: 'status', canonicalSourceOutput: 'status' }, outputs)).toMatchObject({ handleId: 'status', label: 'status', type: 'number', virtual: false });
  expect(projectSourceOutput({ sourcePort: 'unknown', canonicalSourceOutput: 'unknown' }, outputs)).toMatchObject({ label: 'Missing output: unknown', virtual: true, missing: true });
});
it('distinct missing bindings retain distinct labels and handles when a real catalog name collides', () => {
  const outputs = [{ name: '__openwop_missing_output:0061', type: 'string' as const }];
  const first = projectSourceOutput({ sourcePort: 'a', canonicalSourceOutput: 'a' }, outputs);
  const second = projectSourceOutput({ sourcePort: 'a_', canonicalSourceOutput: 'a_' }, outputs);
  expect(first).toMatchObject({ handleId: '__openwop_missing_output:0061:', label: 'Missing output: a', virtual: true, missing: true });
  expect(second).toMatchObject({ handleId: '__openwop_missing_output:0061005f', label: 'Missing output: a_', virtual: true, missing: true });
  expect(first.handleId).not.toBe(second.handleId);
  expect(virtualSourceOutputs([
    { sourcePort: 'a', canonicalSourceOutput: 'a' },
    { sourcePort: 'a_', canonicalSourceOutput: 'a_' },
  ], outputs)).toEqual([first, second]);
});
const unusualNames = [
  { name: 'lone high surrogate', value: '\ud800', encoded: 'd800' },
  { name: 'lone low surrogate', value: '\udc00', encoded: 'dc00' },
  { name: 'literal escape text', value: '\\ud800', encoded: '005c00750064003800300030' },
  { name: 'non-BMP pair', value: '\ud83d\ude00', encoded: 'd83dde00' },
];
it.each(unusualNames)('projects $name safely and preserves its exact canonical wire name', row => {
  const binding = { sourcePort: row.value, canonicalSourceOutput: row.value };
  expect(projectSourceOutput(binding, [])).toMatchObject({ handleId: '__openwop_missing_output:' + row.encoded, virtual: true, missing: true });
  expect(sourceOutputForWire(binding)).toBe(row.value);
  expect(JSON.parse(JSON.stringify({ sourceOutput: sourceOutputForWire(binding) }))).toEqual({ sourceOutput: row.value });
});
it('UTF-16 and literal escape identities never collapse to the same virtual handle', () => {
  const ports = virtualSourceOutputs(unusualNames.map(row => ({ sourcePort: row.value, canonicalSourceOutput: row.value })), []);
  expect(ports).toHaveLength(4);
  expect(new Set(ports.map(p => p.handleId)).size).toBe(4);
  expect(ports.map(p => p.handleId)).toEqual(unusualNames.map(row => '__openwop_missing_output:' + row.encoded));
});
const maps = { fetch: { status: 200, body: 'BODY_SENTINEL', out: 'OUT_SENTINEL' }, snapshot: { found: false, value: 'KV_SENTINEL' } };
const schedulerCases = [
  { name: 'omitted with no output property passes whole maps', binding: undefined, outputs: maps, expected: { fetch: maps.fetch, snapshot: maps.snapshot } },
  { name: 'explicit status passes scalar', binding: 'status', outputs: maps, expected: { fetch: 200, snapshot: maps.snapshot } },
  { name: 'explicit out passes its own value', binding: 'out', outputs: maps, expected: { fetch: 'OUT_SENTINEL', snapshot: maps.snapshot } },
  { name: 'omitted prefers own output property', binding: undefined, outputs: { ...maps, fetch: { ...maps.fetch, output: 'OUTPUT_SENTINEL' } }, expected: { fetch: 'OUTPUT_SENTINEL', snapshot: maps.snapshot } },
  { name: 'explicit output remains explicit on wire', binding: 'output', outputs: { ...maps, fetch: { ...maps.fetch, output: 'OUTPUT_SENTINEL' } }, expected: { fetch: 'OUTPUT_SENTINEL', snapshot: maps.snapshot } },
  { name: 'explicit missing field retains existing map fallback', binding: 'missing', outputs: maps, expected: { fetch: maps.fetch, snapshot: maps.snapshot } },
];
it.each(schedulerCases)('actual validator/scheduler: $name', async row => {
  const result = serializeWorkflow(saved(canonical(row.binding)));
  const edge = result.edges[0];
  if (!edge) throw new Error('Roundtrip edge missing');
  expect(edge.sourceOutput).toBe(row.binding);
  expect(Object.hasOwn(edge, 'sourceOutput')).toBe(row.binding !== undefined);
  expect(await projectBuilderInputs(result, 'diff', row.outputs)).toEqual(row.expected);
});
it('actual scheduler baseline uses original omitted edges without frontend projection', async () => {
  const original = canonical();
  expect(await projectBuilderInputs(original, 'diff', maps)).toEqual({ fetch: maps.fetch, snapshot: maps.snapshot });
});
it('explicit KV found remains false after actual frontend roundtrip and backend scheduler projection', async () => {
  const original = canonical();
  const scalars = { ...original, edges: original.edges.map(e => ({ ...e, sourceOutput: e.edgeId === 'http' ? 'status' : 'found' })) };
  expect(await projectBuilderInputs(serializeWorkflow(saved(scalars)), 'diff', maps)).toEqual({ fetch: 200, snapshot: false });
});
