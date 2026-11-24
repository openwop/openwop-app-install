import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createStore } from 'zustand/vanilla';
import { builderStoreInitializer } from '../../store/builderStore.js';
import { catalogEntry, catalogEntryByTypeId, isDynamicCatalogLoaded, loadDynamicCatalog } from '../../palette/catalogRegistry.js';
import { buildChainPackManifest, ChainExportFidelityError, ChainExportVersionError } from '../chainPackManifest.js';
import { chainExportFailure } from '../../builderShellHelpers.js';
import { definitionMetadataFor } from '../../persistence/definitionMetadata.js';
import { chainExportCatalog, loadChainExport } from '../../__tests__/support/builderContractClient.js';
import i18n, { setLocale } from '../../../i18n/index.js';
import type { ChainPackManifest } from '../chainPackManifest.js';
import type { BuilderEdge, BuilderNode, SavedWorkflow } from '../workflow.js';

const SOURCE = 'feature.campaign-fixture.nodes.source';
const TARGET = 'feature.campaign-fixture.nodes.target';
const BAD = 'feature.campaign-fixture.nodes.prerelease';
const UNKNOWN = 'feature.campaign-fixture.nodes.unknown-version';
const PRIVATE = 'PRIVATE_marker';
const versionOf = (typeId: string): string | undefined => catalogEntryByTypeId(typeId)?.version;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected actual contract object');
  return value;
}
function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('Expected actual contract array');
  return value.map(record);
}

function ownedNode(snap: SavedWorkflow, id: string): BuilderNode {
  const matches = snap.nodes.filter(n => n.id === id);
  const found = matches[0];
  if (matches.length !== 1 || !found) throw new Error('Expected unique fixture node: ' + id);
  return found;
}
function ownedEdge(snap: SavedWorkflow, id: string): BuilderEdge {
  const matches = snap.edges.filter(e => e.id === id);
  const found = matches[0];
  if (matches.length !== 1 || !found) throw new Error('Expected unique fixture edge: ' + id);
  return found;
}
function onlyChain(manifest: ChainPackManifest): ChainPackManifest['chains'][number] {
  const chain = manifest.chains[0];
  if (manifest.chains.length !== 1 || !chain || chain.chainId !== manifest.name) throw new Error('Expected exact exported chain identity');
  return chain;
}
function rawChain(manifest: Record<string, unknown>): Record<string, unknown> {
  const chains = records(manifest.chains);
  const chain = chains[0];
  if (chains.length !== 1 || !chain || chain.chainId !== manifest.name) throw new Error('Expected actual exported chain identity');
  return chain;
}

function node(id: string, kind: string, over: Partial<BuilderNode> = {}): BuilderNode {
  return { id, kind, name: 'Owned ' + id, position: { x: id === 'source' ? 0 : 200, y: 20 }, config: {}, ...over };
}
function graph(): SavedWorkflow {
  const store = createStore(builderStoreInitializer);
  const edges: BuilderEdge[] = [
    { id: 'default', source: 'source', sourcePort: 'visible-but-not-canonical', canonicalSourceOutput: null,
      target: 'target', targetPort: 'input', condition: { op: 'truthy', path: 'decision.accepted', value: 'ignored' } },
    { id: 'falsy', source: 'source', sourcePort: 'out', canonicalSourceOutput: 'payload.detail',
      target: 'target', targetPort: 'named.in', condition: { op: 'falsy', path: 'decision.accepted' }, triggerRule: 'all_complete' },
    { id: 'false', source: 'source', sourcePort: 'out', canonicalSourceOutput: 'out',
      target: 'target', targetPort: 'in', condition: { op: 'eq', path: 'flag', value: false }, triggerRule: 'any_success' },
    { id: 'zero', source: 'source', sourcePort: 'out', canonicalSourceOutput: 'output',
      target: 'target', targetPort: 'named.in', condition: { op: 'neq', path: 'count', value: 0 }, triggerRule: 'none_failed' },
    { id: 'null', source: 'source', sourcePort: 'out', canonicalSourceOutput: 'payload.detail',
      target: 'target', targetPort: 'named.in', condition: { op: 'contains', path: 'items', value: null }, triggerRule: 'any_failed' },
    { id: 'finish', source: 'target', sourcePort: 'out', canonicalSourceOutput: null, target: 'finish', targetPort: 'input' },
  ];
  store.setState({ workflowId: 'wf-owned-export', name: 'Owned export fidelity',
    nodes: [node('source', SOURCE, { config: { marker: 'source-config' } }),
      node('target', TARGET, { inputs: { topic: '{{params.topic}}' } }), node('finish', 'noop')], edges });
  return store.getState().snapshot();
}
function refuse(snap: SavedWorkflow, field: string): void {
  const before = JSON.stringify(snap);
  let failure: unknown;
  try { buildChainPackManifest(snap, versionOf); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ChainExportFidelityError);
  if (!(failure instanceof ChainExportFidelityError)) throw new Error('Expected trusted refusal');
  expect(failure.fields).toContain(field);
  const ui = chainExportFailure(failure, snap.nodes);
  expect(ui).toEqual({ message: i18n.t('builder:exportChainPackFidelity') });
  expect(ui.message).not.toContain(PRIVATE);
  expect(JSON.stringify(snap)).toBe(before);
}
let catalogDigest = '';
const initialLocale = i18n.language;
beforeAll(async () => {
  await setLocale('en');
  await i18n.loadNamespaces('builder');
  expect(isDynamicCatalogLoaded()).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  await loadDynamicCatalog();
  expect(isDynamicCatalogLoaded()).toBe(false);
  const missing = new ChainExportVersionError([SOURCE]);
  expect(chainExportFailure(missing, [], isDynamicCatalogLoaded()).message)
    .toBe(i18n.t('builder:exportChainPackCatalogUnavailable'));
  const produced = await chainExportCatalog();
  expect(produced.nodes).toHaveLength(5);
  expect(produced.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ typeId: SOURCE, version: '1.2.3', source: 'pack', packName: 'fixture.chain-export.nodes' }),
    expect.objectContaining({ typeId: TARGET, version: '2.3.4' }),
    expect.objectContaining({ typeId: 'core.noop', version: '1.4.2' }),
  ]));
  catalogDigest = produced.digest;
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof url !== 'string' || !url.endsWith('/host/openwop-app/node-catalog') || (init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected fixture network request');
    return new Response(JSON.stringify({ nodes: produced.nodes }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  await loadDynamicCatalog();
  expect(isDynamicCatalogLoaded()).toBe(true);
  expect(catalogEntry('noop')).toBe(catalogEntryByTypeId('core.noop'));
  expect(versionOf('core.noop')).toBe('1.4.2');
  expect(catalogEntryByTypeId(SOURCE)?.outputs.map(p => p.name)).toEqual(['payload.detail', 'out', 'output']);
  expect(catalogEntryByTypeId(TARGET)?.inputs.map(p => p.name)).toEqual(['input', 'named.in']);
});
afterAll(async () => { vi.unstubAllGlobals(); await setLocale(initialLocale); });

describe('actual exporter artifact loads without semantic loss', () => {
  it('preserves canonical/default/named endpoints, all five conditions, four nondefault triggers and params', async () => {
    const snap = graph();
    expect(snap.defaultInputs).toBe('{}');
    const before = JSON.stringify(snap);
    const manifest = buildChainPackManifest(snap, versionOf);
    const chain = onlyChain(manifest);
    expect(chain.dag.nodes.map(n => n.typeId)).toEqual([SOURCE + '@1.2.3', TARGET + '@2.3.4', 'core.noop@1.4.2']);
    expect(chain.dag.edges).toEqual([
      { from: 'source', to: 'target', condition: { type: 'truthy', left: 'decision.accepted' } },
      { from: 'source.payload.detail', to: 'target.named.in', condition: { type: 'falsy', left: 'decision.accepted' }, triggerRule: 'all_complete' },
      { from: 'source.out', to: 'target', condition: { type: 'equals', left: 'flag', right: false }, triggerRule: 'any_success' },
      { from: 'source.output', to: 'target.named.in', condition: { type: 'notEquals', left: 'count', right: 0 }, triggerRule: 'none_failed' },
      { from: 'source.payload.detail', to: 'target.named.in', condition: { type: 'contains', left: 'items', right: null }, triggerRule: 'any_failed' },
      { from: 'target', to: 'finish' },
    ]);
    const bytes = JSON.stringify(manifest);
    const loaded = await loadChainExport(bytes, { topic: 'bound-topic' });
    expect(loaded.catalogDigest).toBe(catalogDigest);
    expect(loaded.manifestDigest).toBe(digest(bytes));
    expect(loaded.errors).toEqual([]);
    expect(loaded.entry).not.toBeNull();
    const entry = record(loaded.entry);
    expect(record(entry.chain).chainId).toBe(chain.chainId);
    expect(records(record(record(entry.chain).dag).nodes).map(n => n.typeId)).toEqual([SOURCE, TARGET, 'core.noop']);
    const definition = record(loaded.definition);
    const nodes = records(definition.nodes);
    expect(nodes).toHaveLength(3);
    // D1a (#6156): the loader carries `position` but never the editor `name`,
    // which definitionHash keeps, so nodes are found by their unique typeId.
    const source = nodes.find(n => n.typeId === SOURCE);
    const target = nodes.find(n => n.typeId === TARGET);
    const finish = nodes.find(n => n.typeId === 'core.noop');
    expect(source).toMatchObject({ typeId: SOURCE, config: { marker: 'source-config' }, position: { x: 0, y: 20 } });
    expect(target).toMatchObject({ typeId: TARGET, inputs: { topic: 'bound-topic' } });
    expect(finish).toMatchObject({ typeId: 'core.noop', outputRole: 'primary' });
    if (!source || !target || !finish) throw new Error('Expected one expanded node per typeId');
    expect(nodes.map(n => n.name)).not.toContain('Owned source');
    expect(records(definition.edges)).toEqual([
      { edgeId: 'e1', sourceNodeId: source.nodeId, targetNodeId: target.nodeId, condition: { op: 'truthy', path: 'decision.accepted' } },
      { edgeId: 'e2', sourceNodeId: source.nodeId, sourceOutput: 'payload.detail', targetNodeId: target.nodeId, targetInput: 'named.in', condition: { op: 'falsy', path: 'decision.accepted' }, triggerRule: 'all_complete' },
      { edgeId: 'e3', sourceNodeId: source.nodeId, sourceOutput: 'out', targetNodeId: target.nodeId, condition: { op: 'eq', path: 'flag', value: false }, triggerRule: 'any_success' },
      { edgeId: 'e4', sourceNodeId: source.nodeId, sourceOutput: 'output', targetNodeId: target.nodeId, targetInput: 'named.in', condition: { op: 'neq', path: 'count', value: 0 }, triggerRule: 'none_failed' },
      { edgeId: 'e5', sourceNodeId: source.nodeId, sourceOutput: 'payload.detail', targetNodeId: target.nodeId, targetInput: 'named.in', condition: { op: 'contains', path: 'items', value: null }, triggerRule: 'any_failed' },
      { edgeId: 'e6', sourceNodeId: target.nodeId, targetNodeId: finish.nodeId },
    ]);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('allows neutral real editor metadata, false transient, layout and exactly the default terminal primary', () => {
    const snap = graph();
    snap.defaultInputs = ' { } ';
    snap.inputSchema = ' {} ';
    snap.variables = [];
    snap.configurableSchema = {};
    snap.lifecycle = { transient: false };
    snap.metadata = { ...definitionMetadataFor(snap), name: 'stale system name is overwritten by composer' };
    ownedNode(snap, 'finish').outputRole = 'primary';
    const before = JSON.stringify(snap);
    expect(onlyChain(buildChainPackManifest(snap, versionOf)).dag.nodes).toHaveLength(3);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('uses serializer identity sanitization for first-dot endpoint safety', async () => {
    const snap = graph();
    ownedNode(snap, 'source').id = 'source.with.dot';
    for (const edge of snap.edges) if (edge.source === 'source') edge.source = 'source.with.dot';
    const bytes = JSON.stringify(buildChainPackManifest(snap, versionOf));
    const loaded = await loadChainExport(bytes, { topic: 'owned' });
    expect(loaded.errors).toEqual([]);
    const def = record(loaded.definition);
    const source = records(def.nodes).find(n => n.typeId === SOURCE);
    expect(source).toBeDefined();
    expect(records(def.edges).filter(e => e.sourceNodeId === source?.nodeId)).toHaveLength(5);
  });


  it('round-trips eq/neq/contains with undefined comparison operands through real export and loader', async () => {
    const snap = graph();
    ownedEdge(snap, 'false').condition = { op: 'eq', path: 'flag', value: undefined };
    ownedEdge(snap, 'zero').condition = { op: 'neq', path: 'count', value: undefined };
    ownedEdge(snap, 'null').condition = { op: 'contains', path: 'items', value: undefined };
    const before = JSON.stringify(snap);
    const manifest = buildChainPackManifest(snap, versionOf);
    const wireEdges = onlyChain(manifest).dag.edges;
    if (!wireEdges || wireEdges.length !== 6) throw new Error('Expected all six actual exported edges');
    const cases = [
      { path: 'flag', type: 'equals', op: 'eq' },
      { path: 'count', type: 'notEquals', op: 'neq' },
      { path: 'items', type: 'contains', op: 'contains' },
    ];
    for (const expected of cases) {
      const matching = wireEdges.filter(e => e.condition?.left === expected.path);
      const edge = matching[0];
      if (matching.length !== 1 || !edge) throw new Error('Expected unique portable comparison edge');
      expect(edge.condition).toEqual({ type: expected.type, left: expected.path });
      expect(edge.condition).not.toHaveProperty('right');
    }
    const bytes = JSON.stringify(manifest);
    const loaded = await loadChainExport(bytes, { topic: 'bound-topic' });
    expect(loaded.catalogDigest).toBe(catalogDigest);
    expect(loaded.manifestDigest).toBe(digest(bytes));
    expect(loaded.errors).toEqual([]);
    expect(record(record(loaded.entry).chain).chainId).toBe(onlyChain(manifest).chainId);
    const edges = records(record(loaded.definition).edges);
    expect(edges).toHaveLength(6);
    for (const expected of cases) {
      const matching = edges.filter(e => {
        const c = e.condition;
        return c !== null && typeof c === 'object' && !Array.isArray(c)
          && 'path' in c && c.path === expected.path;
      });
      const edge = matching[0];
      if (matching.length !== 1 || !edge) throw new Error('Expected unique actual expanded comparison edge');
      expect(edge.condition).toEqual({ op: expected.op, path: expected.path });
      expect(edge.condition).not.toHaveProperty('value');
    }
    expect(JSON.stringify(snap)).toBe(before);
  });

});

interface RefusalCase { name: string; field: string; change: (snap: SavedWorkflow) => void }
const unsupported: RefusalCase[] = [
  { name: 'nonempty defaults', field: 'workflow.defaultInputs', change: s => { s.defaultInputs = '{"private":"' + PRIVATE + '"}'; } },
  { name: 'invalid defaults draft', field: 'workflow.defaultInputs', change: s => { s.defaultInputs = '{'; } },
  ...['false', '0', 'null', '[]'].map(value => ({ name: 'scalar/array defaults ' + value, field: 'workflow.defaultInputs', change: (s: SavedWorkflow) => { s.defaultInputs = value; } })),
  { name: 'input schema', field: 'workflow.inputSchema', change: s => { s.inputSchema = '{"type":"object"}'; } },
  { name: 'invalid schema draft omitted by serializer', field: 'workflow.inputSchema', change: s => { s.inputSchema = '{'; } },
  ...[false, 0, null, ['authored']].map(value => ({ name: 'variable declaration ' + JSON.stringify(value), field: 'workflow.variables', change: (s: SavedWorkflow) => { s.variables = value; } })),
  ...[false, 0, null, { field: PRIVATE }].map(value => ({ name: 'configurable schema ' + JSON.stringify(value), field: 'workflow.configurableSchema', change: (s: SavedWorkflow) => { s.configurableSchema = value; } })),
  ...[false, 0, null].map(value => ({ name: 'business metadata ' + JSON.stringify(value), field: 'workflow.metadata', change: (s: SavedWorkflow) => { s.metadata = { business: value }; } })),
  { name: 'metadata sibling', field: 'workflow.metadata', change: s => { s.metadata = { customProperties: { foreign: PRIVATE } }; } },
  { name: 'transient lifecycle', field: 'workflow.lifecycle', change: s => { s.lifecycle = { transient: true }; } },
  { name: 'generated lifecycle', field: 'workflow.lifecycle', change: s => { s.lifecycle = { generatedBy: PRIVATE }; } },
  { name: 'nondefault primary', field: 'node.outputRole', change: s => { ownedNode(s, 'source').outputRole = 'primary'; } },
  { name: 'secondary role', field: 'node.outputRole', change: s => { ownedNode(s, 'finish').outputRole = 'secondary'; } },
  { name: 'inverse not implemented by exporter', field: 'node.compensation', change: s => { ownedNode(s, 'source').compensation = { nodeTypeId: SOURCE, inputMapping: { text: PRIVATE } }; } },
  { name: 'authored false irreversibility', field: 'node.irreversibleEffect', change: s => { ownedNode(s, 'source').irreversibleEffect = false; } },
  { name: 'agent binding', field: 'node.agent', change: s => { ownedNode(s, 'source').agent = { agentId: PRIVATE }; } },
  { name: 'runtime variable reference', field: 'node.variableRead', change: s => { ownedNode(s, 'source').inputs = { text: { type: 'variable', variableName: PRIVATE } }; } },
  { name: 'child workflow binding', field: 'node.childWorkflow', change: s => { ownedNode(s, 'source').config = { workflowId: PRIVATE }; } },
  { name: 'exists has no portable equivalent here', field: 'edge.condition', change: s => { ownedEdge(s, 'default').condition = { op: 'exists', path: PRIVATE }; } },
  { name: 'edge label', field: 'edge.label', change: s => { ownedEdge(s, 'default').label = PRIVATE; } },
  { name: 'empty named source', field: 'edge.endpoint', change: s => { ownedEdge(s, 'default').canonicalSourceOutput = ''; } },
  { name: 'non JSON config', field: 'node.payload', change: s => { ownedNode(s, 'source').config = { value: Number.NaN }; } },
  { name: 'unknown snapshot state', field: 'workflow.fields', change: s => { Object.assign(s, { futureAuthoredState: PRIVATE }); } },
];
describe('unsupported authored semantics refuse without mutation or private copy', () => {
  it.each(unsupported)('$name', ({ field, change }) => {
    expect(buildChainPackManifest(graph(), versionOf).chains).toHaveLength(1);
    const snap = graph();
    change(snap);
    refuse(snap, field);
  });
  it('distinguishes an actual unknown catalog version from a non-schema exact pin', () => {
    const snap = graph();
    ownedNode(snap, 'source').kind = UNKNOWN;
    expect(catalogEntryByTypeId(UNKNOWN)).toBeDefined();
    expect(versionOf(UNKNOWN)).toBeUndefined();
    expect(() => buildChainPackManifest(snap, versionOf)).toThrow(ChainExportVersionError);
    ownedNode(snap, 'source').kind = BAD;
    expect(versionOf(BAD)).toBe('1.0.0-beta');
    refuse(snap, 'node.version');
  });
  it.each(['en', 'es', 'fr', 'pt-BR'])('uses real localized trusted refusal copy in %s', async locale => {
    await setLocale(locale);
    await i18n.loadNamespaces('builder');
    const own: unknown = i18n.getResource(locale, 'builder', 'exportChainPackFidelity');
    if (typeof own !== 'string' || own.length === 0) throw new Error('Missing own-locale fidelity resource');
    const localized = i18n.t('builder:exportChainPackFidelity');
    expect(localized).toBe(own);
    expect(localized).not.toBe('exportChainPackFidelity');
    expect(localized).not.toBe('builder:exportChainPackFidelity');
    expect(localized.length).toBeGreaterThan(40);
    const snap = graph();
    snap.metadata = { private: PRIVATE };
    refuse(snap, 'workflow.metadata');
    await setLocale('en');
  });
});

describe('actual loader negative controls use the actual exported artifact', () => {
  it('refuses a missing dag with the schema-specific code', async () => {
    const raw = record(JSON.parse(JSON.stringify(buildChainPackManifest(graph(), versionOf))));
    const chain = rawChain(raw);
    delete chain.dag;
    const loaded = await loadChainExport(JSON.stringify(raw));
    expect(loaded.errors).toEqual([expect.objectContaining({ code: 'workflow_chain_pack_manifest_invalid' })]);
    expect(loaded.entry).toBeNull();
    expect(loaded.definition).toBeNull();
  });
  it('refuses a removed exact pin with the pin-specific code', async () => {
    const raw = record(JSON.parse(JSON.stringify(buildChainPackManifest(graph(), versionOf))));
    const nodes = records(record(rawChain(raw).dag).nodes);
    const source = nodes.find(n => n.id === 'source');
    if (!source || source.typeId !== SOURCE + '@1.2.3') throw new Error('Expected pinned source node before corrupting it');
    source.typeId = SOURCE;
    const loaded = await loadChainExport(JSON.stringify(raw));
    expect(loaded.errors).toEqual([expect.objectContaining({ code: 'workflow_chain_unpinned' })]);
    expect(loaded.entry).toBeNull();
    expect(loaded.definition).toBeNull();
  });
});
