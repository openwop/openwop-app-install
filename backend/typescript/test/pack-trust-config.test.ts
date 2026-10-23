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

/** Config that ships or that an operator copies verbatim, and that exists in
 *  EVERY checkout (this repo and the white-label zip). A missing file here is a
 *  rename, which would silently drop it from the scan, so it is a red, not a
 *  skip. (`docker-compose.yml` used to be listed; no such file exists here.) */
const SHIPPED_CONFIG = [
  'Dockerfile',
  'scripts/deploy.env.example',
  'backend/typescript/.env.example',
];

/** Config present in this repo but STRIPPED from the white-label zip by
 *  `scripts/build-whitelabel-zip.sh` (real `.env*` files and `.github/`), so it
 *  is scanned when present and skipped when absent. */
const STEWARD_ONLY_CONFIG = [
  'frontend/react/.env.production',
  '.github/workflows/ci.yml',
];

describe('ADR 0555 P0 — the trust break-glass is not shipped enabled', () => {
  const repoRoot = dirname(locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'packs', '.steward-manifest.json'));

  it('no shipped config file sets the flag', () => {
    const missing = SHIPPED_CONFIG.filter((rel) => !existsSync(join(repoRoot, rel)));
    expect(missing, 'a listed config file was renamed or removed: update SHIPPED_CONFIG').toEqual([]);
    const offenders: string[] = [];
    for (const rel of [...SHIPPED_CONFIG, ...STEWARD_ONLY_CONFIG]) {
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

  it('tripwire: the flag has not leaked into this worker from an earlier test file', () => {
    // What this CAN see: a file that ran earlier in the same vitest worker and
    // set the flag without restoring it (every trust assertion after that point
    // would pass for the wrong reason). What it CANNOT see: a leak in another
    // worker, or one by a file scheduled after this one. It is a tripwire, not
    // a proof that every file restores the var.
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
    // Floor = the measured count, 213 attested packs at 7321e3612 (2026-10-18).
    expect(Object.keys(parsed.packs).length).toBeGreaterThanOrEqual(213);
  });
});
