/**
 * ADR 0917 (Book AI P12 + P14).
 *
 * P14 — the chain expansion id folds NESTED param values. Red under the old
 * array-replacer canonical form (nested objects serialized as `{}`), and red if
 * flat params stop producing the same id as before (existing ids must not move).
 *
 * P12 — a node's declared feature surface appears in the catalog as
 * `host.sample.<id>`; missing when the host does not compose the feature, and on
 * the per-tenant catalog when the tenant has it off.
 *
 * Tracker TST-BJV. Red when (probe-witnessed, w65): the id folds params with the old
 * array replacer (nested values collapse); nested keys are not sorted (and the flat
 * id moves); a tenant-off feature surface is not reported missing.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import { nodeCatalogForTenant, type CatalogNode } from '../src/host/nodeCatalogBuilder.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';

// Toggle resolution reads host-ext persistence, which `createApp` installs.
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const chain: WorkflowChain = {
  chainId: 'test.adr0917',
  version: '1.0.0',
  label: 'T',
  description: 't',
  parameters: { type: 'object', properties: { target: { type: 'object' }, topic: { type: 'string' }, tags: { type: 'array' } } },
  dag: { nodes: [{ id: 'gen', typeId: 'core.noop', config: { note: 'x' } }] },
};
const nodeIdOf = (params: Record<string, unknown>): string => expandChain(chain, { params }).nodes[0]!.nodeId;

describe('ADR 0917 P14 — nested params fold into the expansion id', () => {
  it('two expansions differing only in a nested value get different ids', () => {
    expect(nodeIdOf({ target: { chapter: 3 } })).not.toBe(nodeIdOf({ target: { chapter: 9 } }));
    expect(nodeIdOf({ tags: [{ a: 1 }] })).not.toBe(nodeIdOf({ tags: [{ a: 2 }] }));
  });

  it('key order inside a nested value does not matter', () => {
    expect(nodeIdOf({ target: { a: 1, b: 2 } })).toBe(nodeIdOf({ target: { b: 2, a: 1 } }));
  });

  it('FLAT params keep exactly the id the old formula produced (no existing id moves)', () => {
    const params = { topic: 'AI ops', tags: ['x', 'y'] };
    const old = createHash('sha256').update(`${chain.chainId}@${chain.version}:${JSON.stringify(params, Object.keys(params).sort())}`).digest('hex').slice(0, 12);
    expect(nodeIdOf(params)).toContain(old);
  });
});

describe('ADR 0917 P12 — feature surfaces in the catalog', () => {
  const node = (over: Partial<CatalogNode>): CatalogNode => ({
    typeId: 'feature.adr0917.nodes.x', label: 'x', description: '', category: 'flow', source: 'pack',
    requiresHostSurfaces: ['host.sample.adr0917-feat'], missingHostSurfaces: [], requiresFeatureSurfaces: ['adr0917-feat'], ...over,
  });

  it('a tenant with the feature OFF sees the node as missing host.sample.<id>; others are untouched', async () => {
    registerToggleDefault({ id: 'adr0917-feat', status: 'off', bucketUnit: 'tenant', salt: 'adr0917-feat' });
    const [n, plain] = await nodeCatalogForTenant('t-0917', [node({}), node({ typeId: 'core.noop', requiresFeatureSurfaces: undefined, requiresHostSurfaces: [] })]);
    expect(n!.missingHostSurfaces).toEqual(['host.sample.adr0917-feat']);
    expect(plain!.missingHostSurfaces).toEqual([]);
  });

  it('a tenant with the feature ON sees it runnable', async () => {
    registerToggleDefault({ id: 'adr0917-on', status: 'on', bucketUnit: 'tenant', salt: 'adr0917-on' });
    const [n] = await nodeCatalogForTenant('t-0917', [node({ requiresFeatureSurfaces: ['adr0917-on'], requiresHostSurfaces: ['host.sample.adr0917-on'] })]);
    expect(n!.missingHostSurfaces).toEqual([]);
  });
});
