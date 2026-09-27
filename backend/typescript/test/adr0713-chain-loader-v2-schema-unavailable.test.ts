/**
 * ADR 0713 / WHD-15 — a host that cannot compile the v2 chain-pack schema fails
 * CLOSED for v2-shaped packs, and only for them.
 *
 * Routing v2-signed manifests to `schemas/v2/` gave the chain loader a second
 * schema to depend on, and that one `$ref`s a sibling (`ids.schema.json`). So there
 * is now a state the loader could not be in before: the root schema reads fine and
 * the v2 one does not (a deploy carrying only part of `schemas/`, a sibling renamed
 * by a corpus bump). Three ways to get that wrong, all plausible:
 *
 *   - THROW — `loadWorkflowChainPacks` "never throws on a bad pack — boot must not
 *     abort", and an uncompilable schema is not even a bad pack;
 *   - fall back to strip-the-block-and-ask-v1 — the workaround WHD-15 deleted,
 *     reintroduced as an error path where nobody would look for it;
 *   - refuse EVERYTHING — taking the in-tree, unsigned packs down with a schema
 *     they are never validated against.
 *
 * The schemas dir is substituted at the module seam the loader resolves it
 * through, so the real code path runs against a real directory that simply lacks
 * `v2/ids.schema.json`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHAIN_SCHEMA = 'workflow-chain-pack-manifest.schema.json';

// Hoisted: `vi.mock` factories run before this module's imports resolve, so the
// directory the mock hands out has to exist by then.
const seam = vi.hoisted(() => ({ schemasDir: '' }));

vi.mock('../src/host/_repoPath.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/_repoPath.js')>();
  const { mkdtempSync: mkdtemp, mkdirSync: mkdir, cpSync: cp } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { tmpdir: tmp } = await import('node:os');
  const realDir = real.locateRepoSchemasDir(import.meta.dirname, 'workflow-chain-pack-manifest.schema.json');
  // A `schemas/` holding the v1 chain schema and the v2 chain schema — but NOT the
  // `ids.schema.json` the v2 one `$ref`s. v1 compiles; v2 cannot.
  const partial = j(mkdtemp(j(tmp(), 'whd15-schemas-')), 'schemas');
  mkdir(j(partial, 'v2'), { recursive: true });
  cp(j(realDir, 'workflow-chain-pack-manifest.schema.json'), j(partial, 'workflow-chain-pack-manifest.schema.json'));
  cp(j(realDir, 'v2', 'workflow-chain-pack-manifest.schema.json'), j(partial, 'v2', 'workflow-chain-pack-manifest.schema.json'));
  seam.schemasDir = partial;
  return {
    ...real,
    locateRepoSchemasDir: (fromDir: string, sentinel: string): string =>
      sentinel === 'workflow-chain-pack-manifest.schema.json' ? partial : real.locateRepoSchemasDir(fromDir, sentinel),
  };
});

const { loadWorkflowChainPacks, getChain, _resetChainRegistryForTest } = await import('../src/host/workflowChainPackLoader.js');

function chainPack(name: string, chainId: string, signing: unknown): Record<string, unknown> {
  return {
    name, version: '1.0.0', kind: 'workflow-chain', description: 'fixture',
    engines: { openwop: '>=1.0.0 <3.0.0' },
    ...(signing === undefined ? {} : { signing }),
    chains: [{
      chainId, version: '1.0.0', label: 'Fixture', description: 'fixture',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      dag: { nodes: [{ id: 'noop', typeId: 'core.noop' }] },
    }],
  };
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'whd15-unavailable-'));
  const write = (dir: string, manifest: Record<string, unknown>) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'pack.json'), JSON.stringify(manifest));
  };
  write('v2-signed', chainPack('core.openwop.workflows.whd15-v2', 'whd15.v2-signed', { keyId: 'openwop-team-1', scheme: 'ed25519-canonical-json' }));
  write('unsigned', chainPack('core.openwop.workflows.whd15-unsigned', 'whd15.unsigned', undefined));
  _resetChainRegistryForTest();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (seam.schemasDir) rmSync(join(seam.schemasDir, '..'), { recursive: true, force: true });
  _resetChainRegistryForTest();
});

describe('WHD-15 — the v2 chain-pack schema cannot be compiled', () => {
  it('the substituted schemas dir really holds both chain schemas and really lacks the v2 sibling', () => {
    // The premise of the fixture, not of the seam: that the directory is the
    // half-vendored one described above. Whether the loader actually READS it is
    // what the next test shows — against the real `schemas/`, v2 compiles and the
    // `v2-signed` pack simply loads, so `schema_unavailable` cannot appear there.
    expect(seam.schemasDir).not.toBe('');
    expect(existsSync(join(seam.schemasDir, CHAIN_SCHEMA))).toBe(true);
    expect(existsSync(join(seam.schemasDir, 'v2', CHAIN_SCHEMA))).toBe(true);
    expect(existsSync(join(seam.schemasDir, 'v2', 'ids.schema.json'))).toBe(false);
  });

  it('refuses the v2-signed pack BY NAME with a schema-unavailable code — it does not throw, and does not fall back to v1', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    const refused = errors.find((e) => e.pack === 'v2-signed');
    expect(refused?.code, JSON.stringify(errors)).toBe('workflow_chain_pack_schema_unavailable');
    expect(refused?.message).toContain('v2');
    expect(getChain('whd15.v2-signed'), 'a v2-signed pack loaded with no v2 schema to judge it — something fell back to v1').toBeNull();
  });

  it('still loads the unsigned pack — the v1 route does not depend on schemas/v2/', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    expect(errors.find((e) => e.pack === 'unsigned'), JSON.stringify(errors)).toBeUndefined();
    expect(getChain('whd15.unsigned')?.packName).toBe('core.openwop.workflows.whd15-unsigned');
  });
});
