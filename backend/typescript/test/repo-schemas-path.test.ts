/**
 * Pinning test for the `locateRepoSchemasV2Dir()` contract (was
 * `locateRepoSchemasDir()`; RFC 0266 moved the sentinel into `schemas/v2/` when the
 * flat v1 tree stopped being vendored).
 *
 * Regression guard for commit `d09d99c` (2026-05-23). The workflow-engine
 * is built in two layouts — source-tree (`src/host/<file>.ts`, six levels
 * deep from repo root) and esbuild-bundled (`lib/index.js`, four levels
 * deep). A `resolve(__dirname, '..' × 6, 'schemas')` pattern resolved
 * correctly under the source tree but overshot the repo root under the
 * bundled tree, crashing the host at first envelope-accept call.
 *
 * `host/_repoPath.ts:locateRepoSchemasV2Dir(fromDir, sentinelFile)` solves
 * the bug by walking parents until a sibling `schemas/` whose `v2/` holds the
 * sentinel is found, and returns that `schemas/v2/` directory. This test verifies the contract on the source-tree
 * layout (which is what we test under). A separate integration test
 * would be needed to verify the bundled-tree layout — out of scope for
 * a fast unit test.
 *
 * The test also drives `promptPackLoader.ts` (the RFC 0028 §B prompt-pack
 * loader, a consumer that hit this bug): it resolves its schemas dir through the
 * helper at module load but reads the schemas LAZILY, on the first prompt pack it
 * validates. So the case installs a real prompt pack from a temp root — a helper
 * that resolved the WRONG directory makes that read ENOENT, which a bare
 * `import` (this case until wave 114) could never see.
 *
 * Sabotages that red this file (8fw1g4 round 1 + 2, re-probed wave 114):
 * returning the walk's current dir instead of the `schemas/v2/` candidate, never
 * throwing at the filesystem root, ignoring the sentinel, and the loader going
 * back to a fixed `..`-count path instead of the helper.
 *
 * Round 2 cut "locates the same schemas/ directory regardless of sentinel
 * filename": no sabotage reds it without also redding case 1 (rp-return reds
 * case 1; the sentinel-blind sabotage is caught by the throw case).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasV2Dir } from '../src/host/_repoPath.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('host/_repoPath: locateRepoSchemasV2Dir', () => {
  it('locates the repo schemas/v2/ directory under the source-tree layout', () => {
    const dir = locateRepoSchemasV2Dir(__dirname, 'prompt-pack-manifest.schema.json');
    expect(basename(dir)).toBe('v2');
    expect(basename(dirname(dir))).toBe('schemas');
    expect(existsSync(join(dir, 'prompt-pack-manifest.schema.json'))).toBe(true);
    expect(locateRepoSchemasV2Dir(__dirname), 'the default sentinel finds the same tree').toBe(dir);
  });

  it('throws when the sentinel cannot be found anywhere in the parent chain', () => {
    expect(() =>
      locateRepoSchemasV2Dir(__dirname, 'this-schema-cannot-possibly-exist.schema.json'),
    ).toThrow(/walked from .* to filesystem root/);
  });

  it('promptPackLoader.ts validates a prompt pack against the schemas in the dir the helper found', async () => {
    const { loadPromptPacks } = await import('../src/host/promptPackLoader.js');
    const root = mkdtempSync(join(tmpdir(), 'repo-schemas-path-'));
    try {
      const writePack = (dir: string, manifest: Record<string, unknown>): void => {
        mkdirSync(join(root, dir));
        writeFileSync(join(root, dir, 'pack.json'), JSON.stringify(manifest));
      };
      writePack('good', {
        name: 'vendor.repo-schemas-path.good',
        version: '1.0.0',
        kind: 'prompt',
        engines: { openwop: '>=1.0.0' },
        prompts: [{ templateId: 'repo-schemas-path-probe', version: '1.0.0', kind: 'system', text: 'Probe.' }],
      });
      // Refused by that same schema (`prompts` minItems 1): the validator really ran.
      writePack('bad', { name: 'vendor.repo-schemas-path.bad', version: '1.0.0', kind: 'prompt', engines: { openwop: '>=1.0.0' }, prompts: [] });
      const results = loadPromptPacks({ roots: [root], requireSignature: false });
      expect(results.map((r) => [r.packName, r.templatesInstalled, r.signatureCheck])).toEqual([
        ['vendor.repo-schemas-path.good', 1, 'skipped'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
