/**
 * Pinning test for the `locateRepoSchemasDir()` contract.
 *
 * Regression guard for commit `d09d99c` (2026-05-23). The workflow-engine
 * is built in two layouts — source-tree (`src/host/<file>.ts`, six levels
 * deep from repo root) and esbuild-bundled (`lib/index.js`, four levels
 * deep). A `resolve(__dirname, '..' × 6, 'schemas')` pattern resolved
 * correctly under the source tree but overshot the repo root under the
 * bundled tree, crashing the host at first envelope-accept call.
 *
 * `host/_repoPath.ts:locateRepoSchemasDir(fromDir, sentinelFile)` solves
 * the bug by walking parents until a sibling `schemas/` containing the
 * sentinel is found. This test verifies the contract on the source-tree
 * layout (which is what we test under). A separate integration test
 * would be needed to verify the bundled-tree layout — out of scope for
 * a fast unit test.
 *
 * The test also asserts that `envelopeAcceptor.ts` and `promptPackLoader.ts`
 * — the two consumers that hit this bug — successfully locate the
 * schemas directory via the helper. envelopeAcceptor reads its schemas LAZILY
 * (only the directory is resolved at module load), so a bare `import` could not
 * see a helper that returned the WRONG directory (round-1 probe rp-return left
 * that case green); the case now reads a schema through the acceptor's own
 * loader.
 *
 * Sabotages that red this file (8fw1g4 round 1 + 2): returning the walk's
 * current dir instead of the `schemas/` candidate, never throwing at the
 * filesystem root, and ignoring the sentinel.
 *
 * Round 2 cut "locates the same schemas/ directory regardless of sentinel
 * filename": no sabotage reds it without also redding case 1 (rp-return reds
 * case 1; the sentinel-blind sabotage is caught by the throw case).
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasDir } from '../src/host/_repoPath.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('host/_repoPath: locateRepoSchemasDir', () => {
  it('locates the repo schemas/ directory under the source-tree layout', () => {
    const dir = locateRepoSchemasDir(__dirname, 'ai-envelope.schema.json');
    expect(basename(dir)).toBe('schemas');
    expect(existsSync(join(dir, 'ai-envelope.schema.json'))).toBe(true);
  });

  it('throws when the sentinel cannot be found anywhere in the parent chain', () => {
    expect(() =>
      locateRepoSchemasDir(__dirname, 'this-schema-cannot-possibly-exist.schema.json'),
    ).toThrow(/walked from .* to filesystem root/);
  });

  it('envelopeAcceptor.ts resolves its schemas/ dir via the helper and reads a schema from it', async () => {
    // The `import` runs envelopeAcceptor.ts's top-level
    // `locateRepoSchemasDir(__dirname, 'ai-envelope.schema.json')` (a walk
    // failure throws here). The schemas themselves are read lazily, so read one
    // through the acceptor's own loader: a WRONG directory returns null.
    const mod = await import('../src/host/envelopeAcceptor.js');
    const schema = mod.loadEnvelopePayloadSchema('error');
    expect(schema, 'the acceptor resolved a schemas/ dir it cannot read from').not.toBeNull();
    expect(typeof schema?.['$schema']).toBe('string');
  });

  it('promptPackLoader.ts loads its schema at module-load via the helper (no ENOENT)', async () => {
    const mod = await import('../src/host/promptPackLoader.js');
    expect(typeof mod.loadPromptPacks).toBe('function');
  });
});
