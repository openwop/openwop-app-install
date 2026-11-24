/**
 * Test-only metadata → real catalog → exported bytes → real loader boundary.
 * Own temp root, no executable pack import, app boot, HTTP server or node run.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNodeCatalog } from '../../src/host/nodeCatalogBuilder.js';
import { loadWorkflowChainPacks, listChains, expandChain, _resetChainRegistryForTest } from '../../src/host/workflowChainPackLoader.js';

const SOURCE = 'feature.campaign-fixture.nodes.source';
const TARGET = 'feature.campaign-fixture.nodes.target';
const BAD = 'feature.campaign-fixture.nodes.prerelease';
const UNKNOWN = 'feature.campaign-fixture.nodes.unknown-version';
const TYPES = new Set([SOURCE, TARGET, BAD, UNKNOWN, 'core.noop']);
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function chainExportContract(request: Record<string, unknown>): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'builder-export-contract-'));
  const prior = process.env.OPENWOP_PACK_DIR;
  try {
    const nodesDir = join(dir, 'nodes');
    mkdirSync(nodesDir);
    const output = { type: 'object', required: ['payload.detail', 'out', 'output'], properties: {
      'payload.detail': { type: 'object' }, out: { type: 'object' }, output: { type: 'object' } } };
    const input = { type: 'object', required: ['input', 'named.in'], properties: {
      input: { type: 'object' }, 'named.in': { type: 'object' } } };
    writeFileSync(join(nodesDir, 'output.json'), JSON.stringify(output));
    writeFileSync(join(nodesDir, 'input.json'), JSON.stringify(input));
    writeFileSync(join(nodesDir, 'pack.json'), JSON.stringify({
      name: 'fixture.chain-export.nodes', version: '7.0.0', kind: 'node',
      nodes: [
        { typeId: SOURCE, version: '1.2.3', label: 'Fixture source', category: 'data', outputSchemaRef: 'output.json' },
        { typeId: TARGET, version: '2.3.4', label: 'Fixture target', category: 'data', inputSchemaRef: 'input.json', outputSchemaRef: 'output.json' },
        { typeId: 'core.noop', version: '1.4.2', label: 'Fixture noop', category: 'control' },
        { typeId: BAD, version: '1.0.0-beta', label: 'Fixture prerelease', category: 'data' },
        { typeId: UNKNOWN, label: 'Fixture unknown version', category: 'data' },
      ],
    }));
    process.env.OPENWOP_PACK_DIR = dir;
    const nodes = buildNodeCatalog().filter(n => TYPES.has(n.typeId)).sort((a, b) => a.typeId.localeCompare(b.typeId));
    // A failed real catalog setup must fail before the exporter is called.
    if (nodes.length !== TYPES.size || !nodes.every(n => n.source === 'pack' && n.packName === 'fixture.chain-export.nodes')) throw new Error('Fixture catalog was not admitted');
    const catalogDigest = digest(JSON.stringify(nodes));
    if (request.command === 'chain-export-catalog') return { nodes, digest: catalogDigest };
    if (request.command !== 'chain-export-load' || typeof request.manifestJson !== 'string' || !isRecord(request.params)) throw new Error('Invalid export contract request');
    const manifest: unknown = JSON.parse(request.manifestJson);
    if (!isRecord(manifest) || !Array.isArray(manifest.chains) || !isRecord(manifest.chains[0])
      || typeof manifest.chains[0].chainId !== 'string') throw new Error('Missing exported chain identity');
    const chainId = manifest.chains[0].chainId;
    const packs = join(dir, 'chains');
    const exported = join(packs, 'exported');
    mkdirSync(exported, { recursive: true });
    // These are the EXACT producer bytes, not a handwritten ideal manifest.
    writeFileSync(join(exported, 'pack.json'), request.manifestJson);
    _resetChainRegistryForTest();
    const loaded = loadWorkflowChainPacks({ roots: [packs] });
    const entry = listChains().find(c => c.chain.chainId === chainId);
    const known = new Set(nodes.map(n => n.typeId));
    const definition = entry ? expandChain(entry.chain, {
      params: request.params, isTypeIdKnown: typeId => known.has(typeId),
    }) : null;
    return { catalogDigest, manifestDigest: digest(request.manifestJson),
      errors: loaded.errors ?? [], entry: entry ?? null, definition };
  } finally {
    if (prior === undefined) delete process.env.OPENWOP_PACK_DIR;
    else process.env.OPENWOP_PACK_DIR = prior;
    _resetChainRegistryForTest();
    rmSync(dir, { recursive: true, force: true });
  }
}
