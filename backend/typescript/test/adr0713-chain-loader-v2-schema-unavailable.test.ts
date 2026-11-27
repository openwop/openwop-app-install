/**
 * ADR 0713 / WHD-15, RFC 0266 — a host that cannot compile the v2 chain-pack
 * schema fails CLOSED, per pack, and does not throw.
 *
 * The v2 chain schema `$ref`s a sibling (`ids.schema.json`), so a deploy carrying
 * only part of `schemas/v2/` (or a sibling renamed by a corpus bump) leaves the
 * loader with a schema it cannot compile. Two ways to get that wrong:
 *
 *   - THROW — `loadWorkflowChainPacks` "never throws on a bad pack — boot must not
 *     abort", and an uncompilable schema is not even a bad pack;
 *   - fall back to the frozen v1 schema — which RFC 0266 removed from this host,
 *     and which judged only manifests that could never register anyway.
 *
 * CORRECTED (RFC 0266): this file used to pin that the UNSIGNED pack still loaded
 * through the v1 route. That route is gone — every manifest is judged by v2 — so
 * the unsigned pack is now refused by name with the same code. That is the
 * intended fail-closed shape, not a regression.
 *
 * The v2 dir is substituted at the module seam the loader resolves it through,
 * so the real code path runs against a real directory that simply lacks
 * `ids.schema.json`.
 *
 * Tracker TST-BGF-18. Red when the loader throws, or loads a pack it had no
 * schema to judge.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHAIN_SCHEMA = 'workflow-chain-pack-manifest.schema.json';

// Hoisted: `vi.mock` factories run before this module's imports resolve, so the
// directory the mock hands out has to exist by then.
const seam = vi.hoisted(() => ({ schemasDir: '' }));
const CHAIN_SCHEMA_SENTINEL = vi.hoisted(() => 'workflow-chain-pack-manifest.schema.json');

vi.mock('../src/host/_repoPath.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/_repoPath.js')>();
  const { mkdtempSync: mkdtemp, mkdirSync: mkdir, cpSync: cp } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { tmpdir: tmp } = await import('node:os');
  const realDir = real.locateRepoSchemasV2Dir(import.meta.dirname, CHAIN_SCHEMA_SENTINEL);
  // A `schemas/v2/` holding the chain schema — but NOT the `ids.schema.json` it
  // `$ref`s, so it cannot compile.
  const partial = j(mkdtemp(j(tmp(), 'whd15-schemas-')), 'schemas', 'v2');
  mkdir(partial, { recursive: true });
  cp(j(realDir, CHAIN_SCHEMA_SENTINEL), j(partial, CHAIN_SCHEMA_SENTINEL));
  seam.schemasDir = partial;
  return {
    ...real,
    locateRepoSchemasV2Dir: (fromDir: string, sentinel?: string): string =>
      sentinel === CHAIN_SCHEMA_SENTINEL ? partial : real.locateRepoSchemasV2Dir(fromDir, sentinel),
  };
});

const { loadWorkflowChainPacks, getChain, _resetChainRegistryForTest } = await import('../src/host/workflowChainPackLoader.js');
const { __setUnpinnedChainPackWaiversForTests } = await import('../src/host/unpinnedChainPackAllowlist.js');

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
  // ADR 0766 — this file's subject is schema availability, not pins; the
  // unpinned fixtures are waived so only the schema can refuse them.
  __setUnpinnedChainPackWaiversForTests(['core.openwop.workflows.whd15-v2', 'core.openwop.workflows.whd15-unsigned']);
  _resetChainRegistryForTest();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (seam.schemasDir) rmSync(join(seam.schemasDir, '..', '..'), { recursive: true, force: true });
  _resetChainRegistryForTest();
  __setUnpinnedChainPackWaiversForTests(null);
});

describe('WHD-15 — the v2 chain-pack schema cannot be compiled', () => {
  it('the substituted v2 dir really holds the chain schema and really lacks its sibling', () => {
    // The premise of the fixture, not of the seam. Whether the loader actually
    // READS it is what the next test shows — against the real `schemas/v2/`, the
    // schema compiles and both packs load, so `schema_unavailable` cannot appear.
    expect(seam.schemasDir).not.toBe('');
    expect(existsSync(join(seam.schemasDir, CHAIN_SCHEMA))).toBe(true);
    expect(existsSync(join(seam.schemasDir, 'ids.schema.json'))).toBe(false);
  });

  it('refuses EVERY pack by name with a schema-unavailable code — it does not throw, and loads nothing', () => {
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    for (const pack of ['v2-signed', 'unsigned']) {
      const refused = errors.find((e) => e.pack === pack);
      expect(refused?.code, JSON.stringify(errors)).toBe('workflow_chain_pack_schema_unavailable');
      expect(refused?.message).toContain('v2');
    }
    expect(getChain('whd15.v2-signed'), 'a pack loaded with no schema to judge it').toBeNull();
    expect(getChain('whd15.unsigned'), 'a pack loaded with no schema to judge it — something fell back to v1').toBeNull();
  });
});
