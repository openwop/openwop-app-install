/**
 * ADR 0555 P0 — the break-glass must not become the default.
 *
 * `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED=true` permits an untrusted pack to
 * dispatch without reclassifying it. That is a deliberate escape hatch for a
 * developer or an operator mid-incident, and it is fail-OPEN, so the only thing
 * keeping it honest is that nothing ships with it set.
 *
 * Two ways it silently becomes the default, both seen elsewhere in this repo:
 *   - someone adds it to the Dockerfile / a deploy env file "so local works",
 *     and every deployment inherits it;
 *   - a test sets it and does not restore it, so later files in the same vitest
 *     worker run with the policy disabled and their assertions stop meaning
 *     anything (the exact shape `test/setup/isolatePackDir.ts` was written to
 *     catch for OPENWOP_PACK_DIR).
 *
 * This pins the first. The second is covered by each suite restoring the var.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoDir } from '../src/host/_repoPath.js';

const FLAG = 'OPENWOP_PACK_TRUST_ALLOW_UNSIGNED';

/** Config that ships or that an operator copies verbatim. */
const SHIPPED_CONFIG = [
  'Dockerfile',
  'docker-compose.yml',
  'scripts/deploy.env.example',
  'backend/typescript/.env.example',
  'frontend/react/.env.production',
  '.github/workflows/ci.yml',
];

describe('ADR 0555 P0 — the trust break-glass is not shipped enabled', () => {
  const repoRoot = dirname(locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'packs', '.steward-manifest.json'));

  it('no shipped config file sets the flag', () => {
    const offenders: string[] = [];
    for (const rel of SHIPPED_CONFIG) {
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf-8');
      // Any mention that ASSIGNS it. A comment explaining it is fine.
      for (const line of text.split('\n')) {
        const stripped = line.trim();
        if (stripped.startsWith('#') || stripped.startsWith('//')) continue;
        if (new RegExp(`${FLAG}\\s*[=:]`).test(stripped)) offenders.push(`${rel}: ${stripped}`);
      }
    }
    expect(offenders, `${FLAG} must never be set in shipped config — it disables the ADR 0555 fail-closed policy`).toEqual([]);
  });

  it('the flag is OFF in this process, so the suite exercises the real policy', () => {
    // If a previous test file leaked it, every trust assertion after that point
    // would pass for the wrong reason.
    expect(process.env[FLAG]).not.toBe('true');
  });

  it('the steward manifest is present, so the default-ON policy is satisfiable', () => {
    // The policy is only default-ON-able because vendored packs classify
    // steward. Without the manifest the honest options are "fail closed and
    // break everything" or "turn the policy off" — this asserts we are in
    // neither situation.
    const manifestPath = join(repoRoot, 'packs', '.steward-manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { packs: Record<string, unknown> };
    expect(Object.keys(parsed.packs).length).toBeGreaterThan(100);
  });
});
